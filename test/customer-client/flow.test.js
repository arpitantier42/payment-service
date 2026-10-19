import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp as createClientApp } from '../../src/customer-client/app.js';
import { checkoutAction } from '../../src/customer-client/public/checkout.js';
import { createApp as createOrderApp } from '../../src/order-service/app.js';
import { createOrderRepository } from '../../src/order-service/orderRepository.js';
import { createApp as createPaymentApp } from '../../src/payment-service/app.js';
import { createMockGateway } from '../../src/payment-service/gateway.js';
import { createOrderClient } from '../../src/payment-service/orderClient.js';
import { createPaymentRepository } from '../../src/payment-service/paymentRepository.js';
import { createEncryptedSecretsManager, encryptSecret } from '../../src/shared/secrets.js';
import { createTestPool } from '../helpers/db.js';

// End-to-end: customer-client -> order-service + payment-service (pg-mem), with the mock gateway
// whose checkout_url points at the client's dev hosted-checkout page, which delivers the signed
// webhook back to payment-service.

const ORDER_TOKEN = 'order-token';
const ORDER_API_KEY = 'order-internal-key';
const PAYMENT_TOKEN = 'payment-token';
const WEBHOOK_SECRET = 'whsec_flow_test';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TTL_MS = 15 * 60 * 1000;

let orderPool;
let paymentPool;
let servers;
let client;
let clientBase;
let clock;
let upstreamDown;

const listen = (app) =>
  new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
const base = (server) => `http://127.0.0.1:${server.address().port}`;

beforeEach(async () => {
  clock = new Date('2026-10-19T10:00:00.000Z');
  const now = () => new Date(clock);
  upstreamDown = false;
  orderPool = await createTestPool('order-db');
  paymentPool = await createTestPool('payment-db');

  const orderServer = await listen(
    createOrderApp({ orders: createOrderRepository(orderPool), bearerTokens: [ORDER_TOKEN], apiKeys: [ORDER_API_KEY], now }),
  );

  const masterKey = randomBytes(32).toString('base64');
  const secrets = createEncryptedSecretsManager({
    encryptedGatewayCredentials: encryptSecret(JSON.stringify({ key_id: 'k', key_secret: 's' }), masterKey),
    encryptedWebhookSecret: encryptSecret(WEBHOOK_SECRET, masterKey),
    masterKey,
  });
  // The client's URL is known only once it listens; the mock gateway reads it per call.
  const gateway = {
    name: 'mock',
    createCheckoutSession: (args) => createMockGateway({ checkoutBaseUrl: `${clientBase}/mock-checkout` }).createCheckoutSession(args),
  };
  const paymentServer = await listen(
    createPaymentApp({
      payments: createPaymentRepository(paymentPool),
      orders: createOrderClient({
        baseUrl: base(orderServer),
        token: ORDER_TOKEN,
        apiKey: ORDER_API_KEY,
        retryPolicy: { attempts: 1 },
      }),
      gateway,
      secrets,
      bearerTokens: [PAYMENT_TOKEN],
      checkoutTtlMs: TTL_MS,
      sleep: async () => {},
      now,
    }),
  );

  const clientServer = await listen(
    createClientApp({
      orderServiceUrl: base(orderServer),
      orderServiceToken: ORDER_TOKEN,
      paymentServiceUrl: base(paymentServer),
      paymentServiceToken: PAYMENT_TOKEN,
      fetchImpl: (url, init) => (upstreamDown ? Promise.reject(new TypeError('fetch failed')) : fetch(url, init)),
      mockCheckout: { webhookUrl: `${base(paymentServer)}/webhooks/payments`, getWebhookSecret: async () => WEBHOOK_SECRET },
      now,
    }),
  );
  clientBase = base(clientServer);
  client = request(clientServer);
  servers = [orderServer, paymentServer, clientServer];
});

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  await orderPool.end();
  await paymentPool.end();
});

