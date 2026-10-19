import { UUID_RE } from '../shared/errors.js';

const CURRENCY_RE = /^[A-Z]{3}$/;
const PAYMENT_METHOD_RE = /^[a-z][a-z0-9_]{0,31}$/;
// Printable ASCII, no spaces, bounded length (Stripe-style keys, UUIDs, ...).
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

/**
 * Validates an initiatePayment request: the `Idempotency-Key` header and a `Payment` body of
 * which only `order_id`, `amount`, `currency` and `payment_method` are client-supplied; `id`,
 * `status`, `gateway_*`, `idempotency_key` (taken from the header) and timestamps are
 * server-owned and ignored if sent. Returns `{ value }` or `{ errors: [{ field, message }] }`.
 */
export function validateInitiatePayment(body, idempotencyKey) {
  const errors = [];
  if (idempotencyKey === undefined || idempotencyKey === '') {
    errors.push({ field: 'Idempotency-Key', message: 'header is required' });
  } else if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    errors.push({ field: 'Idempotency-Key', message: 'must be 1-255 printable ASCII characters without spaces' });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [...errors, { field: 'body', message: 'must be a JSON object' }] };
  }
  const { order_id, amount, currency, payment_method } = body;

  if (order_id === undefined || order_id === null) {
    errors.push({ field: 'order_id', message: 'is required' });
  } else if (typeof order_id !== 'string' || !UUID_RE.test(order_id)) {
    errors.push({ field: 'order_id', message: 'must be a UUID' });
  }

  if (amount === undefined || amount === null) {
    errors.push({ field: 'amount', message: 'is required' });
  } else if (!Number.isSafeInteger(amount) || amount <= 0) {
    errors.push({ field: 'amount', message: 'must be a positive integer in minor units' });
  }

  if (currency === undefined || currency === null) {
    errors.push({ field: 'currency', message: 'is required' });
  } else if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
    errors.push({ field: 'currency', message: 'must be an ISO 4217 code, e.g. USD' });
  }

  if (payment_method === undefined || payment_method === null || payment_method === '') {
    errors.push({ field: 'payment_method', message: 'is required' });
  } else if (typeof payment_method !== 'string' || !PAYMENT_METHOD_RE.test(payment_method)) {
    errors.push({ field: 'payment_method', message: 'must be a lowercase method name, e.g. card, upi, netbanking' });
  }

  if (errors.length) return { errors };
  return {
    value: {
      idempotencyKey,
      orderId: order_id.toLowerCase(),
      amount,
      currency,
      paymentMethod: payment_method,
    },
  };
}
