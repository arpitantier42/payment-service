import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp as createOrderApp } from '../../src/order-service/app.js';
import { createOrderRepository } from '../../src/order-service/orderRepository.js';
import { createApp } from '../../src/payment-service/app.js';
import { createOrderClient } from '../../src/payment-service/orderClient.js';
import { createPaymentRepository } from '../../src/payment-service/paymentRepository.js';
import { UpstreamError } from '../../src/shared/retry.js';
import { createEncryptedSecretsManager, encryptSecret } from '../../src/shared/secrets.js';
import { createTestPool } from '../helpers/db.js';

const TOKEN = 'payment-test-token';
const AUTH = `Bearer ${TOKEN}`;
const ORDER_TOKEN = 'order-service-token';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOW = new Date('2026-10-19T10:00:00.000Z');
const KEY_SECRET = 'sk_live_super_secret_value';

let orderPool;
let paymentPool;
let orderServer;
let app;
let gateway;
let sleeps;
let orderClientDown;

/** Programmable stub gateway: `gateway.script` is a list of results/errors for successive calls. */
function createStubGateway() {
  const stub = {
    name: 'razorpay',
    calls: [],
    script: [],
    async createCheckoutSession(args) {
      stub.calls.push(args);
      const next = stub.script.shift();
      if (next instanceof Error) throw next;
      return (
        next ?? {
          gatewaySessionId: `cs_${args.payment.id}`,
          gatewayReference: `txn_${args.payment.id}`,
          checkoutUrl: `https://checkout.example/${args.payment.id}`,
        }
      );
    },
  };
  return stub;
}

