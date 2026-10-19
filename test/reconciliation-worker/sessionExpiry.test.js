import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp as createOrderApp } from '../../src/order-service/app.js';
import { createOrderRepository } from '../../src/order-service/orderRepository.js';
import { createApp as createPaymentApp } from '../../src/payment-service/app.js';
import { parseTransactionStatus, signWebhookPayload } from '../../src/payment-service/gateway.js';
import { createOrderClient } from '../../src/payment-service/orderClient.js';
import { createPaymentRepository } from '../../src/payment-service/paymentRepository.js';
import { createApp } from '../../src/reconciliation-worker/app.js';
import { createReconciler } from '../../src/reconciliation-worker/reconciler.js';
import { createSessionExpirer } from '../../src/reconciliation-worker/sessionExpirer.js';
import { createEncryptedSecretsManager, encryptSecret } from '../../src/shared/secrets.js';
import { assertAuditTrailComplete } from '../helpers/audit.js';
import { createTestPool } from '../helpers/db.js';

// OP-008 expireCheckoutSessions: lapsed checkout sessions are expired on elapsed time alone.

const TOKEN = 'payment-test-token';
const ORDER_TOKEN = 'order-service-token';
const ORDER_API_KEY = 'order-internal-key';
const SCHEDULER_KEY = 'scheduler-key';
const T0 = new Date('2026-10-19T10:00:00.000Z');
const TTL_MS = 15 * 60 * 1000;
const GRACE_MS = 60 * 1000;
const RUN = '/internal/payments/session-expiry-runs';
const RECONCILE = '/internal/payments/reconciliation-runs';
const WEBHOOK_SECRET = 'webhook-test-secret';

let clock;
let orderPool;
let paymentPool;
let orderServer;
let paymentApp;
let payments;
let worker;
let orderDown;
let gatewayStatus;
let makeExpirer;

