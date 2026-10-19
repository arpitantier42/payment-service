import { randomUUID } from 'node:crypto';
import { createPaymentOutcomes } from '../payment-service/paymentOutcome.js';
import { PaymentStatus } from '../payment-service/paymentStatus.js';

const ACTOR = 'reconciliation_job';

/**
 * OP-008 expireCheckoutSessions (REQ-006, REQ-008, REQ-009, REQ-011). One run, driven purely by
 * elapsed time (no gateway signal needed):
 *   1. selects checkout sessions still ACTIVE whose `expires_at` (+ `graceMs`) has passed
 *   2. marks the payment EXPIRED (state machine + compare-and-set, SESSION_EXPIRED audit in the
 *      same transaction) and the session EXPIRED
 *   3. notifies order-service (EXPIRED -> PAYMENT_FAILED, so the order can be paid again);
 *      a notification order-service cannot take is re-sent by the reconciliation run.
 *
 * Per payment status:
 *   INITIATED          -> payment EXPIRED, session EXPIRED, order notified          ('expired')
 *   PENDING            -> session EXPIRED only: the gateway has reported a charge in progress, so
 *                         the outcome is left to webhook / reconciliation, which ask the gateway
 *                         (SESSION_EXPIRY_DEFERRED audit)                           ('deferred');
 *                         if the gateway then reports no attempt in flight ("created"/"open"),
 *                         the reconciliation run marks it EXPIRED because the window has lapsed
 *   SUCCESS / FAILED   -> outcome already known, session marked COMPLETED          ('already_resolved')
 *   EXPIRED            -> session EXPIRED                                          ('unchanged')
 * Either way the session is no longer ACTIVE, so it is not selected again.
 *
 * `graceMs` absorbs a webhook for a payment completed just before `expires_at` that has not
 * arrived yet, so it is not overtaken by the expiry.
 *
 * @param {{
 *   payments: ReturnType<import('../payment-service/paymentRepository.js').createPaymentRepository>,
 *   orders: { updateOrderStatus(orderId: string, status: string): Promise<{ outcome: string }> },
 *   graceMs?: number,
 *   batchSize?: number,
 *   now?: () => Date,
 * }} deps
 */
export function createSessionExpirer({ payments, orders, graceMs = 60 * 1000, batchSize = 100, now = () => new Date() }) {
  const outcomes = createPaymentOutcomes({ payments, orders, now });

  async function expireOne(paymentId, runId) {
    const found = await payments.findById(paymentId);
    if (!found) return { payment_id: paymentId, outcome: 'not_found' };
    const { payment, checkoutSession } = found;
    const result = { payment_id: payment.id, session_id: checkoutSession?.id ?? null, previous_status: payment.status, status: payment.status };
    const metadata = {
      session_expiry_run_id: runId,
      checkout_session_id: checkoutSession?.id ?? null,
      expires_at: checkoutSession?.expires_at ?? null,
    };

    if (payment.status === PaymentStatus.PENDING) {
      await payments.expireCheckoutSession(payment.id);
      await payments.recordEvent({
        paymentId: payment.id,
        eventType: 'SESSION_EXPIRY_DEFERRED',
        status: payment.status,
        actor: ACTOR,
        metadata: { ...metadata, reason: 'pending_at_gateway' },
        now: now(),
      });
      return { ...result, outcome: 'deferred' };
    }

    // Step 2 (REQ-006, REQ-008, REQ-011).
    const applied = await outcomes.applyStatus({
      paymentId: payment.id,
      to: PaymentStatus.EXPIRED,
      eventType: 'SESSION_EXPIRED',
      actor: ACTOR,
      metadata,
    });
    if (applied.result === 'not_found') return { ...result, outcome: 'not_found' };
    const current = applied.payment.status;
    if (applied.result === 'invalid') {
      // A webhook / reconciliation resolved it first; the session is done either way.
      if (current === PaymentStatus.PENDING) {
        await payments.expireCheckoutSession(payment.id);
        return { ...result, status: current, outcome: 'deferred' };
      }
      await payments.completeCheckoutSession(payment.id);
      return { ...result, status: current, outcome: 'already_resolved' };
    }
    await payments.expireCheckoutSession(payment.id);
    if (applied.result === 'unchanged') return { ...result, outcome: 'unchanged' };

    // Step 3 (REQ-009).
    let notification;
    try {
      notification = await outcomes.notifyOrder({ payment: applied.payment, actor: ACTOR, metadata });
    } catch (err) {
      console.error(`payment ${payment.id}: order notification failed, re-sent by the reconciliation run: ${err.message}`);
      notification = 'failed';
    }
    return { ...result, status: current, outcome: 'expired', order_notification: notification };
  }

  async function runOnce() {
    const runId = randomUUID();
    const startedAt = now();
    const cutoff = new Date(startedAt.getTime() - graceMs);

    // Step 1 (REQ-006).
    const lapsed = await payments.findLapsedCheckoutSessions({ cutoff, limit: batchSize });
    const results = [];
    for (const paymentId of lapsed) {
      try {
        results.push(await expireOne(paymentId, runId));
      } catch (err) {
        // One bad record must not stop the batch; its session is still ACTIVE, so it is retried.
        console.error(`payment ${paymentId}: session expiry failed: ${err.stack ?? err}`);
        results.push({ payment_id: paymentId, outcome: 'error', error: err.message });
      }
    }

    const counts = {};
    for (const { outcome } of results) counts[outcome] = (counts[outcome] ?? 0) + 1;
    return {
      run_id: runId,
      started_at: startedAt.toISOString(),
      finished_at: now().toISOString(),
      cutoff: cutoff.toISOString(),
      grace_seconds: Math.round(graceMs / 1000),
      examined: results.length,
      outcomes: counts,
      sessions: results,
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