beforeEach(async () => {
  orderPool = await createTestPool('order-db');
  paymentPool = await createTestPool('payment-db');
  const orderApp = createOrderApp({ orders: createOrderRepository(orderPool), bearerTokens: [ORDER_TOKEN] });
  orderServer = await new Promise((resolve) => {
    const s = orderApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const realOrders = createOrderClient({
    baseUrl: `http://127.0.0.1:${orderServer.address().port}`,
    token: ORDER_TOKEN,
    retryPolicy: { attempts: 1 },
  });
  orderClientDown = false;
  const orders = {
    getOrder: (id) => (orderClientDown ? Promise.reject(new UpstreamError('order-service unreachable')) : realOrders.getOrder(id)),
  };

  const masterKey = randomBytes(32).toString('base64');
  const secrets = createEncryptedSecretsManager({
    encryptedGatewayCredentials: encryptSecret(JSON.stringify({ key_id: 'rzp_key', key_secret: KEY_SECRET }), masterKey),
    masterKey,
  });

  gateway = createStubGateway();
  sleeps = [];
  app = createApp({
    payments: createPaymentRepository(paymentPool),
    orders,
    gateway,
    secrets,
    bearerTokens: [TOKEN],
    checkoutTtlMs: 15 * 60 * 1000,
    sleep: async (ms) => sleeps.push(ms),
    now: () => NOW,
  });
});

afterEach(async () => {
  await new Promise((resolve) => orderServer.close(resolve));
  await orderPool.end();
  await paymentPool.end();
});

async function createOrder(fields = {}) {
  const res = await request(orderServer)
    .post('/orders')
    .set('Authorization', `Bearer ${ORDER_TOKEN}`)
    .send({ customer_id: '6f1c2b0e-7f43-4a51-9a8e-2d6f3c1b9e01', total_amount: 129900, currency: 'INR', ...fields });
  assert.equal(res.status, 201);
  return res.body;
}

const paymentBody = (order, fields = {}) => ({
  order_id: order.id,
  amount: order.total_amount,
  currency: order.currency,
  payment_method: 'card',
  ...fields,
});

const initiate = (body, key = 'idem-key-1') => {
  const req = request(app).post('/payments').set('Authorization', AUTH);
  if (key !== null) req.set('Idempotency-Key', key);
  return req.send(body);
};

const countRows = async (table) => (await paymentPool.query(`select count(*)::int as n from ${table}`)).rows[0].n;
const auditFor = async (paymentId) =>
  (await paymentPool.query('select * from audit_log_entries where payment_id = $1', [paymentId])).rows;

describe('POST /payments — authentication (REQ-011)', () => {
  it('rejects a request without a bearer token with 401 before any order lookup or gateway call', async () => {
    const order = await createOrder();
    const res = await request(app).post('/payments').set('Idempotency-Key', 'k').send(paymentBody(order));
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthorized');
    assert.equal(gateway.calls.length, 0);
    assert.equal(await countRows('payments'), 0);
  });

  it('rejects an unknown bearer token with 401', async () => {
    const order = await createOrder();
    const res = await request(app)
      .post('/payments')
      .set('Authorization', 'Bearer nope')
      .set('Idempotency-Key', 'k')
      .send(paymentBody(order));
    assert.equal(res.status, 401);
  });
});

describe('POST /payments — validation (REQ-002, REQ-003)', () => {
  for (const field of ['order_id', 'amount', 'currency', 'payment_method']) {
    it(`rejects a missing ${field} with 400`, async () => {
      const order = await createOrder();
      const body = paymentBody(order);
      delete body[field];
      const res = await initiate(body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_failed');
      assert.deepEqual(res.body.error.details, [{ field, message: 'is required' }]);
      assert.equal(await countRows('payments'), 0);
    });
  }

  it('rejects a missing Idempotency-Key header with 400', async () => {
    const order = await createOrder();
    const res = await initiate(paymentBody(order), null);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.error.details, [{ field: 'Idempotency-Key', message: 'header is required' }]);
  });

  it('rejects malformed field values with 400', async () => {
    const res = await initiate({ order_id: 'x', amount: -5, currency: 'inr', payment_method: 'Credit Card' });
    assert.equal(res.status, 400);
    assert.deepEqual(
      res.body.error.details.map((d) => d.field),
      ['order_id', 'amount', 'currency', 'payment_method'],
    );
  });

  it('rejects an order id that does not exist with 404 and creates no payment', async () => {
    const res = await initiate({
      order_id: '00000000-0000-4000-8000-000000000000',
      amount: 100,
      currency: 'INR',
      payment_method: 'card',
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'order_not_found');
    assert.equal(await countRows('payments'), 0);
    assert.equal(gateway.calls.length, 0);
  });

  it("rejects an amount that differs from the order's trusted total with 422", async () => {
    const order = await createOrder({ total_amount: 129900 });
    const res = await initiate(paymentBody(order, { amount: 100 }));
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'amount_mismatch');
    assert.deepEqual(res.body.error.details, [{ field: 'amount', message: 'does not match the order payable amount' }]);
    assert.equal(await countRows('payments'), 0);
    assert.equal(gateway.calls.length, 0);
  });

  it("rejects a currency that differs from the order's currency with 422", async () => {
    const order = await createOrder({ currency: 'INR' });
    const res = await initiate(paymentBody(order, { currency: 'USD' }));
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.error.details, [{ field: 'currency', message: 'does not match the order currency' }]);
  });

  it('validates against order-service data, ignoring client-sent server-owned fields', async () => {
    const order = await createOrder({ total_amount: 5000 });
    const res = await initiate(
      paymentBody(order, {
        id: '00000000-0000-4000-8000-000000000000',
        status: 'SUCCESS',
        gateway_name: 'evil',
        gateway_reference: 'forged',
        idempotency_key: 'other',
      }),
    );
    assert.equal(res.status, 201);
    assert.notEqual(res.body.id, '00000000-0000-4000-8000-000000000000');
    assert.equal(res.body.status, 'INITIATED');
    assert.equal(res.body.gateway_name, 'razorpay');
    assert.equal(res.body.gateway_reference, `txn_${res.body.id}`);
    assert.equal(res.body.idempotency_key, 'idem-key-1');
    assert.equal(gateway.calls[0].payment.amount, 5000);
  });

  it('rejects an order that can no longer be paid with 409', async () => {
    const order = await createOrder();
    await orderPool.query(`update orders set status = 'PAID' where id = $1`, [order.id]);
    const res = await initiate(paymentBody(order));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'order_not_payable');
    assert.equal(await countRows('payments'), 0);
  });

  it('returns 503 when order-service cannot be reached, creating nothing', async () => {
    const order = await createOrder();
    orderClientDown = true;
    const res = await initiate(paymentBody(order));
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'order_service_unavailable');
    assert.equal(await countRows('payments'), 0);
  });
});

