import { UUID_RE } from '../shared/errors.js';
import { ORDER_STATUSES } from './orderStatus.js';

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Validates a createOrder body. Only `customer_id`, `total_amount` and `currency` are
 * client-supplied; `id`, `status` and timestamps are server-owned and ignored if sent.
 * Returns `{ value }` on success or `{ errors: [{ field, message }] }`.
 */
export function validateCreateOrder(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: 'body', message: 'must be a JSON object' }] };
  }
  const errors = [];
  const { customer_id, total_amount, currency } = body;

  if (customer_id === undefined || customer_id === null) {
    errors.push({ field: 'customer_id', message: 'is required' });
  } else if (typeof customer_id !== 'string' || !UUID_RE.test(customer_id)) {
    errors.push({ field: 'customer_id', message: 'must be a UUID' });
  }

  if (total_amount === undefined || total_amount === null) {
    errors.push({ field: 'total_amount', message: 'is required' });
  } else if (!Number.isSafeInteger(total_amount) || total_amount <= 0) {
    errors.push({ field: 'total_amount', message: 'must be a positive integer in minor units' });
  }

  if (currency === undefined || currency === null) {
    errors.push({ field: 'currency', message: 'is required' });
  } else if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
    errors.push({ field: 'currency', message: 'must be an ISO 4217 code, e.g. USD' });
  }

  if (errors.length) return { errors };
  return { value: { customerId: customer_id.toLowerCase(), totalAmount: total_amount, currency } };
}

/**
 * Validates an updateOrderPaymentStatus body (an `Order`). Only `status` is read; every other
 * Order field is server-owned or immutable and ignored if sent.
 */
export function validateStatusUpdate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: 'body', message: 'must be a JSON object' }] };
  }
  const { status } = body;
  if (status === undefined || status === null) {
    return { errors: [{ field: 'status', message: 'is required' }] };
  }
  if (!ORDER_STATUSES.includes(status)) {
    return { errors: [{ field: 'status', message: `must be one of ${ORDER_STATUSES.join(', ')}` }] };
  }
  return { value: { status } };
}
