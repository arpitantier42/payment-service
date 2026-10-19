import { randomUUID } from 'node:crypto';
import express from 'express';
import { bearerAuth } from '../shared/auth.js';
import { errorHandler, sendError, UUID_RE } from '../shared/errors.js';
import { DEFAULT_RETRY_POLICY, withRetry } from '../shared/retry.js';
import { parseWebhookPayload, verifyWebhookSignature } from './gateway.js';
import { createPaymentOutcomes } from './paymentOutcome.js';
import { isUniqueViolation } from './paymentRepository.js';
import { PAYABLE_ORDER_STATUSES, PaymentStatus } from './paymentStatus.js';
import { validateInitiatePayment } from './validation.js';

const ACTOR = 'system';
const WEBHOOK_ACTOR = 'gateway_webhook';
/** Webhook outcomes that mean "the details did not match a stored payment" (422, also on redelivery). */
const DETAILS_REJECTIONS = ['unknown_payment', 'details_mismatch'];

/** API shape: the `Payment` plus the checkout details the client redirects to (null until created). */
const present = ({ payment, checkoutSession }) => ({ ...payment, checkout_session: checkoutSession });

/**
 * Builds the payment-service HTTP app.
 * @param {{
 *   payments: ReturnType<import('./paymentRepository.js').createPaymentRepository>,
 *   orders: {                                                               // order-service client
 *     getOrder(orderId: string): Promise<object|null>,
 *     updateOrderStatus(orderId: string, status: string): Promise<{ outcome: string }>,
 *   },
 *   gateway: { name: string, createCheckoutSession(args: object): Promise<object> },
 *   secrets: {
 *     getGatewayCredentials(): Promise<{ keyId: string, keySecret: string }>,
 *     getWebhookSecret(): Promise<string>,
 *   },
 *   bearerTokens: string[],
 *   checkoutTtlMs?: number,          // bounded checkout window (checkout_sessions.expires_at)
 *   gatewayRetryPolicy?: { attempts?: number, baseDelayMs?: number, factor?: number },
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => Date,
 * }} deps
 */
