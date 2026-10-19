export const OrderStatus = Object.freeze({
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAID: 'PAID',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  CANCELLED: 'CANCELLED',
});

export const ORDER_STATUSES = Object.freeze(Object.values(OrderStatus));

/**
 * Order state machine (OP-003). Keys are current statuses, values the statuses they may move to.
 * - PENDING_PAYMENT -> PAID (payment SUCCESS), PAYMENT_FAILED (FAILED/EXPIRED), CANCELLED.
 * - PAYMENT_FAILED -> PAID covers a late success (reconciliation finds the charge went through,
 *   or a retried payment succeeds); PAYMENT_FAILED -> CANCELLED abandons the order.
 * - PAID and CANCELLED are terminal.
 * Setting the status an order already has is an idempotent no-op, not a transition (see
 * `checkTransition`), so a repeated notification (webhook redelivery, reconciliation) is safe.
 */
const TRANSITIONS = Object.freeze({
  [OrderStatus.PENDING_PAYMENT]: [OrderStatus.PAID, OrderStatus.PAYMENT_FAILED, OrderStatus.CANCELLED],
  [OrderStatus.PAYMENT_FAILED]: [OrderStatus.PAID, OrderStatus.CANCELLED],
  [OrderStatus.PAID]: [],
  [OrderStatus.CANCELLED]: [],
});

/** Returns 'unchanged' (already in `to`), 'allowed' or 'invalid' for moving `from` -> `to`. */
export function checkTransition(from, to) {
  if (from === to) return 'unchanged';
  return TRANSITIONS[from]?.includes(to) ? 'allowed' : 'invalid';
}