beforeEach(async () => {
  clock = T0;
  const now = () => clock;
  orderPool = await createTestPool('order-db');
  paymentPool = await createTestPool('payment-db');
  orderServer = await new Promise((resolve) => {
    const s = createOrderApp({
      orders: createOrderRepository(orderPool),
      bearerTokens: [ORDER_TOKEN],
      apiKeys: [ORDER_API_KEY],
      now,
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
  orderDown = false;
  const orders = createOrderClient({
    baseUrl: `http://127.0.0.1:${orderServer.address().port}`,
    token: ORDER_TOKEN,
    apiKey: ORDER_API_KEY,
    retryPolicy: { attempts: 2, baseDelayMs: 1, factor: 2 },
    sleep: async () => {},
    fetchImpl: (url, init) => (orderDown && init.method === 'PATCH' ? Promise.reject(new TypeError('fetch failed')) : fetch(url, init)),
  });
  const masterKey = randomBytes(32).toString('base64');
  const secrets = createEncryptedSecretsManager({
    encryptedGatewayCredentials: encryptSecret(JSON.stringify({ key_id: 'k', key_secret: 's' }), masterKey),
    encryptedWebhookSecret: encryptSecret(WEBHOOK_SECRET, masterKey),
    masterKey,
  });
  // The gateway's answer to status queries: "created" = checkout open, customer has not paid.
  gatewayStatus = 'created';
  const gateway = {
    name: 'razorpay',
    async createCheckoutSession({ payment }) {
      return { gatewaySessionId: `cs_${payment.id}`, gatewayReference: `txn_${payment.id}`, checkoutUrl: `https://checkout.example/${payment.id}` };
    },
    async getTransactionStatus() {
      return parseTransactionStatus({ status: gatewayStatus });
    },
  };
  payments = createPaymentRepository(paymentPool);
  paymentApp = createPaymentApp({ payments, orders, gateway, secrets, bearerTokens: [TOKEN], checkoutTtlMs: TTL_MS, sleep: async () => {}, now });
  makeExpirer = (opts = {}) => createSessionExpirer({ payments, orders, graceMs: GRACE_MS, now, ...opts });
  worker = createApp({
    reconciler: createReconciler({ payments, orders, gateway, secrets, sleep: async () => {}, now }),
    sessionExpirer: makeExpirer(),
    apiKeys: [SCHEDULER_KEY],
  });
});

afterEach(async () => {
  await new Promise((resolve) => orderServer.close(resolve));
  await orderPool.end();
  await paymentPool.end();
});

async function initiatedPayment() {
  const order = (
    await request(orderServer)
      .post('/orders')
      .set('Authorization', `Bearer ${ORDER_TOKEN}`)
      .send({ customer_id: '6f1c2b0e-7f43-4a51-9a8e-2d6f3c1b9e01', total_amount: 129900, currency: 'INR' })
  ).body;
  const res = await request(paymentApp)
    .post('/payments')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Idempotency-Key', `idem-${order.id}`)
    .send({ order_id: order.id, amount: order.total_amount, currency: order.currency, payment_method: 'card' });
  assert.equal(res.status, 201);
  return { order, payment: res.body };
}

const run = () => request(worker).post(RUN).set('X-API-Key', SCHEDULER_KEY);
const getPayment = async (id) => (await request(paymentApp).get(`/payments/${id}`).set('Authorization', `Bearer ${TOKEN}`)).body;
const getOrder = async (id) => (await request(orderServer).get(`/orders/${id}`).set('Authorization', `Bearer ${ORDER_TOKEN}`)).body;
const afterWindow = (payment, extraMs = GRACE_MS) => new Date(new Date(payment.checkout_session.expires_at).getTime() + extraMs);
const reconcile = () => request(worker).post(RECONCILE).set('X-API-Key', SCHEDULER_KEY);
const auditTrailOf = async (id) => assertAuditTrailComplete(await payments.listAuditEntries(id), (await getPayment(id)).status);

/** Delivers a signed gateway webhook reporting `status` for `payment`. */
function webhook(payment, status, eventId = `evt_${status}_${payment.id}`) {
  const raw = JSON.stringify({ event_id: eventId, payment_id: payment.id, status, amount: payment.amount, currency: payment.currency });
  return request(paymentApp)
    .post('/webhooks/payments')
    .set('Content-Type', 'application/json')
    .set('X-Gateway-Signature', signWebhookPayload(raw, WEBHOOK_SECRET))
    .send(raw);
}

describe('session-expiry runs (OP-008)', () => {
  it('requires the scheduler API key', async () => {
    assert.equal((await request(worker).post(RUN)).status, 401);
    assert.equal((await request(worker).post(RUN).set('Authorization', `Bearer ${TOKEN}`)).status, 401);
    assert.equal((await request(worker).post(RUN).set('X-API-Key', ORDER_API_KEY)).status, 401);
    const ok = await run();
    assert.equal(ok.status, 200);
    assert.equal(ok.body.examined, 0);
  });

  it('leaves sessions alone until the window (plus grace) has elapsed', async () => {
    const { payment } = await initiatedPayment();
    clock = new Date(new Date(payment.checkout_session.expires_at).getTime() + GRACE_MS - 1);
    assert.equal((await run()).body.examined, 0);
    const current = await getPayment(payment.id);
    assert.equal(current.status, 'INITIATED');
    assert.equal(current.checkout_session.status, 'ACTIVE');
  });

  it('expires a lapsed session and its payment on elapsed time alone, fails the order, and audits it', async () => {
    const { order, payment } = await initiatedPayment();
    clock = afterWindow(payment);
    const res = await run();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.outcomes, { expired: 1 });
    assert.equal(res.body.sessions[0].order_notification, 'applied');

    const current = await getPayment(payment.id);
    assert.equal(current.status, 'EXPIRED');
    assert.equal(current.checkout_session.status, 'EXPIRED');
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');

    const audit = await payments.listAuditEntries(payment.id);
    const expired = audit.find((e) => e.event_type === 'SESSION_EXPIRED');
    assert.equal(expired.previous_status, 'INITIATED');
    assert.equal(expired.new_status, 'EXPIRED');
    assert.equal(expired.actor, 'reconciliation_job');

    // Processed once: the next run finds nothing.
    assert.equal((await run()).body.examined, 0);

    // The order is payable again with a fresh key.
    const retry = await request(paymentApp)
      .post('/payments')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Idempotency-Key', `retry-${order.id}`)
      .send({ order_id: order.id, amount: order.total_amount, currency: order.currency, payment_method: 'upi' });
    assert.equal(retry.status, 201);
  });

  it('only invalidates the session of a payment the gateway reports in progress (PENDING)', async () => {
    const { order, payment } = await initiatedPayment();
    await payments.updateStatus({ id: payment.id, from: 'INITIATED', to: 'PENDING', eventType: 'WEBHOOK_APPLIED', actor: 'gateway_webhook', now: clock });
    clock = afterWindow(payment);
    assert.deepEqual((await run()).body.outcomes, { deferred: 1 });
    const current = await getPayment(payment.id);
    assert.equal(current.status, 'PENDING');
    assert.equal(current.checkout_session.status, 'EXPIRED');
    assert.equal((await getOrder(order.id)).status, 'PENDING_PAYMENT');
    assert.ok((await payments.listAuditEntries(payment.id)).some((e) => e.event_type === 'SESSION_EXPIRY_DEFERRED'));
  });

  it('does not overturn an outcome a webhook already applied', async () => {
    const { payment } = await initiatedPayment();
    await payments.updateStatus({ id: payment.id, from: 'INITIATED', to: 'SUCCESS', eventType: 'WEBHOOK_APPLIED', actor: 'gateway_webhook', now: clock });
    clock = afterWindow(payment);
    assert.deepEqual((await run()).body.outcomes, { already_resolved: 1 });
    const current = await getPayment(payment.id);
    assert.equal(current.status, 'SUCCESS');
    assert.equal(current.checkout_session.status, 'COMPLETED');
  });

  it('expires the payment even when order-service is down; the reconciliation run re-sends the notification', async () => {
    const { order, payment } = await initiatedPayment();
    clock = afterWindow(payment);
    orderDown = true;
    const res = await run();
    assert.equal(res.body.sessions[0].order_notification, 'failed');
    assert.equal((await getPayment(payment.id)).status, 'EXPIRED');
    assert.equal((await getOrder(order.id)).status, 'PENDING_PAYMENT');

    orderDown = false;
    const recon = await request(worker).post('/internal/payments/reconciliation-runs').set('X-API-Key', SCHEDULER_KEY);
    assert.deepEqual(recon.body.order_notifications_retried, [{ payment_id: payment.id, order_id: order.id, outcome: 'applied' }]);
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');
  });

  it('expires an abandoned checkout the reconciliation run polled first (it stays INITIATED, not PENDING)', async () => {
    const { order, payment } = await initiatedPayment();
    clock = new Date(T0.getTime() + 11 * 60 * 1000); // past the 10 min reconciliation threshold, inside the window
    const recon = await reconcile();
    assert.deepEqual(recon.body.outcomes, { awaiting_customer: 1 });
    assert.equal((await getPayment(payment.id)).status, 'INITIATED');

    clock = afterWindow(payment);
    assert.deepEqual((await run()).body.outcomes, { expired: 1 });
    assert.equal((await getPayment(payment.id)).status, 'EXPIRED');
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');
    await auditTrailOf(payment.id);
  });

  it('a PENDING payment whose window lapsed with nothing in flight at the gateway is expired by reconciliation', async () => {
    const { order, payment } = await initiatedPayment();
    assert.equal((await webhook(payment, 'pending')).body.payment_status, 'PENDING');
    clock = afterWindow(payment);
    assert.deepEqual((await run()).body.outcomes, { deferred: 1 });

    gatewayStatus = 'created'; // the attempt was abandoned: the gateway has no payment in flight
    const recon = await reconcile();
    assert.equal(recon.body.payments[0].status, 'EXPIRED');
    const current = await getPayment(payment.id);
    assert.equal(current.status, 'EXPIRED');
    assert.equal(current.checkout_session.status, 'EXPIRED');
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');
    const reconciled = (await payments.listAuditEntries(payment.id)).find((e) => e.event_type === 'RECONCILED');
    assert.equal(reconciled.metadata.reason, 'checkout_window_lapsed');
    await auditTrailOf(payment.id);

    // No longer in progress: the order can be paid with a new attempt.
    const retry = await request(paymentApp)
      .post('/payments')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Idempotency-Key', `retry-${order.id}`)
      .send({ order_id: order.id, amount: order.total_amount, currency: order.currency, payment_method: 'card' });
    assert.equal(retry.status, 201);
  });

  it('a PENDING payment whose window lapsed still takes the outcome the gateway reports', async () => {
    const { order, payment } = await initiatedPayment();
    await webhook(payment, 'processing');
    clock = afterWindow(payment);
    await run();
    gatewayStatus = 'captured';
    await reconcile();
    assert.equal((await getPayment(payment.id)).status, 'SUCCESS');
    assert.equal((await getOrder(order.id)).status, 'PAID');
    await auditTrailOf(payment.id);
  });

  it('a completion reported after expiry is not applied and is audited as a conflict', async () => {
    const { order, payment } = await initiatedPayment();
    clock = afterWindow(payment);
    await run();
    const late = await webhook(payment, 'captured');
    assert.equal(late.status, 200);
    assert.equal(late.body.outcome, 'conflict');
    assert.equal((await getPayment(payment.id)).status, 'EXPIRED');
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');
    assert.ok((await payments.listAuditEntries(payment.id)).some((e) => e.event_type === 'WEBHOOK_CONFLICT'));
    await auditTrailOf(payment.id);
  });

  it('processes at most a batch per run, oldest window first; the rest go in the next run', async () => {
    const created = [];
    for (let i = 0; i < 3; i++) {
      clock = new Date(T0.getTime() + i * 60 * 1000);
      created.push((await initiatedPayment()).payment);
    }
    clock = afterWindow(created[2]);
    const expirer = makeExpirer({ batchSize: 2 });
    const first = await expirer.run();
    assert.deepEqual(first.sessions.map((s) => s.payment_id), [created[0].id, created[1].id]);
    const second = await expirer.run();
    assert.deepEqual(second.sessions.map((s) => s.payment_id), [created[2].id]);
    assert.equal((await expirer.run()).examined, 0);
  });

  it('overlapping triggers share one run', async () => {
    const { payment } = await initiatedPayment();
    clock = afterWindow(payment);
    const expirer = makeExpirer();
    const [a, b] = await Promise.all([expirer.run(), expirer.run()]);
    assert.equal(a.run_id, b.run_id);
    assert.equal((await payments.listAuditEntries(payment.id)).filter((e) => e.event_type === 'SESSION_EXPIRED').length, 1);
  });
});
