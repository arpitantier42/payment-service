import { randomUUID } from 'node:crypto';
import { DEFAULT_RETRY_POLICY, withRetry } from '../shared/retry.js';
import { isAwaitingCustomer, TRANSACTION_NOT_FOUND } from '../payment-service/gateway.js';
import { createPaymentOutcomes } from '../payment-service/paymentOutcome.js';
import { PaymentStatus } from '../payment-service/paymentStatus.js';

const ACTOR = 'reconciliation_job';

/**
 * OP-007 reconcilePendingPayments (REQ-008, REQ-009, REQ-010, REQ-011). One run:
 *   1. selects INITIATED/PENDING payments whose status has not changed for `thresholdMs`
 *   2. queries the gateway for each (retried with `gatewayRetryPolicy`; a query that still fails
 *      is audited and the payment is picked up again by the next run)
 *   3-4. applies the gateway's answer via the state machine + compare-and-set, audited as
 *      RECONCILED (or RECONCILIATION_UNRESOLVED / _MISMATCH / _CONFLICT / _GATEWAY_FAILED when the
 *      status does not change)
 *   5. notifies order-service of a resolved outcome; notifications that failed earlier (here or
 *      in the webhook path) are re-sent at the end of every run.
 *
 * @param {{
 *   payments: ReturnType<import('../payment-service/paymentRepository.js').createPaymentRepository>,
 *   orders: { updateOrderStatus(orderId: string, status: string): Promise<{ outcome: string }> },
 *   gateway: { name: string, getTransactionStatus(args: object): Promise<object> },
 *   secrets: { getGatewayCredentials(): Promise<{ keyId: string, keySecret: string }> },
 *   thresholdMs?: number,
 *   batchSize?: number,
 *   gatewayRetryPolicy?: { attempts?: number, baseDelayMs?: number, factor?: number },
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => Date,
 * }} deps
 */