describe('POST /payments — creation and checkout (REQ-004, REQ-005)', () => {
  it('creates an INITIATED payment, stores the checkout session and gateway reference, and audits it', async () => {
    const order = await createOrder();
    const res = await initiate(paymentBody(order));

    assert.equal(res.status, 201);
    assert.match(res.body.id, UUID_RE);
    assert.equal(res.headers.location, `/payments/${res.body.id}`);
    assert.equal(res.body.order_id, order.id);
    assert.equal(res.body.amount, 129900);
    assert.equal(res.body.currency, 'INR');
    assert.equal(res.body.payment_method, 'card');
    assert.equal(res.body.status, 'INITIATED');
    assert.equal(res.body.gateway_reference, `txn_${res.body.id}`);
    assert.equal(res.body.created_at, NOW.toISOString());
    assert.deepEqual(res.body.checkout_session, {
      id: res.body.checkout_session.id,
      payment_id: res.body.id,
      gateway_session_id: `cs_${res.body.id}`,
      checkout_url: `https://checkout.example/${res.body.id}`,
      status: 'ACTIVE',
      expires_at: new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
      created_at: NOW.toISOString(),
    });

    const { rows } = await paymentPool.query('select * from payments where id = $1', [res.body.id]);
    assert.equal(rows[0].status, 'INITIATED');
    assert.equal(rows[0].gateway_reference, `txn_${res.body.id}`);
    const sessions = await paymentPool.query('select * from checkout_sessions where payment_id = $1', [res.body.id]);
    assert.equal(sessions.rows.length, 1);

    const audit = await auditFor(res.body.id);
    const initiated = audit.find((e) => e.event_type === 'PAYMENT_INITIATED');
    assert.equal(initiated.previous_status, null);
    assert.equal(initiated.new_status, 'INITIATED');
    assert.equal(initiated.actor, 'system');
    assert.ok(audit.some((e) => e.event_type === 'CHECKOUT_SESSION_CREATED'));
  });

  it('passes decrypted credentials, the payment and the bounded expiry to the gateway', async () => {
    const order = await createOrder();
    const res = await initiate(paymentBody(order));
    assert.equal(gateway.calls.length, 1);
    const call = gateway.calls[0];
    assert.deepEqual(call.credentials, { keyId: 'rzp_key', keySecret: KEY_SECRET });
    assert.equal(call.payment.id, res.body.id);
    assert.equal(call.expiresAt.toISOString(), res.body.checkout_session.expires_at);
  });

  it('assigns a distinct payment id to every payment', async () => {
    const ids = new Set();
    for (let i = 0; i < 4; i++) {
      const order = await createOrder();
      const res = await initiate(paymentBody(order), `key-${i}`);
      assert.equal(res.status, 201);
      ids.add(res.body.id);
    }
    assert.equal(ids.size, 4);
  });

  it('never stores the gateway credentials in payment-db (REQ-011)', async () => {
    const order = await createOrder();
    await initiate(paymentBody(order));
    for (const table of ['payments', 'checkout_sessions', 'audit_log_entries']) {
      const { rows } = await paymentPool.query(`select * from ${table}`);
      assert.ok(!JSON.stringify(rows).includes(KEY_SECRET), `${table} contains the gateway secret`);
    }
  });
});

describe('POST /payments — idempotency (REQ-010)', () => {
  it('returns the existing payment with 200 when the same request is submitted twice', async () => {
    const order = await createOrder();
    const first = await initiate(paymentBody(order), 'same-key');
    const second = await initiate(paymentBody(order), 'same-key');

    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.equal(gateway.calls.length, 1);
    assert.equal(await countRows('payments'), 1);
    assert.equal(await countRows('checkout_sessions'), 1);
  });

  it('rejects reuse of an Idempotency-Key for a different request with 422', async () => {
    const order = await createOrder();
    await initiate(paymentBody(order), 'same-key');
    const res = await initiate(paymentBody(order, { payment_method: 'upi' }), 'same-key');
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'idempotency_key_reused');
    assert.deepEqual(res.body.error.details.map((d) => d.field), ['payment_method']);
    assert.equal(await countRows('payments'), 1);
  });

  it('refuses a second in-progress payment for the same order under a new key with 409', async () => {
    const order = await createOrder();
    await initiate(paymentBody(order), 'key-a');
    const res = await initiate(paymentBody(order), 'key-b');
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'payment_in_progress');
    assert.equal(await countRows('payments'), 1);
    assert.equal(gateway.calls.length, 1);
  });

  it('handles concurrent submissions of the same key without creating two payments', async () => {
    const order = await createOrder();
    const results = await Promise.all([initiate(paymentBody(order), 'race'), initiate(paymentBody(order), 'race')]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
    assert.equal(results[0].body.id, results[1].body.id);
    assert.equal(await countRows('payments'), 1);
  });
});

