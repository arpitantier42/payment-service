export const PaymentStatus = Object.freeze({
  INITIATED: 'INITIATED',
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
});

/** Non-terminal statuses: the outcome is not known yet (reconciliation picks these up). */
export const ACTIVE_PAYMENT_STATUSES = Object.freeze([PaymentStatus.INITIATED, PaymentStatus.PENDING]);

/**
 * Payment state machine. INITIATED is set on creation (OP-004); webhooks, reconciliation and
 * session expiry move it on. SUCCESS, FAILED and EXPIRED are terminal.
 */
const TRANSITIONS = Object.freeze({
  [PaymentStatus.INITIATED]: [PaymentStatus.PENDING, PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED],
  [PaymentStatus.PENDING]: [PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED],
  [PaymentStatus.SUCCESS]: [],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.EXPIRED]: [],
});

/** Returns 'unchanged' (already in `to`), 'allowed' or 'invalid' for moving `from` -> `to`. */
export function checkTransition(from, to) {
  if (from === to) return 'unchanged';
  return TRANSITIONS[from]?.includes(to) ? 'allowed' : 'invalid';
}

/** Order statuses a payment may be started for (a failed payment can be retried). */
export const PAYABLE_ORDER_STATUSES = Object.freeze(['PENDING_PAYMENT', 'PAYMENT_FAILED']);
