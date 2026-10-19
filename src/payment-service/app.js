import { randomUUID } from 'node:crypto';
import express from 'express';
import { bearerAuth } from '../shared/auth.js';
import { errorHandler, sendError, UUID_RE } from '../shared/errors.js';
import { DEFAULT_RETRY_POLICY, withRetry } from '../shared/retry.js';
import { isUniqueViolation } from './paymentRepository.js';
import { PAYABLE_ORDER_STATUSES, PaymentStatus } from './paymentStatus.js';
import { validateInitiatePayment } from './validation.js';

const ACTOR = 'system';

/** API shape: the `Payment` plus the checkout details the client redirects to (null until created). */
const present = ({ payment, checkoutSession }) => ({ ...payment, checkout_session: checkoutSession });

/**
 * Builds the payment-service HTTP app.
 * @param {{
 *   payments: ReturnType<import('./paymentRepository.js').createPaymentRepository>,
 *   orders: { getOrder(orderId: string): Promise<object|null> },            // order-service client
 *   gateway: { name: string, createCheckoutSession(args: object): Promise<object> },
 *   secrets: { getGatewayCredentials(): Promise<{ keyId: string, keySecret: string }> },
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
  app.use(express.json({ limit: '100kb' }));

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

  app.use((req, res) => sendError(res, 404, 'not_found', 'route not found'));
  app.use(errorHandler);
  return app;
}