describe('POST /payments — gateway failures (REQ-010, NFR-004)', () => {
  const timeout = () => new UpstreamError('payment gateway timed out', { retryable: true });

  it('retries a transient failure with exponential backoff and succeeds', async () => {
    gateway.script = [timeout()];
    const order = await createOrder();
    const res = await initiate(paymentBody(order));
    assert.equal(res.status, 201);
    assert.equal(gateway.calls.length, 2);
    assert.deepEqual(sleeps, [200]);
    // Every attempt is for the same payment, so the gateway can dedupe on it.
    assert.equal(gateway.calls[0].payment.id, gateway.calls[1].payment.id);
  });

  it('returns 502 after 3 failed attempts and leaves the payment recorded as INITIATED for reconciliation', async () => {
    gateway.script = [timeout(), timeout(), timeout()];
    const order = await createOrder();
    const res = await initiate(paymentBody(order));

    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'gateway_unavailable');
    assert.equal(gateway.calls.length, 3);
    assert.deepEqual(sleeps, [200, 400]);

    const { rows } = await paymentPool.query('select * from payments');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'INITIATED');
    assert.equal(rows[0].gateway_reference, null);
    assert.equal(await countRows('checkout_sessions'), 0);

    const failure = (await auditFor(rows[0].id)).find((e) => e.event_type === 'GATEWAY_CALL_FAILED');
    assert.ok(failure);
    assert.equal(failure.metadata.attempts, 3);
    assert.equal(failure.metadata.retryable, true);
  });

  it('resumes the same payment when the client retries with the same key after a 502', async () => {
    gateway.script = [timeout(), timeout(), timeout()];
    const order = await createOrder();
    const failed = await initiate(paymentBody(order), 'retry-key');
    assert.equal(failed.status, 502);

    const retried = await initiate(paymentBody(order), 'retry-key');
    assert.equal(retried.status, 200);
    assert.equal(retried.body.status, 'INITIATED');
    assert.ok(retried.body.checkout_session);
    assert.equal(await countRows('payments'), 1);
    assert.equal(new Set(gateway.calls.map((c) => c.payment.id)).size, 1);
  });

  it('does not retry a definitive gateway rejection, marks the payment FAILED and audits the change', async () => {
    gateway.script = [new UpstreamError('payment gateway rejected the checkout request (400)', { status: 400 })];
    const order = await createOrder();
    const res = await initiate(paymentBody(order), 'rejected');
    assert.equal(res.status, 502);
    assert.equal(gateway.calls.length, 1);

    const { rows } = await paymentPool.query('select * from payments');
    assert.equal(rows[0].status, 'FAILED');
    const change = (await auditFor(rows[0].id)).find((e) => e.event_type === 'GATEWAY_REJECTED');
    assert.equal(change.previous_status, 'INITIATED');
    assert.equal(change.new_status, 'FAILED');

    // The order is free for a fresh attempt.
    const again = await initiate(paymentBody(order), 'second-attempt');
    assert.equal(again.status, 201);
  });
});

describe('GET /payments/{paymentId}', () => {
  it('returns the payment with its checkout session', async () => {
    const order = await createOrder();
    const created = await initiate(paymentBody(order));
    const res = await request(app).get(`/payments/${created.body.id}`).set('Authorization', AUTH);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, created.body);
  });

  it('requires a bearer token', async () => {
    const res = await request(app).get('/payments/00000000-0000-4000-8000-000000000000');
    assert.equal(res.status, 401);
  });

  it('returns 404 for an unknown or malformed id', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const res = await request(app).get(`/payments/${id}`).set('Authorization', AUTH);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'payment_not_found');
    }
  });
});