async function placeOrder(total = 54800) {
  const res = await client.post('/api/orders').send({ customer_id: randomUUID(), total_amount: total, currency: 'INR' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

function initiate(order, { method = 'card', key = randomUUID(), body } = {}) {
  return client
    .post('/api/payments')
    .set('Idempotency-Key', key)
    .send(body ?? { order_id: order.id, amount: order.total_amount, currency: order.currency, payment_method: method });
}

const paymentCount = async () => Number((await paymentPool.query('select count(*)::int as n from payments')).rows[0].n);
const checkoutPath = (payment) => new URL(payment.checkout_session.checkout_url).pathname;

describe('customer-client: place order (REQ-001)', () => {
  it('creates a PENDING_PAYMENT order with a unique UUID the payment service accepts', async () => {
    const a = await placeOrder();
    const b = await placeOrder();
    assert.equal(a.status, 'PENDING_PAYMENT');
    assert.match(a.id, UUID_RE);
    assert.notEqual(a.id, b.id);

    const fetched = await client.get(`/api/orders/${a.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.status, 'PENDING_PAYMENT');
    const rows = await orderPool.query('select status from orders where id = $1', [a.id]);
    assert.equal(rows.rows[0].status, 'PENDING_PAYMENT');

    const payment = await initiate(a);
    assert.equal(payment.status, 201, JSON.stringify(payment.body));
    assert.equal(payment.body.order_id, a.id);
  });

  it('passes order-service validation errors through and ignores client-sent server fields', async () => {
    const bad = await client.post('/api/orders').send({ customer_id: randomUUID(), currency: 'INR' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'validation_failed');
    const res = await client
      .post('/api/orders')
      .send({ customer_id: randomUUID(), total_amount: 100, currency: 'INR', status: 'PAID', id: randomUUID() });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'PENDING_PAYMENT');
  });
});

describe('customer-client: payment initiation (REQ-002)', () => {
  it('rejects a request missing order id, amount, currency or payment method, creating nothing', async () => {
    const order = await placeOrder();
    const full = { order_id: order.id, amount: order.total_amount, currency: order.currency, payment_method: 'card' };
    for (const field of Object.keys(full)) {
      const { [field]: _omitted, ...body } = full;
      const res = await initiate(order, { body });
      assert.equal(res.status, 400, field);
      assert.equal(res.body.error.code, 'validation_failed');
      assert.ok(res.body.error.details.some((d) => d.field === field), field);
    }
    const noKey = await client.post('/api/payments').send(full);
    assert.equal(noKey.status, 400);
    assert.ok(noKey.body.error.details.some((d) => d.field === 'Idempotency-Key'));
    assert.equal(await paymentCount(), 0);
  });

  it('rejects a payment for an order id that does not exist, creating no payment', async () => {
    const res = await initiate(null, { body: { order_id: randomUUID(), amount: 100, currency: 'INR', payment_method: 'card' } });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'order_not_found');
    assert.equal(await paymentCount(), 0);
  });

  it('replays the same payment for a repeated Idempotency-Key', async () => {
    const order = await placeOrder();
    const key = randomUUID();
    const first = await initiate(order, { key });
    const again = await initiate(order, { key });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);
    assert.equal(await paymentCount(), 1);
    assert.equal(first.headers['cache-control'], 'no-store');
  });

  it('answers 503 when a service cannot be reached', async () => {
    upstreamDown = true;
    const res = await client.post('/api/orders').send({ customer_id: randomUUID(), total_amount: 100, currency: 'INR' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'order_service_unavailable');
  });
});

describe('customer-client: hosted checkout completion (REQ-006)', () => {
  it('redirects to the checkout and completes the payment with the method selected at initiation', async () => {
    const order = await placeOrder();
    const init = await initiate(order, { method: 'upi' });
    assert.equal(init.status, 201);
    const next = checkoutAction(init.body, clock);
    assert.equal(next.action, 'redirect');
    assert.equal(next.url, `${clientBase}/mock-checkout/${init.body.id}`);

    const page = await client.get(checkoutPath(init.body));
    assert.equal(page.status, 200);
    assert.match(page.text, /data-testid="method">upi</);
    assert.doesNotMatch(page.text, /value="card"/);

    // A different method than the one chosen at initiation is refused.
    const wrong = await client.post(checkoutPath(init.body)).type('form').send({ payment_method: 'card', outcome: 'pay' });
    assert.equal(wrong.status, 400);

    const done = await client.post(checkoutPath(init.body)).type('form').send({ payment_method: 'upi', outcome: 'pay' });
    assert.equal(done.status, 303);
    assert.equal(done.headers.location, `/?payment_id=${init.body.id}&order_id=${order.id}`);

    const payment = await client.get(`/api/payments/${init.body.id}`);
    assert.equal(payment.body.status, 'SUCCESS');
    assert.equal(payment.body.payment_method, 'upi');
    assert.equal(payment.body.checkout_session.status, 'COMPLETED');
    assert.equal((await client.get(`/api/orders/${order.id}`)).body.status, 'PAID');

    // The completed checkout cannot be used again.
    assert.equal((await client.get(checkoutPath(init.body))).status, 409);
  });

  it('a declined payment fails the payment and the order, and the order can be paid again with a new key', async () => {
    const order = await placeOrder();
    const init = await initiate(order, { method: 'card' });
    const declined = await client.post(checkoutPath(init.body)).type('form').send({ payment_method: 'card', outcome: 'decline' });
    assert.equal(declined.status, 303);
    assert.equal((await client.get(`/api/payments/${init.body.id}`)).body.status, 'FAILED');
    const failedOrder = (await client.get(`/api/orders/${order.id}`)).body;
    assert.equal(failedOrder.status, 'PAYMENT_FAILED');

    const retry = await initiate(failedOrder, { method: 'netbanking' });
    assert.equal(retry.status, 201);
    assert.notEqual(retry.body.id, init.body.id);
  });
});

describe('customer-client: bounded checkout window (REQ-006)', () => {
  it('the session expires after the window: no redirect, and the hosted checkout refuses it', async () => {
    const order = await placeOrder();
    const init = await initiate(order);
    const session = init.body.checkout_session;
    assert.equal(session.status, 'ACTIVE');
    assert.equal(new Date(session.expires_at).getTime() - new Date(init.body.created_at).getTime(), TTL_MS);

    clock = new Date(new Date(session.expires_at).getTime() + 1000);
    assert.deepEqual(checkoutAction(init.body, clock), { action: 'expired' });
    const page = await client.get(checkoutPath(init.body));
    assert.equal(page.status, 410);
    const pay = await client.post(checkoutPath(init.body)).type('form').send({ payment_method: 'card', outcome: 'pay' });
    assert.equal(pay.status, 410);
    assert.notEqual((await client.get(`/api/payments/${init.body.id}`)).body.status, 'SUCCESS');
  });

  it('an invalidated (non-ACTIVE) session is refused before its expiry time', async () => {
    const order = await placeOrder();
    const init = await initiate(order);
    await paymentPool.query(`update checkout_sessions set status = 'EXPIRED' where payment_id = $1`, [init.body.id]);
    const payment = (await client.get(`/api/payments/${init.body.id}`)).body;
    assert.deepEqual(checkoutAction(payment, clock), { action: 'expired' });
    assert.equal((await client.get(checkoutPath(init.body))).status, 410);
  });
});

describe('customer-client: UI shell', () => {
  it('serves the UI with a restrictive CSP and without service credentials', async () => {
    const index = await client.get('/');
    assert.equal(index.status, 200);
    assert.match(index.text, /src="\/ui.js"/);
    assert.match(index.headers['content-security-policy'], /default-src 'self'/);
    for (const asset of ['/ui.js', '/checkout.js']) {
      const res = await client.get(asset);
      assert.equal(res.status, 200, asset);
      assert.match(res.headers['content-type'], /javascript/);
      assert.ok(!res.text.includes(PAYMENT_TOKEN) && !res.text.includes(ORDER_TOKEN));
    }
    assert.equal((await client.get('/api/nope')).status, 404);
  });
});
