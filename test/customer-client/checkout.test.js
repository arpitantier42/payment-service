import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildOrderRequest,
  buildPaymentRequest,
  cartTotal,
  checkoutAction,
  createIdempotencyKeys,
  describeError,
  describePayment,
  submitPayment,
} from '../../src/customer-client/public/checkout.js';

const NOW = new Date('2026-10-19T10:00:00.000Z');
const ORDER = { id: '7d1f6a3e-2b8c-4f0e-9a4d-5c6b7a8e9f01', status: 'PENDING_PAYMENT', total_amount: 54800, currency: 'INR' };

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const session = (overrides = {}) => ({
  id: 'b8d7f1d0-0000-4000-8000-000000000001',
  status: 'ACTIVE',
  checkout_url: 'https://checkout.example/pay/1',
  expires_at: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
  ...overrides,
});

describe('customer-client order request (REQ-001)', () => {
  it('builds the createOrder body from the cart total', () => {
    const total = cartTotal([{ price: 34900, quantity: 1 }, { price: 19900, quantity: 1 }, { price: 1, quantity: 0 }]);
    assert.equal(total, 54800);
    assert.deepEqual(buildOrderRequest({ customerId: ORDER.id, totalAmount: total, currency: 'INR' }).value, {
      customer_id: ORDER.id,
      total_amount: 54800,
      currency: 'INR',
    });
  });

  it('refuses an empty cart', () => {
    const { errors } = buildOrderRequest({ customerId: ORDER.id, totalAmount: 0, currency: 'INR' });
    assert.deepEqual(errors.map((e) => e.field), ['total_amount']);
  });
});

describe('customer-client payment request (REQ-002)', () => {
  it('sends order id, amount, currency and the chosen method', () => {
    assert.deepEqual(buildPaymentRequest({ order: ORDER, paymentMethod: 'upi' }).value, {
      order_id: ORDER.id,
      amount: 54800,
      currency: 'INR',
      payment_method: 'upi',
    });
  });

  it('rejects a request missing the order id, amount, currency or payment method before sending it', () => {
    const cases = [
      [{ order: { ...ORDER, id: undefined }, paymentMethod: 'card' }, 'order_id'],
      [{ order: { ...ORDER, total_amount: undefined }, paymentMethod: 'card' }, 'amount'],
      [{ order: { ...ORDER, currency: undefined }, paymentMethod: 'card' }, 'currency'],
      [{ order: ORDER, paymentMethod: undefined }, 'payment_method'],
      [{ order: ORDER, paymentMethod: 'cash' }, 'payment_method'],
    ];
    for (const [input, field] of cases) {
      const { value, errors } = buildPaymentRequest(input);
      assert.equal(value, undefined);
      assert.deepEqual(errors.map((e) => e.field), [field]);
    }
    assert.deepEqual(buildPaymentRequest({ order: null }).errors.map((e) => e.field), ['order_id', 'amount', 'currency', 'payment_method']);
  });
});

describe('customer-client idempotency keys (REQ-010 retry contract)', () => {
  it('reuses the key for the same request and mints a new one when the request changes or is forgotten', () => {
    let n = 0;
    const keys = createIdempotencyKeys(memoryStorage(), () => `key-${++n}`);
    const req = buildPaymentRequest({ order: ORDER, paymentMethod: 'card' }).value;
    assert.equal(keys.keyFor(req), 'key-1');
    assert.equal(keys.keyFor({ ...req }), 'key-1');
    assert.equal(keys.keyFor({ ...req, payment_method: 'upi' }), 'key-2');
    keys.forget(ORDER.id);
    assert.equal(keys.keyFor({ ...req, payment_method: 'upi' }), 'key-3');
  });

  it('retries a lost response with the same key', async () => {
    const keys = createIdempotencyKeys(memoryStorage(), () => 'only-key');
    const sent = [];
    const result = await submitPayment({
      request: buildPaymentRequest({ order: ORDER, paymentMethod: 'card' }).value,
      keys,
      sleep: async () => {},
      post: async (request, key) => {
        sent.push(key);
        if (sent.length < 3) throw new TypeError('fetch failed');
        return { status: 201, body: { id: 'p1' } };
      },
    });
    assert.deepEqual(sent, ['only-key', 'only-key', 'only-key']);
    assert.equal(result.status, 201);
  });

  it('gives up after the attempts and reports status 0', async () => {
    const result = await submitPayment({
      request: buildPaymentRequest({ order: ORDER, paymentMethod: 'card' }).value,
      keys: createIdempotencyKeys(memoryStorage(), () => 'k'),
      attempts: 2,
      sleep: async () => {},
      post: async () => {
        throw new TypeError('fetch failed');
      },
    });
    assert.deepEqual(result, { status: 0, body: null, key: 'k' });
    assert.equal(describeError(0, null).retrySameKey, true);
  });
});

describe('customer-client checkout redirect (REQ-005, REQ-006)', () => {
  it('redirects to the hosted checkout of an active session', () => {
    const payment = { status: 'INITIATED', checkout_session: session() };
    assert.deepEqual(checkoutAction(payment, NOW), { action: 'redirect', url: 'https://checkout.example/pay/1' });
  });

  it('does not redirect to an expired or invalidated session', () => {
    const lapsed = session({ expires_at: new Date(NOW.getTime() - 1).toISOString() });
    assert.deepEqual(checkoutAction({ status: 'INITIATED', checkout_session: lapsed }, NOW), { action: 'expired' });
    assert.deepEqual(checkoutAction({ status: 'INITIATED', checkout_session: session({ status: 'EXPIRED' }) }, NOW), {
      action: 'expired',
    });
    assert.deepEqual(checkoutAction({ status: 'EXPIRED', checkout_session: session({ status: 'EXPIRED' }) }, NOW), {
      action: 'final',
      status: 'EXPIRED',
    });
  });

  it('asks for a same-key retry when there is no session yet, and refuses non-web URLs', () => {
    assert.deepEqual(checkoutAction({ status: 'INITIATED', checkout_session: null }, NOW), { action: 'retry' });
    const evil = session({ checkout_url: 'javascript:alert(1)' });
    assert.deepEqual(checkoutAction({ status: 'INITIATED', checkout_session: evil }, NOW), { action: 'invalid' });
  });

  it('describes the outcome after returning from checkout', () => {
    assert.equal(describePayment({ status: 'PENDING' }).final, false);
    assert.equal(describePayment({ status: 'INITIATED' }).final, false);
    const ok = describePayment({ status: 'SUCCESS', payment_method: 'upi' });
    assert.equal(ok.final, true);
    assert.match(ok.message, /upi/);
    assert.equal(describePayment({ status: 'EXPIRED' }).tone, 'error');
    assert.match(describeError(404, { error: { code: 'order_not_found' } }).message, /no longer exists/);
    assert.equal(describeError(502, { error: { code: 'gateway_unavailable' } }).retrySameKey, true);
  });
});