export function createReconciler({
  payments,
  orders,
  gateway,
  secrets,
  thresholdMs = 10 * 60 * 1000,
  batchSize = 100,
  gatewayRetryPolicy = DEFAULT_RETRY_POLICY,
  sleep,
  now = () => new Date(),
}) {
  const outcomes = createPaymentOutcomes({ payments, orders, now });

  /** Sends the order notification; 'failed' when order-service stayed unreachable (re-sent next run). */
  async function notify(payment, metadata) {
    try {
      return await outcomes.notifyOrder({ payment, actor: ACTOR, metadata });
    } catch (err) {
      console.error(`payment ${payment.id}: order notification failed, will retry next run: ${err.message}`);
      return 'failed';
    }
  }

  /**
   * Decides what the gateway's answer means for `payment` (and its checkout session):
   * `{ target, reason? }` or `{ hold, reason }`.
   */
  function decide(payment, tx, session) {
    if (tx.status === TRANSACTION_NOT_FOUND) {
      // No checkout was ever opened at the gateway (the initiation call failed and nobody resumed
      // it): nothing can be charged, so the attempt failed and the order is free for a new one.
      if (payment.status === PaymentStatus.INITIATED && !payment.gateway_reference) return { target: PaymentStatus.FAILED };
      return { hold: 'RECONCILIATION_UNRESOLVED', reason: 'not_found_at_gateway' };
    }
    const mismatched = [];
    if (tx.amount !== null && tx.amount !== payment.amount) mismatched.push('amount');
    if (tx.currency !== null && tx.currency !== payment.currency) mismatched.push('currency');
    if (tx.gatewayReference && payment.gateway_reference && tx.gatewayReference !== payment.gateway_reference) {
      mismatched.push('gateway_reference');
    }
    if (mismatched.length) return { hold: 'RECONCILIATION_MISMATCH', reason: 'details_mismatch', mismatched };
    if (isAwaitingCustomer(tx.gatewayStatus)) {
      // OP-008 interplay (REQ-006): the customer has not attempted payment. Once the checkout
      // window has lapsed nothing can still be charged, so the attempt expired; before that the
      // payment stays INITIATED (not PENDING), so the session-expiry run can still expire it.
      if (session && session.status !== 'COMPLETED' && new Date(session.expires_at) <= now()) {
        return { target: PaymentStatus.EXPIRED, reason: 'checkout_window_lapsed' };
      }
      if (payment.status === PaymentStatus.INITIATED) return { hold: 'RECONCILIATION_UNRESOLVED', reason: 'awaiting_customer' };
    }
    return { target: tx.status };
  }

  async function reconcileOne(payment, runId) {
    const result = { payment_id: payment.id, previous_status: payment.status, status: payment.status };
    const metadata = { reconciliation_run_id: runId, gateway_reference: payment.gateway_reference };
    const audit = (eventType, status, extra) =>
      payments.recordEvent({ paymentId: payment.id, eventType, status, actor: ACTOR, metadata: { ...metadata, ...extra }, now: now() });

    // Step 2 (REQ-010): ask the gateway, which is the system of record for the charge.
    let tx;
    try {
      const credentials = await secrets.getGatewayCredentials();
      tx = await withRetry(
        () => gateway.getTransactionStatus({ credentials, payment }),
        gatewayRetryPolicy,
        sleep ? { sleep } : undefined,
      );
    } catch (err) {
      const error = err?.message ?? String(err);
      await audit('RECONCILIATION_GATEWAY_FAILED', payment.status, {
        error,
        attempts: err?.attempts ?? 1,
        retryable: Boolean(err?.retryable),
        gateway_status: err?.status ?? null,
      });
      console.error(`payment ${payment.id}: gateway status query failed, will retry next run: ${error}`);
      return { ...result, outcome: 'gateway_unavailable', error };
    }
    metadata.gateway_status = tx.gatewayStatus;
    result.gateway_status = tx.gatewayStatus;

    const session = (await payments.findById(payment.id))?.checkoutSession ?? null;
    const decision = decide(payment, tx, session);
    if (decision.hold) {
      await audit(decision.hold, payment.status, { reason: decision.reason, mismatched: decision.mismatched });
      if (decision.hold === 'RECONCILIATION_MISMATCH') {
        console.error(`payment ${payment.id}: gateway reports different ${decision.mismatched.join(', ')}; investigate`);
      }
      return { ...result, outcome: decision.reason };
    }

    // Steps 3-4 (REQ-008, REQ-011): state machine + compare-and-set, audited in the same transaction.
    const applied = await outcomes.applyStatus({
      paymentId: payment.id,
      to: decision.target,
      eventType: 'RECONCILED',
      actor: ACTOR,
      metadata: { ...metadata, decision: decision.target, ...(decision.reason && { reason: decision.reason }) },
    });
    if (applied.result === 'not_found') return { ...result, outcome: 'not_found' };
    if (applied.result === 'unchanged') {
      // Still unresolved at the gateway (PENDING): keep polling on later runs.
      await audit('RECONCILIATION_UNRESOLVED', applied.payment.status, { reason: 'still_pending' });
      return { ...result, outcome: 'unchanged' };
    }
    if (applied.result === 'invalid') {
      // Another writer (normally a webhook) resolved it since we selected it.
      const current = applied.payment.status;
      const stale = decision.target === PaymentStatus.PENDING;
      await audit(stale ? 'RECONCILIATION_IGNORED' : 'RECONCILIATION_CONFLICT', current, { reported_status: decision.target });
      if (!stale) console.error(`payment ${payment.id}: gateway reports ${decision.target} but the payment is ${current}; investigate`);
      return { ...result, status: current, outcome: stale ? 'stale' : 'conflict' };
    }

    const updated = applied.payment;
    if (updated.status === PaymentStatus.SUCCESS || updated.status === PaymentStatus.FAILED) {
      await payments.completeCheckoutSession(updated.id);
    } else if (updated.status === PaymentStatus.EXPIRED) {
      await payments.expireCheckoutSession(updated.id);
    }
    // Step 5 (REQ-009): only resolved outcomes are reported (PENDING is 'skipped').
    const notification = await notify(updated, metadata);
    return { ...result, status: updated.status, outcome: 'applied', order_notification: notification };
  }

  async function runOnce() {
    const runId = randomUUID();
    const startedAt = now();
    const cutoff = new Date(startedAt.getTime() - thresholdMs);

    // Step 1 (REQ-010).
    const stuck = await payments.findStuckPayments({ cutoff, limit: batchSize });
    const results = [];
    for (const payment of stuck) {
      try {
        results.push(await reconcileOne(payment, runId));
      } catch (err) {
        // One bad payment must not stop the batch; it is selected again next run.
        console.error(`payment ${payment.id}: reconciliation failed: ${err.stack ?? err}`);
        results.push({ payment_id: payment.id, previous_status: payment.status, status: payment.status, outcome: 'error', error: err.message });
      }
    }

    // REQ-009: re-send notifications order-service could not take in earlier runs / webhooks
    // (not the ones that just failed above: their retries are already spent for this run).
    const attempted = new Set(results.filter((r) => r.order_notification === 'failed').map((r) => r.payment_id));
    const notifications = [];
    for (const payment of await payments.findUndeliveredOrderNotifications({ limit: batchSize })) {
      if (attempted.has(payment.id)) continue;
      notifications.push({ payment_id: payment.id, order_id: payment.order_id, outcome: await notify(payment, { reconciliation_run_id: runId }) });
    }

    const counts = {};
    for (const { outcome } of results) counts[outcome] = (counts[outcome] ?? 0) + 1;
    return {
      run_id: runId,
      started_at: startedAt.toISOString(),
      finished_at: now().toISOString(),
      threshold_seconds: Math.round(thresholdMs / 1000),
      examined: results.length,
      outcomes: counts,
      payments: results,
      order_notifications_retried: notifications,
    };
  }

  let inFlight = null;
  return {
    /** Runs one batch. Overlapping calls (scheduler tick + manual trigger) share the in-flight run. */
    run() {
      if (!inFlight) inFlight = runOnce().finally(() => (inFlight = null));
      return inFlight;
    },
  };
}
