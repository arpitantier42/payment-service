/**
 * Browser-side checkout logic for the customer-client (CMP-008), free of DOM access so it runs in
 * node:test as well. The UI (app.js) wires these to the page.
 */

export const PAYMENT_METHODS = Object.freeze(['card', 'upi', 'netbanking']);
export const FINAL_PAYMENT_STATUSES = Object.freeze(['SUCCESS', 'FAILED', 'EXPIRED']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Order total in minor units from cart lines `[{ price, quantity }]` (integers). */
export function cartTotal(lines) {
  return lines.reduce((sum, { price, quantity }) => sum + price * quantity, 0);
}

/** REQ-001: body for POST /orders. Returns `{ value }` or `{ errors: [{ field, message }] }`. */
export function buildOrderRequest({ customerId, totalAmount, currency }) {
  const errors = [];
  if (typeof customerId !== 'string' || !UUID_RE.test(customerId)) errors.push({ field: 'customer_id', message: 'is required' });
  if (!Number.isSafeInteger(totalAmount) || totalAmount <= 0) {
    errors.push({ field: 'total_amount', message: 'add at least one item to the cart' });
  }
  if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) errors.push({ field: 'currency', message: 'is required' });
  if (errors.length) return { errors };
  return { value: { customer_id: customerId, total_amount: totalAmount, currency } };
}

/**
 * REQ-002: body for POST /payments from the placed order and the chosen method. A request missing
 * the order id, amount, currency or payment method is rejected here, before anything is sent
 * (payment-service rejects it again with 400). Amount and currency come from the order, which
 * payment-service re-checks against order-service anyway.
 */
export function buildPaymentRequest({ order, paymentMethod }) {
  const errors = [];
  if (!order || typeof order.id !== 'string' || !UUID_RE.test(order.id)) errors.push({ field: 'order_id', message: 'is required' });
  if (!Number.isSafeInteger(order?.total_amount) || order.total_amount <= 0) errors.push({ field: 'amount', message: 'is required' });
  if (typeof order?.currency !== 'string' || !CURRENCY_RE.test(order.currency)) errors.push({ field: 'currency', message: 'is required' });
  if (!PAYMENT_METHODS.includes(paymentMethod)) errors.push({ field: 'payment_method', message: 'choose a payment method' });
  if (errors.length) return { errors };
  return {
    value: { order_id: order.id, amount: order.total_amount, currency: order.currency, payment_method: paymentMethod },
  };
}

/**
 * Idempotency-Key store (REQ-010 / RSK-003 retry contract). One key per order and request: a
 * retry or double-click of the same request reuses the key, so payment-service returns the same
 * payment instead of a second one. `forget` after a final FAILED/EXPIRED outcome, so the next
 * attempt for the (still payable) order gets a fresh key.
 * @param {{ getItem(k: string): string|null, setItem(k: string, v: string): void, removeItem(k: string): void }} storage
 * @param {() => string} newKey
 */
export function createIdempotencyKeys(storage, newKey) {
  const slot = (orderId) => `payment-attempt:${orderId}`;
  const fingerprint = (req) => [req.order_id, req.amount, req.currency, req.payment_method].join('|');
  return {
    keyFor(request) {
      let saved = null;
      try {
        saved = JSON.parse(storage.getItem(slot(request.order_id)) ?? 'null');
      } catch {
        saved = null;
      }
      if (saved && saved.fingerprint === fingerprint(request) && typeof saved.key === 'string') return saved.key;
      const key = newKey();
      storage.setItem(slot(request.order_id), JSON.stringify({ key, fingerprint: fingerprint(request) }));
      return key;
    },
    forget(orderId) {
      storage.removeItem(slot(orderId));
    },
  };
}

/**
 * Sends the payment request, retrying a lost response (network error) with the same key, which is
 * safe because payment-service replays the existing payment for a known key.
 * `post(request, key)` resolves `{ status, body }` or throws on a network failure.
 * Resolves `{ status, body, key }`, or `{ status: 0, body: null, key }` once retries are exhausted.
 */
export async function submitPayment({ request, keys, post, attempts = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const key = keys.keyFor(request);
  for (let attempt = 1; ; attempt++) {
    try {
      const { status, body } = await post(request, key);
      return { status, body, key };
    } catch {
      if (attempt >= attempts) return { status: 0, body: null, key };
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

/**
 * What to do with a payment returned by POST /payments (REQ-005/REQ-006):
 *   { action: 'redirect', url }  send the customer to the gateway's hosted checkout
 *   { action: 'expired' }        the checkout window has passed / session invalidated: start a new attempt
 *   { action: 'final', status }  the payment already has an outcome
 *   { action: 'retry' }          no checkout session yet (gateway failed): resubmit with the same key
 *   { action: 'invalid' }        the checkout URL is not a web URL (never navigate to it)
 */
export function checkoutAction(payment, now = new Date()) {
  if (FINAL_PAYMENT_STATUSES.includes(payment?.status)) return { action: 'final', status: payment.status };
  const session = payment?.checkout_session;
  if (!session) return { action: 'retry' };
  if (session.status !== 'ACTIVE' || !(new Date(session.expires_at) > now)) return { action: 'expired' };
  let url;
  try {
    url = new URL(session.checkout_url);
  } catch {
    return { action: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { action: 'invalid' };
  return { action: 'redirect', url: url.href };
}

/** Message + tone for a payment seen after returning from checkout; `final` stops polling. */
export function describePayment(payment) {
  switch (payment?.status) {
    case 'SUCCESS':
      return { final: true, tone: 'success', message: `Payment received with ${payment.payment_method}. Your order is paid.` };
    case 'FAILED':
      return { final: true, tone: 'error', message: 'The payment did not go through. You can try again.' };
    case 'EXPIRED':
      return { final: true, tone: 'error', message: 'The checkout session expired before payment was completed. You can try again.' };
    default:
      return { final: false, tone: 'info', message: 'Waiting for the payment gateway to confirm your payment…' };
  }
}

/**
 * Customer-facing message for a failed API call; `retrySameKey` marks failures where resubmitting
 * the same request (same Idempotency-Key) is the right move.
 */
export function describeError(status, body) {
  const code = body?.error?.code;
  if (status === 0) return { message: 'We could not reach the shop. Check your connection and try again.', retrySameKey: true };
  switch (code) {
    case 'validation_failed':
      return {
        message: `Some details are missing or invalid: ${(body.error.details ?? []).map((d) => d.field).join(', ')}.`,
        retrySameKey: false,
      };
    case 'order_not_found':
      return { message: 'This order no longer exists. Place a new order.', retrySameKey: false };
    case 'order_not_payable':
      return { message: 'This order can no longer be paid.', retrySameKey: false };
    case 'amount_mismatch':
      return { message: "The amount does not match the order's total. Place the order again.", retrySameKey: false };
    case 'payment_in_progress':
      return {
        message: 'A payment for this order is still in progress. Wait a few minutes for it to resolve before trying again.',
        retrySameKey: false,
      };
    case 'gateway_unavailable':
      return { message: 'The payment provider is not responding. Try again in a moment.', retrySameKey: true };
    default:
      if (status >= 500) return { message: 'Something went wrong on our side. Try again in a moment.', retrySameKey: true };
      return { message: body?.error?.message ?? `Request failed (${status}).`, retrySameKey: false };
  }
}

/** "12.34 INR" from minor units (2-decimal currencies). */
export function formatAmount(amount, currency) {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}