export function createApp({
  payments,
  orders,
  gateway,
  secrets,
  bearerTokens,
  checkoutTtlMs = 15 * 60 * 1000,
  gatewayRetryPolicy = DEFAULT_RETRY_POLICY,
  sleep,
  now = () => new Date(),
}) {
  const app = express();
  app.disable('x-powered-by');
  // The raw bytes are kept for webhook signature verification (the HMAC covers the exact body).
  app.use(
    express.json({
      limit: '100kb',
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  const outcomes = createPaymentOutcomes({ payments, orders, now });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  const requireBearer = bearerAuth(bearerTokens);

  // REQ-011: payment details are per-caller and change over time; shared caches must not keep them.
  app.use('/payments', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  /**
   * Steps 4-6 of OP-004: fetch credentials (decrypted per call, never stored), create the checkout
   * session with retries, store it. Returns `{ payment, checkoutSession }`, or null when the gateway
   * failed; the failure is always written to the audit log so the payment is never left silently
   * unrecorded. An uncertain failure (timeout, 5xx) leaves the payment INITIATED for
   * reconciliation / a same-key retry; a definitive rejection (4xx) marks it FAILED.
   */
  async function openCheckout(payment) {
    const expiresAt = new Date(now().getTime() + checkoutTtlMs);
    try {
      const credentials = await secrets.getGatewayCredentials();
      const session = await withRetry(
        () => gateway.createCheckoutSession({ credentials, payment, expiresAt }),
        gatewayRetryPolicy,
        sleep ? { sleep } : undefined,
      );
      return await payments.recordCheckoutSession({ paymentId: payment.id, ...session, expiresAt, actor: ACTOR, now: now() });
    } catch (err) {
      const metadata = {
        error: err?.message ?? String(err),
        attempts: err?.attempts ?? 1,
        retryable: Boolean(err?.retryable),
        gateway_status: err?.status ?? null,
      };
      const definitive = err?.status >= 400 && err?.status < 500 && err.status !== 429;
      if (definitive && payment.status === PaymentStatus.INITIATED) {
        const failed = await payments.updateStatus({
          id: payment.id,
          from: PaymentStatus.INITIATED,
          to: PaymentStatus.FAILED,
          eventType: 'GATEWAY_REJECTED',
          actor: ACTOR,
          metadata,
          now: now(),
        });
        if (failed) return null;
      }
      await payments.recordEvent({
        paymentId: payment.id,
        eventType: 'GATEWAY_CALL_FAILED',
        status: payment.status,
        actor: ACTOR,
        metadata,
        now: now(),
      });
      console.error(`payment ${payment.id}: checkout creation failed: ${metadata.error}`);
      return null;
    }
  }

  const gatewayFailed = (res) =>
    sendError(
      res,
      502,
      'gateway_unavailable',
      'the payment gateway call failed or timed out; retry with the same Idempotency-Key',
    );

  /** A request whose Idempotency-Key was seen before: return (or finish) the existing payment. */
  async function replay(res, existing, value) {
    const { payment } = existing;
    const mismatched = [
      ['order_id', payment.order_id, value.orderId],
      ['amount', payment.amount, value.amount],
      ['currency', payment.currency, value.currency],
      ['payment_method', payment.payment_method, value.paymentMethod],
    ].filter(([, stored, sent]) => stored !== sent);
    if (mismatched.length) {
      return sendError(
        res,
        422,
        'idempotency_key_reused',
        'the Idempotency-Key was already used for a different payment request',
        mismatched.map(([field]) => ({ field, message: 'differs from the original request with this key' })),
      );
    }
    // The earlier attempt recorded the payment but did not get checkout details (gateway failure):
    // resume it. The gateway call is keyed by the payment id, so this cannot open a second charge.
    if (!existing.checkoutSession && payment.status === PaymentStatus.INITIATED) {
      const resumed = await openCheckout(payment);
      if (!resumed) return gatewayFailed(res);
      return res.status(200).json(present(resumed));
    }
    return res.status(200).json(present(existing));
  }

  // OP-004 initiatePayment · REQ-002, REQ-003, REQ-004, REQ-005, REQ-010, REQ-011
  app.post('/payments', requireBearer, async (req, res) => {
    // REQ-002: order id, amount, currency, payment method and Idempotency-Key are required.
    const { value, errors } = validateInitiatePayment(req.body, req.get('idempotency-key'));
    if (errors) {
      return sendError(res, 400, 'validation_failed', 'required payment fields are missing or invalid', errors);
    }

    // REQ-010: a repeated Idempotency-Key returns the existing payment instead of a new one.
    const existing = await payments.findByIdempotencyKey(value.idempotencyKey);
    if (existing) return replay(res, existing, value);

    // Step 1 (REQ-002): fetch the trusted order from order-service.
    let order;
    try {
      order = await orders.getOrder(value.orderId);
    } catch (err) {
      console.error(`order-service lookup failed: ${err.message}`);
      return sendError(res, 503, 'order_service_unavailable', 'the order could not be verified; try again later');
    }
    if (!order) {
      return sendError(res, 404, 'order_not_found', 'the order id does not reference an existing order');
    }
    if (!PAYABLE_ORDER_STATUSES.includes(order.status)) {
      return sendError(res, 409, 'order_not_payable', `an order in status ${order.status} cannot be paid`, [
        { field: 'order_id', message: `order status is ${order.status}` },
      ]);
    }

    // Step 2 (REQ-003): the client's amount and currency must match the order's trusted figures.
    const mismatches = [];
    if (order.total_amount !== value.amount) {
      mismatches.push({ field: 'amount', message: 'does not match the order payable amount' });
    }
    if (order.currency !== value.currency) {
      mismatches.push({ field: 'currency', message: 'does not match the order currency' });
    }
    if (mismatches.length) {
      return sendError(res, 422, 'amount_mismatch', "the payment does not match the order's payable amount", mismatches);
    }

    // Step 3 (REQ-004): insert the payment as INITIATED with its PAYMENT_INITIATED audit entry.
    let payment;
    try {
      payment = await payments.createPayment({
        payment: {
          id: randomUUID(),
          orderId: value.orderId,
          idempotencyKey: value.idempotencyKey,
          amount: order.total_amount,
          currency: order.currency,
          paymentMethod: value.paymentMethod,
          gatewayName: gateway.name,
          status: PaymentStatus.INITIATED,
        },
        actor: ACTOR,
        metadata: { order_status: order.status },
        now: now(),
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost a race with a concurrent request using the same key: that one owns the payment.
      const raced = await payments.findByIdempotencyKey(value.idempotencyKey);
      if (raced) return replay(res, raced, value);
      // RSK-003: the order already has an INITIATED/PENDING payment under another key.
      return sendError(
        res,
        409,
        'payment_in_progress',
        'the order already has a payment in progress; reuse its Idempotency-Key or wait for it to resolve',
        [{ field: 'order_id', message: 'has an INITIATED or PENDING payment' }],
      );
    }

    // Steps 4-6 (REQ-011, REQ-005): credentials, gateway checkout session, store it.
    const result = await openCheckout(payment);
    if (!result) return gatewayFailed(res);
    res.status(201).location(`/payments/${payment.id}`).json(present(result));
  });

  // OP-005 getPayment · REQ-011
  // Bearer-authenticated (401 before any lookup); reads payment-db only, never the gateway or
  // order-service, so it reports the stored status (webhook/reconciliation keep it current).
  app.get('/payments/:paymentId', requireBearer, async (req, res) => {
    const { paymentId } = req.params;
    // A malformed id cannot reference an existing payment.
    const found = UUID_RE.test(paymentId) ? await payments.findById(paymentId.toLowerCase()) : null;
    if (!found) {
      return sendError(res, 404, 'payment_not_found', 'no payment exists with the given id');
    }
    res.json(present(found));
  });

  /** Final answer for a webhook event that was already applied or rejected (also on redelivery). */
  function webhookAnswer(res, event, paymentStatus) {
    if (event.status === 'REJECTED' && DETAILS_REJECTIONS.includes(event.outcome)) {
      return sendError(
        res,
        422,
        event.outcome === 'unknown_payment' ? 'unknown_payment' : 'transaction_mismatch',
        'the transaction details do not match a stored payment record',
      );
    }
    return res.status(200).json({ ...event, payment_status: paymentStatus ?? null });
  }

  /** Steps 2 (details) to 6 of OP-006 for a recorded, signature-verified event. */
  async function processWebhook(res, event, value) {
    const reject = async (outcome, paymentId = null) =>
      payments.updateWebhookEvent({ id: event.id, status: 'REJECTED', paymentId, outcome, processedAt: now() });

    // Step 2 (REQ-007): the event must reference a stored payment with the same transaction details.
    let found = null;
    if (value.paymentId) {
      found = UUID_RE.test(value.paymentId) ? await payments.findById(value.paymentId.toLowerCase()) : null;
    } else {
      found = await payments.findByGatewayReference(value.gatewayReference);
    }
    if (!found) {
      const rejected = await reject('unknown_payment');
      console.warn(`webhook ${value.gatewayEventId}: no stored payment matches it`);
      return webhookAnswer(res, rejected);
    }
    const { payment } = found;
    const mismatches = [];
    if (value.gatewayReference && payment.gateway_reference && value.gatewayReference !== payment.gateway_reference) {
      mismatches.push({ field: 'gateway_reference', message: 'does not match the stored gateway reference' });
    }
    if (value.amount !== payment.amount) mismatches.push({ field: 'amount', message: 'does not match the payment amount' });
    if (value.currency !== payment.currency) {
      mismatches.push({ field: 'currency', message: 'does not match the payment currency' });
    }
    const metadata = {
      webhook_event_id: event.id,
      gateway_event_id: value.gatewayEventId,
      gateway_status: value.gatewayStatus,
      gateway_reference: value.gatewayReference ?? payment.gateway_reference,
    };
    if (mismatches.length) {
      await reject('details_mismatch', payment.id);
      // Security-relevant (signed but inconsistent): keep it on the payment's audit trail.
      await payments.recordEvent({
        paymentId: payment.id,
        eventType: 'WEBHOOK_REJECTED',
        status: payment.status,
        actor: WEBHOOK_ACTOR,
        metadata: { ...metadata, mismatched: mismatches.map((m) => m.field) },
        now: now(),
      });
      return sendError(
        res,
        422,
        'transaction_mismatch',
        'the transaction details do not match the stored payment record',
        mismatches,
      );
    }
    await payments.updateWebhookEvent({ id: event.id, status: 'VERIFIED', paymentId: payment.id });

    // Steps 4-5 (REQ-008, REQ-011): state machine + compare-and-set, audited in the same transaction.
    const applied = await outcomes.applyStatus({
      paymentId: payment.id,
      to: value.status,
      eventType: 'WEBHOOK_APPLIED',
      actor: WEBHOOK_ACTOR,
      metadata,
    });
    if (applied.result !== 'applied' && applied.result !== 'unchanged') {
      // Out-of-order (PENDING after a final outcome) or contradicting a final outcome: not
      // applied. Acknowledged with 200 because a redelivery cannot change that.
      const stale = value.status === PaymentStatus.PENDING;
      const current = applied.payment?.status ?? payment.status;
      await payments.recordEvent({
        paymentId: payment.id,
        eventType: stale ? 'WEBHOOK_IGNORED' : 'WEBHOOK_CONFLICT',
        status: current,
        actor: WEBHOOK_ACTOR,
        metadata: { ...metadata, reported_status: value.status },
        now: now(),
      });
      if (!stale) {
        console.error(`payment ${payment.id}: webhook reports ${value.status} but the payment is ${current}; investigate`);
      }
      return webhookAnswer(res, await reject(stale ? 'stale' : 'conflict', payment.id), current);
    }
    const current = applied.payment;
    if (current.status === PaymentStatus.SUCCESS || current.status === PaymentStatus.FAILED) {
      await payments.completeCheckoutSession(current.id);
    }

    // Step 6 (REQ-009): synchronous order notification (retried by the client). If order-service
    // stays unreachable the event remains VERIFIED and we answer 503, so the gateway redelivers
    // and the redelivery re-sends the (idempotent) notification.
    try {
      await outcomes.notifyOrder({ payment: current, actor: WEBHOOK_ACTOR, metadata });
    } catch (err) {
      console.error(`webhook ${value.gatewayEventId}: order notification failed: ${err.message}`);
      return sendError(
        res,
        503,
        'order_service_unavailable',
        'the payment was updated but the order service could not be notified; redeliver the webhook',
      );
    }
    const done = await payments.updateWebhookEvent({
      id: event.id,
      status: 'APPLIED',
      outcome: applied.result,
      processedAt: now(),
    });
    return webhookAnswer(res, done, current.status);
  }

  // OP-006 receivePaymentWebhook · REQ-007, REQ-008, REQ-009, REQ-010, REQ-011
  // No caller auth: the gateway authenticates the content with an HMAC signature instead.
  app.post('/webhooks/payments', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    // Step 2 (REQ-007, REQ-011): verify the signature before trusting or storing anything.
    // Unsigned deliveries are not recorded, so they cannot claim a real gateway event id.
    const secret = await secrets.getWebhookSecret();
    if (!verifyWebhookSignature({ rawBody: req.rawBody, signature: req.get('x-gateway-signature'), secret })) {
      console.warn('rejected a payment webhook with a missing or invalid signature');
      return sendError(res, 400, 'invalid_signature', 'the webhook signature is missing or invalid');
    }
    const { value, errors } = parseWebhookPayload(req.body);
    if (errors) return sendError(res, 400, 'validation_failed', 'the webhook payload is missing or invalid fields', errors);

    // Step 3 (REQ-010): record the delivery, deduped by the gateway's event id.
    const { event, duplicate } = await payments.recordWebhookEvent({
      gatewayEventId: value.gatewayEventId,
      rawPayload: req.body,
      signatureValid: true,
      now: now(),
    });
    if (duplicate && (event.status === 'APPLIED' || event.status === 'REJECTED')) {
      const stored = event.payment_id ? await payments.findById(event.payment_id) : null;
      return webhookAnswer(res, event, stored?.payment.status);
    }
    // First delivery, or a redelivery of one that did not finish (e.g. order-service was down):
    // every step is idempotent, so process it (again).
    return processWebhook(res, event, value);
  });

  app.use((req, res) => sendError(res, 404, 'not_found', 'route not found'));
  app.use(errorHandler);
  return app;
}
