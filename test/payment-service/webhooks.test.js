import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp as createOrderApp } from '../../src/order-service/app.js';
import { createOrderRepository } from '../../src/order-service/orderRepository.js';
import { createApp } from '../../src/payment-service/app.js';
import { parseWebhookPayload, signWebhookPayload, verifyWebhookSignature } from '../../src/payment-service/gateway.js';
import { createOrderClient } from '../../src/payment-service/orderClient.js';
import { createPaymentRepository } from '../../src/payment-service/paymentRepository.js';
import { createEncryptedSecretsManager, encryptSecret } from '../../src/shared/secrets.js';
import { createTestPool } from '../helpers/db.js';

const TOKEN = 'payment-test-token';
const ORDER_TOKEN = 'order-service-token';
const ORDER_API_KEY = 'order-internal-key';
const WEBHOOK_SECRET = 'whsec_test_signing_secret';
const NOW = new Date('2026-10-19T10:00:00.000Z');

let orderPool;
let paymentPool;
let orderServer;
let app;
let orderDown;
let orderCalls;
let sleeps;

beforeEach(async () => {
  orderPool = await createTestPool('order-db');
  paymentPool = await createTestPool('payment-db');
  const orderApp = createOrderApp({
    orders: createOrderRepository(orderPool),
    bearerTokens: [ORDER_TOKEN],
    apiKeys: [ORDER_API_KEY],
  });
  orderServer = await new Promise((resolve) => {
    const s = orderApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  orderDown = false;
  orderCalls = [];
  sleeps = [];
  const orders = createOrderClient({
    baseUrl: `http://127.0.0.1:${orderServer.address().port}`,
    token: ORDER_TOKEN,
    apiKey: ORDER_API_KEY,
    retryPolicy: { attempts: 3, baseDelayMs: 10, factor: 2 },
    sleep: async (ms) => sleeps.push(ms),
    // Simulates order-service being unreachable while `orderDown` is set.
    fetchImpl: async (url, init) => {
      orderCalls.push({ url, method: init.method, headers: init.headers, body: init.body });
      if (orderDown) throw new TypeError('fetch failed');
      return fetch(url, init);
    },
  });

  const masterKey = randomBytes(32).toString('base64');
  const secrets = createEncryptedSecretsManager({
    encryptedGatewayCredentials: encryptSecret(JSON.stringify({ key_id: 'k', key_secret: 's' }), masterKey),
    encryptedWebhookSecret: encryptSecret(WEBHOOK_SECRET, masterKey),
    masterKey,
  });
  const gateway = {
    name: 'razorpay',
    async createCheckoutSession({ payment }) {
      return {
        gatewaySessionId: `cs_${payment.id}`,
        gatewayReference: `txn_${payment.id}`,
        checkoutUrl: `https://checkout.example/${payment.id}`,
      };
    },
  };
  app = createApp({
    payments: createPaymentRepository(paymentPool),
    orders,
    gateway,
    secrets,
    bearerTokens: [TOKEN],
    sleep: async () => {},
    now: () => NOW,
  });
});

afterEach(async () => {
  await new Promise((resolve) => orderServer.close(resolve));
  await orderPool.end();
  await paymentPool.end();
});

async function createOrder() {
  const res = await request(orderServer)
    .post('/orders')
    .set('Authorization', `Bearer ${ORDER_TOKEN}`)
    .send({ customer_id: '6f1c2b0e-7f43-4a51-9a8e-2d6f3c1b9e01', total_amount: 129900, currency: 'INR' });
  assert.equal(res.status, 201);
  return res.body;
}

/** An order with an INITIATED payment that has a checkout session. */
async function setup() {
  const order = await createOrder();
  const res = await request(app)
    .post('/payments')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Idempotency-Key', `idem-${order.id}`)
    .send({ order_id: order.id, amount: order.total_amount, currency: order.currency, payment_method: 'card' });
  assert.equal(res.status, 201);
  orderCalls.length = 0;
  return { order, payment: res.body };
}

let eventSeq = 0;
const eventFor = (payment, fields = {}) => ({
  event_id: `evt_${++eventSeq}`,
  payment_id: payment.id,
  gateway_reference: payment.gateway_reference,
  status: 'captured',
  amount: payment.amount,
  currency: payment.currency,
  ...fields,
});

/** Delivers `body` signed with `secret` (or with an explicit `signature`; null = no header). */
function deliver(body, { secret = WEBHOOK_SECRET, signature } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const req = request(app).post('/webhooks/payments').set('Content-Type', 'application/json');
  const sig = signature === undefined ? signWebhookPayload(raw, secret) : signature;
  if (sig !== null) req.set('X-Gateway-Signature', sig);
  return req.send(raw);
}

const getPayment = async (id) =>
  (await request(app).get(`/payments/${id}`).set('Authorization', `Bearer ${TOKEN}`)).body;
const getOrder = async (id) =>
  (await request(orderServer).get(`/orders/${id}`).set('Authorization', `Bearer ${ORDER_TOKEN}`)).body;
const countRows = async (table) => (await paymentPool.query(`select count(*)::int as n from ${table}`)).rows[0].n;
const webhookEvents = async () => (await paymentPool.query('select * from webhook_events')).rows;
const auditFor = async (paymentId) =>
  (await paymentPool.query('select * from audit_log_entries where payment_id = $1', [paymentId])).rows;

/** Status-changing audit entries chain from PAYMENT_INITIATED to the current status (REQ-011). */
async function assertAuditTrailComplete(paymentId) {
  const { status } = await getPayment(paymentId);
  const entries = await auditFor(paymentId);
  const changes = entries.filter((e) => e.previous_status === null || e.previous_status !== e.new_status);
  const creation = changes.filter((e) => e.previous_status === null);
  assert.equal(creation.length, 1);
  assert.equal(creation[0].event_type, 'PAYMENT_INITIATED');
  let current = creation[0].new_status;
  const remaining = changes.filter((e) => e !== creation[0]);
  while (remaining.length) {
    const i = remaining.findIndex((e) => e.previous_status === current);
    assert.ok(i >= 0, `no audit entry continues the chain from ${current}`);
    current = remaining.splice(i, 1)[0].new_status;
  }
  assert.equal(current, status);
}

describe('POST /webhooks/payments — signature verification (REQ-007, REQ-011)', () => {
  it('rejects a webhook without a signature with 400 and does not apply or record it', async () => {
    const { order, payment } = await setup();
    const auditBefore = (await auditFor(payment.id)).length;
    const res = await deliver(eventFor(payment), { signature: null });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_signature');
    assert.equal((await getPayment(payment.id)).status, 'INITIATED');
    assert.equal((await getOrder(order.id)).status, 'PENDING_PAYMENT');
    assert.equal(await countRows('webhook_events'), 0);
    assert.equal((await auditFor(payment.id)).length, auditBefore);
    assert.equal(orderCalls.length, 0);
  });

  it('rejects a signature made with another secret, a malformed one, and a tampered body', async () => {
    const { payment } = await setup();
    const event = eventFor(payment);
    assert.equal((await deliver(event, { secret: 'not-the-secret' })).status, 400);
    assert.equal((await deliver(event, { signature: 'garbage' })).status, 400);
    assert.equal((await deliver(event, { signature: '' })).status, 400);
    // Signed one body, sent another (status changed in transit).
    const signature = signWebhookPayload(JSON.stringify(event), WEBHOOK_SECRET);
    assert.equal((await deliver({ ...event, status: 'failed' }, { signature })).status, 400);
    assert.equal((await getPayment(payment.id)).status, 'INITIATED');
    assert.equal(await countRows('webhook_events'), 0);
  });

  it('an unsigned delivery cannot claim a real event id (the signed one is still applied)', async () => {
    const { payment } = await setup();
    const event = eventFor(payment);
    assert.equal((await deliver(event, { secret: 'attacker' })).status, 400);
    assert.equal((await deliver(event)).status, 200);
    assert.equal((await getPayment(payment.id)).status, 'SUCCESS');
  });

  it('accepts a "sha256=" prefixed signature and needs no bearer token', async () => {
    const { payment } = await setup();
    const event = eventFor(payment);
    const raw = JSON.stringify(event);
    const res = await deliver(raw, { signature: `sha256=${signWebhookPayload(raw, WEBHOOK_SECRET)}` });
    assert.equal(res.status, 200);
  });

  it('rejects a signed but malformed payload with 400 validation_failed', async () => {
    const { payment } = await setup();
    const res = await deliver({ event_id: 'evt_x', payment_id: payment.id, status: 'teleported', amount: -1 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_failed');
    const fields = res.body.error.details.map((d) => d.field);
    assert.ok(fields.includes('status') && fields.includes('amount') && fields.includes('currency'));
    assert.equal(await countRows('webhook_events'), 0);
  });
});

describe('POST /webhooks/payments — transaction details (REQ-007)', () => {
  for (const [name, fields, field] of [
    ['amount', { amount: 1 }, 'amount'],
    ['currency', { currency: 'USD' }, 'currency'],
    ['gateway reference', { gateway_reference: 'txn_someone_else' }, 'gateway_reference'],
  ]) {
    it(`rejects a ${name} mismatch with 422 and leaves the payment unchanged`, async () => {
      const { order, payment } = await setup();
      const res = await deliver(eventFor(payment, fields));
      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'transaction_mismatch');
      assert.deepEqual(res.body.error.details.map((d) => d.field), [field]);
      assert.equal((await getPayment(payment.id)).status, 'INITIATED');
      assert.equal((await getOrder(order.id)).status, 'PENDING_PAYMENT');
      const [event] = await webhookEvents();
      assert.equal(event.status, 'REJECTED');
      assert.equal(event.outcome, 'details_mismatch');
      assert.equal(event.payment_id, payment.id);
      assert.equal(event.signature_valid, true);
      assert.ok(event.processed_at);
      const audit = (await auditFor(payment.id)).find((e) => e.event_type === 'WEBHOOK_REJECTED');
      assert.equal(audit.actor, 'gateway_webhook');
      assert.equal(audit.new_status, 'INITIATED');
      assert.equal(orderCalls.length, 0);
    });
  }

  it('rejects an event for an unknown payment with 422 and records it with a null payment_id', async () => {
    await setup();
    const res = await deliver({
      event_id: 'evt_unknown',
      payment_id: '00000000-0000-4000-8000-000000000000',
      status: 'captured',
      amount: 100,
      currency: 'INR',
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'unknown_payment');
    const [event] = await webhookEvents();
    assert.equal(event.payment_id, null);
    assert.equal(event.outcome, 'unknown_payment');
    // A redelivery gets the same answer.
    assert.equal((await deliver({ ...event.raw_payload })).status, 422);
  });

  it('matches the payment by gateway_reference when payment_id is absent', async () => {
    const { payment } = await setup();
    const res = await deliver(eventFor(payment, { payment_id: undefined }));
    assert.equal(res.status, 200);
    assert.equal(res.body.payment_id, payment.id);
    assert.equal((await getPayment(payment.id)).status, 'SUCCESS');
  });
});

describe('POST /webhooks/payments — applying the outcome (REQ-008, REQ-009, REQ-011)', () => {
  it('a completed transaction sets SUCCESS, completes the session and marks the order PAID', async () => {
    const { order, payment } = await setup();
    const res = await deliver(eventFor(payment, { status: 'captured' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'APPLIED');
    assert.equal(res.body.outcome, 'applied');
    assert.equal(res.body.payment_status, 'SUCCESS');
    assert.ok(res.body.processed_at);

    const stored = await getPayment(payment.id);
    assert.equal(stored.status, 'SUCCESS');
    assert.equal(stored.checkout_session.status, 'COMPLETED');
    assert.equal((await getOrder(order.id)).status, 'PAID');

    const patch = orderCalls.find((c) => c.method === 'PATCH');
    assert.equal(patch.headers['x-api-key'], ORDER_API_KEY);
    assert.deepEqual(JSON.parse(patch.body), { status: 'PAID' });

    const applied = (await auditFor(payment.id)).find((e) => e.event_type === 'WEBHOOK_APPLIED');
    assert.equal(applied.previous_status, 'INITIATED');
    assert.equal(applied.new_status, 'SUCCESS');
    assert.equal(applied.actor, 'gateway_webhook');
    await assertAuditTrailComplete(payment.id);

    const [event] = await webhookEvents();
    assert.equal(event.status, 'APPLIED');
    assert.equal(event.raw_payload.event_id, res.body.gateway_event_id);
  });

  it('a declined transaction sets FAILED and marks the order PAYMENT_FAILED', async () => {
    const { order, payment } = await setup();
    const res = await deliver(eventFor(payment, { status: 'declined' }));
    assert.equal(res.status, 200);
    assert.equal((await getPayment(payment.id)).status, 'FAILED');
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');
    await assertAuditTrailComplete(payment.id);
  });

  it('an unresolved transaction sets PENDING without notifying the order; a later success resolves it', async () => {
    const { order, payment } = await setup();
    const pending = await deliver(eventFor(payment, { status: 'pending' }));
    assert.equal(pending.status, 200);
    assert.equal(pending.body.payment_status, 'PENDING');
    assert.equal((await getPayment(payment.id)).status, 'PENDING');
    assert.equal((await getOrder(order.id)).status, 'PENDING_PAYMENT');
    assert.equal(orderCalls.length, 0);

    assert.equal((await deliver(eventFor(payment, { status: 'succeeded' }))).status, 200);
    assert.equal((await getPayment(payment.id)).status, 'SUCCESS');
    assert.equal((await getOrder(order.id)).status, 'PAID');
    await assertAuditTrailComplete(payment.id);
  });

  it('a failed payment can be followed by a successful retry payment for the same order', async () => {
    const { order, payment } = await setup();
    await deliver(eventFor(payment, { status: 'failed' }));
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');
    const retry = await request(app)
      .post('/payments')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Idempotency-Key', 'retry-key')
      .send({ order_id: order.id, amount: order.total_amount, currency: order.currency, payment_method: 'upi' });
    assert.equal(retry.status, 201);
    await deliver(eventFor(retry.body));
    assert.equal((await getOrder(order.id)).status, 'PAID');
  });
});

describe('POST /webhooks/payments — duplicates and ordering (REQ-010)', () => {
  it('a redelivered event is acknowledged but not applied twice', async () => {
    const { payment } = await setup();
    const event = eventFor(payment);
    const first = await deliver(event);
    const auditAfterFirst = (await auditFor(payment.id)).length;
    const patchesAfterFirst = orderCalls.length;
    const again = await deliver(event);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);
    assert.equal(again.body.payment_status, 'SUCCESS');
    assert.equal(await countRows('webhook_events'), 1);
    assert.equal((await auditFor(payment.id)).length, auditAfterFirst);
    assert.equal(orderCalls.length, patchesAfterFirst);
  });

  it('a different event repeating the current outcome is a no-op status-wise (re-notifies idempotently)', async () => {
    const { order, payment } = await setup();
    await deliver(eventFor(payment));
    const res = await deliver(eventFor(payment));
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'unchanged');
    assert.equal((await auditFor(payment.id)).filter((e) => e.event_type === 'WEBHOOK_APPLIED').length, 1);
    assert.equal((await getOrder(order.id)).status, 'PAID');
  });

  it('a PENDING event arriving after the final outcome is ignored (stale)', async () => {
    const { payment } = await setup();
    await deliver(eventFor(payment));
    const res = await deliver(eventFor(payment, { status: 'pending' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.outcome, 'stale');
    assert.equal((await getPayment(payment.id)).status, 'SUCCESS');
    assert.ok((await auditFor(payment.id)).some((e) => e.event_type === 'WEBHOOK_IGNORED'));
    await assertAuditTrailComplete(payment.id);
  });

  it('an outcome contradicting a final status is not applied and is audited as a conflict', async () => {
    const { order, payment } = await setup();
    await deliver(eventFor(payment));
    const res = await deliver(eventFor(payment, { status: 'failed' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'conflict');
    assert.equal((await getPayment(payment.id)).status, 'SUCCESS');
    assert.equal((await getOrder(order.id)).status, 'PAID');
    const conflict = (await auditFor(payment.id)).find((e) => e.event_type === 'WEBHOOK_CONFLICT');
    assert.equal(conflict.metadata.reported_status, 'FAILED');
  });
});

describe('POST /webhooks/payments — order notification failures (REQ-009, NFR-004)', () => {
  it('retries an unreachable order-service, answers 503, and a redelivery completes the notification', async () => {
    const { order, payment } = await setup();
    const event = eventFor(payment);
    orderDown = true;
    const res = await deliver(event);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'order_service_unavailable');
    assert.equal(orderCalls.filter((c) => c.method === 'PATCH').length, 3);
    assert.deepEqual(sleeps, [10, 20]);
    // The payment outcome is kept; the event waits to be finished.
    assert.equal((await getPayment(payment.id)).status, 'SUCCESS');
    assert.equal((await webhookEvents())[0].status, 'VERIFIED');
    assert.ok((await auditFor(payment.id)).some((e) => e.event_type === 'ORDER_NOTIFICATION_FAILED'));

    orderDown = false;
    const redelivered = await deliver(event);
    assert.equal(redelivered.status, 200);
    assert.equal(redelivered.body.status, 'APPLIED');
    assert.equal((await getOrder(order.id)).status, 'PAID');
    assert.equal((await auditFor(payment.id)).filter((e) => e.event_type === 'WEBHOOK_APPLIED').length, 1);
    await assertAuditTrailComplete(payment.id);
  });

  it('an order that moved on (409) is acknowledged and audited, not retried', async () => {
    const { order, payment } = await setup();
    const cancel = await request(orderServer)
      .patch(`/orders/${order.id}/status`)
      .set('X-API-Key', ORDER_API_KEY)
      .send({ status: 'CANCELLED' });
    assert.equal(cancel.status, 200);
    orderCalls.length = 0;
    const res = await deliver(eventFor(payment));
    assert.equal(res.status, 200);
    assert.equal(orderCalls.length, 1);
    assert.equal((await getPayment(payment.id)).status, 'SUCCESS');
    assert.equal((await getOrder(order.id)).status, 'CANCELLED');
    const rejected = (await auditFor(payment.id)).find((e) => e.event_type === 'ORDER_NOTIFICATION_REJECTED');
    assert.equal(rejected.metadata.order_service_outcome, 'conflict');
  });
});

describe('webhook helpers (gateway boundary)', () => {
  it('verifies HMAC-SHA256 signatures in constant time', () => {
    const raw = Buffer.from('{"a":1}');
    const sig = signWebhookPayload(raw, 'k');
    assert.equal(verifyWebhookSignature({ rawBody: raw, signature: sig, secret: 'k' }), true);
    assert.equal(verifyWebhookSignature({ rawBody: raw, signature: sig.toUpperCase(), secret: 'k' }), true);
    assert.equal(verifyWebhookSignature({ rawBody: raw, signature: sig, secret: 'other' }), false);
    assert.equal(verifyWebhookSignature({ rawBody: undefined, signature: sig, secret: 'k' }), false);
    assert.equal(verifyWebhookSignature({ rawBody: raw, signature: undefined, secret: 'k' }), false);
  });

  it('maps provider transaction states to payment statuses', () => {
    const base = { event_id: 'e', payment_id: 'p', amount: 1, currency: 'inr' };
    for (const [status, expected] of [
      ['captured', 'SUCCESS'],
      ['SUCCEEDED', 'SUCCESS'],
      ['declined', 'FAILED'],
      ['failed', 'FAILED'],
      ['pending', 'PENDING'],
      ['processing', 'PENDING'],
    ]) {
      assert.equal(parseWebhookPayload({ ...base, status }).value.status, expected);
    }
    assert.equal(parseWebhookPayload({ ...base, status: 'captured' }).value.currency, 'INR');
    assert.ok(parseWebhookPayload({ ...base, status: 'constructor' }).errors);
    assert.ok(parseWebhookPayload({ ...base, payment_id: undefined, status: 'captured' }).errors);
  });
});
