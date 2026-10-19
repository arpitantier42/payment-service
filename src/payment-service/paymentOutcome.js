import { checkTransition, orderStatusFor } from './paymentStatus.js';

/**
 * Applies a resolved payment outcome and tells order-service about it. Shared by the webhook
 * (actor `gateway_webhook`) and meant for reconciliation / session expiry (`reconciliation_job`).
 *
 * @param {{
 *   payments: ReturnType<import('./paymentRepository.js').createPaymentRepository>,
 *   orders: { updateOrderStatus(orderId: string, status: string): Promise<{ outcome: string }> },
 *   now?: () => Date,
 * }} deps
 */
export function createPaymentOutcomes({ payments, orders, now = () => new Date() }) {
  return {
    /**
     * Moves the payment to `to` via the state machine + compare-and-set (audited by the
     * repository). Returns `{ result, payment }` where result is 'applied', 'unchanged' (already
     * in `to`), 'invalid' (not allowed from the current status) or 'not_found'.
     */
    async applyStatus({ paymentId, to, eventType, actor, metadata }) {
      // A lost compare-and-set means another writer moved the payment: re-read and re-check.
      for (let attempt = 0; attempt < 5; attempt++) {
        const found = await payments.findById(paymentId);
        if (!found) return { result: 'not_found', payment: null };
        const { payment } = found;
        const check = checkTransition(payment.status, to);
        if (check !== 'allowed') return { result: check, payment };
        const updated = await payments.updateStatus({ id: paymentId, from: payment.status, to, eventType, actor, metadata, now: now() });
        if (updated) return { result: 'applied', payment: updated };
      }
      throw new Error(`payment ${paymentId}: status kept changing concurrently`);
    },

    /**
     * REQ-009: PATCHes the order to the status the payment's outcome maps to. Returns the
     * order-service outcome ('applied' | 'conflict' | 'not_found') or 'skipped' when the payment
     * is not resolved. Conflicts / unknown orders are audited (not retried); an unreachable
     * order-service (after the client's retries) is audited and rethrown so the caller can
     * surface it and be retried.
     */
    async notifyOrder({ payment, actor, metadata = {} }) {
      const orderStatus = orderStatusFor(payment.status);
      if (!orderStatus) return 'skipped';
      const audit = (eventType, extra) =>
        payments.recordEvent({
          paymentId: payment.id,
          eventType,
          status: payment.status,
          actor,
          metadata: { ...metadata, order_id: payment.order_id, order_status: orderStatus, ...extra },
          now: now(),
        });
      let outcome;
      try {
        ({ outcome } = await orders.updateOrderStatus(payment.order_id, orderStatus));
      } catch (err) {
        await audit('ORDER_NOTIFICATION_FAILED', { error: err?.message ?? String(err), attempts: err?.attempts ?? 1 });
        throw err;
      }
      if (outcome !== 'applied') {
        // The order moved on (e.g. CANCELLED, or PAID by another payment) or does not exist:
        // retrying cannot help; keep a record for investigation (e.g. a refund).
        await audit('ORDER_NOTIFICATION_REJECTED', { order_service_outcome: outcome });
        console.error(`payment ${payment.id}: order ${payment.order_id} not updated to ${orderStatus} (${outcome})`);
      }
      return outcome;
    },
  };
}
