import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp as createClientApp } from '../../src/customer-client/app.js';
import { createApp as createOrderApp } from '../../src/order-service/app.js';
import { createOrderRepository } from '../../src/order-service/orderRepository.js';
import { createApp as createPaymentApp } from '../../src/payment-service/app.js';
import { createMockGateway, signWebhookPayload } from '../../src/payment-service/gateway.js';
import { createOrderClient } from '../../src/payment-service/orderClient.js';
import { createPaymentRepository } from '../../src/payment-service/paymentRepository.js';
import { createApp as createWorkerApp } from '../../src/reconciliation-worker/app.js';
import { createReconciler } from '../../src/reconciliation-worker/reconciler.js';
import { createSessionExpirer } from '../../src/reconciliation-worker/sessionExpirer.js';
import { createEncryptedSecretsManager, encryptSecret } from '../../src/shared/secrets.js';
import { assertAuditTrailComplete } from '../helpers/audit.js';
import { createTestPool } from '../helpers/db.js';

// WI-007 acceptance criteria, end to end: customer-client (with the dev hosted checkout that
// sends signed gateway webhooks) -> order-service + payment-service, and the reconciliation-worker
// deployable driven over HTTP the way its scheduler does (session-expiry + reconciliation runs).
// Each criterion is also checked against the expiry job, so a normal outcome is never overturned.

const ORDER_TOKEN = 'order-token';
const ORDER_API_KEY = 'order-internal-key';
const PAYMENT_TOKEN = 'payment-token';
const SCHEDULER_KEY = 'scheduler-key';
const WEBHOOK_SECRET = 'whsec_wi007';
const TTL_MS = 15 * 60 * 1000;
const GRACE_MS = 60 * 1000;
const T0 = new Date('2026-10-19T10:00:00.000Z');

let clock;
let orderPool;
let paymentPool;
let payments;
let servers;
let client;
let clientBase;
let paymentApi;
let worker;

const listen = (app) =>
  new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
const base = (server) => `http://127.0.0.1:${server.address().port}`;

beforeEach(async () => {
  clock = T0;
  const now = () => new Date(clock);
  orderPool = await createTestPool('order-db');
  paymentPool = await createTestPool('payment-db');
  payments = createPaymentRepository(paymentPool);

  const orderServer = await listen(
    createOrderApp({ orders: createOrderRepository(orderPool), bearerTokens: [ORDER_TOKEN], apiKeys: [ORDER_API_KEY], now }),
  );
  const orders = createOrderClient({ baseUrl: base(orderServer), token: ORDER_TOKEN, apiKey: ORDER_API_KEY, retryPolicy: { attempts: 1 } });
  const masterKey = randomBytes(32).toString('base64');
  const secrets = createEncryptedSecretsManager({
    encryptedGatewayCredentials: encryptSecret(JSON.stringify({ key_id: 'k', key_secret: 's' }), masterKey),
    encryptedWebhookSecret: encryptSecret(WEBHOOK_SECRET, masterKey),
    masterKey,
  });
  // Mock gateway: checkout links land on the client's dev hosted checkout; status queries report
  // "created" (customer has not paid), like the docker compose stack.
  const gateway = {
    name: 'mock',
    createCheckoutSession: (args) => createMockGateway({ checkoutBaseUrl: `${clientBase}/mock-checkout` }).createCheckoutSession(args),
    getTransactionStatus: (args) => createMockGateway().getTransactionStatus(args),
  };
  const paymentServer = await listen(
    createPaymentApp({ payments, orders, gateway, secrets, bearerTokens: [PAYMENT_TOKEN], checkoutTtlMs: TTL_MS, sleep: async () => {}, now }),
  );
  const clientServer = await listen(
    createClientApp({
      orderServiceUrl: base(orderServer),
      orderServiceToken: ORDER_TOKEN,
      paymentServiceUrl: base(paymentServer),
      paymentServiceToken: PAYMENT_TOKEN,
      mockCheckout: { webhookUrl: `${base(paymentServer)}/webhooks/payments`, getWebhookSecret: async () => WEBHOOK_SECRET },
      now,
    }),
  );
  clientBase = base(clientServer);
  client = request(clientServer);
  paymentApi = request(paymentServer);
  worker = request(
    createWorkerApp({
      reconciler: createReconciler({ payments, orders, gateway, secrets, sleep: async () => {}, now }),
      sessionExpirer: createSessionExpirer({ payments, orders, graceMs: GRACE_MS, now }),
      apiKeys: [SCHEDULER_KEY],
    }),
  );
  servers = [orderServer, paymentServer, clientServer];
});

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  await orderPool.end();
  await paymentPool.end();
});

/** Places an order and initiates its payment with `method` through the customer client. */
async function checkout(method = 'card') {
  const order = (await client.post('/api/orders').send({ customer_id: randomUUID(), total_amount: 54800, currency: 'INR' })).body;
  assert.equal(order.status, 'PENDING_PAYMENT');
  const init = await client
    .post('/api/payments')
    .set('Idempotency-Key', randomUUID())
    .send({ order_id: order.id, amount: order.total_amount, currency: order.currency, payment_method: method });
  assert.equal(init.status, 201, JSON.stringify(init.body));
  return { order, payment: init.body, checkoutPath: new URL(init.body.checkout_session.checkout_url).pathname };
}

/** The customer acts on the hosted checkout page ('pay' | 'decline'). */
const completeCheckout = (path, method, outcome) => client.post(path).type('form').send({ payment_method: method, outcome });

/** A gateway webhook signed with `secret`. */
function webhook(payment, status, { secret = WEBHOOK_SECRET, eventId = randomUUID() } = {}) {
  const raw = JSON.stringify({ event_id: eventId, payment_id: payment.id, status, amount: payment.amount, currency: payment.currency });
  return paymentApi
    .post('/webhooks/payments')
    .set('Content-Type', 'application/json')
    .set('X-Gateway-Signature', signWebhookPayload(raw, secret))
    .send(raw);
}

const expiryRun = async () => {
  const res = await worker.post('/internal/payments/session-expiry-runs').set('X-API-Key', SCHEDULER_KEY);
  assert.equal(res.status, 200);
  return res.body;
};
const reconciliationRun = async () => {
  const res = await worker.post('/internal/payments/reconciliation-runs').set('X-API-Key', SCHEDULER_KEY);
  assert.equal(res.status, 200);
  return res.body;
};
const getPayment = async (id) => (await client.get(`/api/payments/${id}`)).body;
const getOrder = async (id) => (await client.get(`/api/orders/${id}`)).body;
const audit = (id) => payments.listAuditEntries(id);
const afterWindow = (payment) => new Date(new Date(payment.checkout_session.expires_at).getTime() + GRACE_MS + 1000);

describe('WI-007 acceptance criteria', () => {
  it('AC1: the customer completes payment at the hosted checkout with the method selected at initiation', async () => {
    const { order, payment, checkoutPath } = await checkout('upi');
    const page = await client.get(checkoutPath);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-testid="method">upi</);

    // Inside the window the expiry job leaves the session alone.
    clock = new Date(T0.getTime() + TTL_MS - 1000);
    assert.equal((await expiryRun()).examined, 0);

    // Only the method chosen at initiation can complete it.
    assert.equal((await completeCheckout(checkoutPath, 'card', 'pay')).status, 400);
    assert.equal((await getPayment(payment.id)).status, 'INITIATED');
    const done = await completeCheckout(checkoutPath, 'upi', 'pay');
    assert.equal(done.status, 303);

    const paid = await getPayment(payment.id);
    assert.equal(paid.status, 'SUCCESS');
    assert.equal(paid.payment_method, 'upi');
    assert.equal(paid.checkout_session.status, 'COMPLETED');
    assert.equal((await getOrder(order.id)).status, 'PAID');

    // After the window the expiry job finds nothing to do: the completed session is not ACTIVE.
    clock = afterWindow(payment);
    assert.equal((await expiryRun()).examined, 0);
    assert.equal((await getPayment(payment.id)).status, 'SUCCESS');
    assertAuditTrailComplete(await audit(payment.id), 'SUCCESS');
  });

  it('AC2: an uncompleted checkout session expires after its bounded window and the payment fails', async () => {
    const { order, payment, checkoutPath } = await checkout('card');
    assert.equal(new Date(payment.checkout_session.expires_at).getTime() - new Date(payment.created_at).getTime(), TTL_MS);

    // A reconciliation run inside the window (customer has not paid yet) does not make it PENDING.
    clock = new Date(T0.getTime() + 11 * 60 * 1000);
    assert.deepEqual((await reconciliationRun()).outcomes, { awaiting_customer: 1 });

    clock = afterWindow(payment);
    const run = await expiryRun();
    assert.deepEqual(run.outcomes, { expired: 1 });
    assert.equal(run.sessions[0].order_notification, 'applied');

    const expired = await getPayment(payment.id);
    assert.equal(expired.status, 'EXPIRED');
    assert.equal(expired.checkout_session.status, 'EXPIRED');
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');
    // The invalidated session cannot be completed any more.
    assert.equal((await completeCheckout(checkoutPath, 'card', 'pay')).status, 410);
    assert.equal((await getPayment(payment.id)).status, 'EXPIRED');
    const entry = (await audit(payment.id)).find((e) => e.event_type === 'SESSION_EXPIRED');
    assert.equal(entry.actor, 'reconciliation_job');
    assertAuditTrailComplete(await audit(payment.id), 'EXPIRED');
  });

  it('AC3: a verified webhook reporting a completed transaction sets SUCCESS; an unverified one changes nothing', async () => {
    const { payment } = await checkout('card');
    const forged = await webhook(payment, 'captured', { secret: 'not-the-gateway' });
    assert.equal(forged.status, 400);
    assert.equal((await getPayment(payment.id)).status, 'INITIATED');

    const res = await webhook(payment, 'captured');
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'applied');
    assert.equal(res.body.payment_status, 'SUCCESS');
    const stored = await getPayment(payment.id);
    assert.equal(stored.status, 'SUCCESS');
    assert.equal(stored.checkout_session.status, 'COMPLETED');
    const applied = (await audit(payment.id)).find((e) => e.event_type === 'WEBHOOK_APPLIED');
    assert.deepEqual([applied.previous_status, applied.new_status, applied.actor], ['INITIATED', 'SUCCESS', 'gateway_webhook']);

    clock = afterWindow(payment);
    await expiryRun();
    assert.equal((await getPayment(payment.id)).status, 'SUCCESS');
  });

  it('AC4: a verified webhook reporting a declined transaction sets FAILED', async () => {
    const { payment, checkoutPath } = await checkout('netbanking');
    assert.equal((await completeCheckout(checkoutPath, 'netbanking', 'decline')).status, 303);
    const stored = await getPayment(payment.id);
    assert.equal(stored.status, 'FAILED');
    assert.equal(stored.checkout_session.status, 'COMPLETED');
    const applied = (await audit(payment.id)).find((e) => e.event_type === 'WEBHOOK_APPLIED');
    assert.deepEqual([applied.previous_status, applied.new_status], ['INITIATED', 'FAILED']);

    clock = afterWindow(payment);
    await expiryRun();
    assert.equal((await getPayment(payment.id)).status, 'FAILED');
    assertAuditTrailComplete(await audit(payment.id), 'FAILED');
  });

  it('AC5: a transaction result that remains unresolved sets PENDING, which the expiry job does not overturn', async () => {
    const { order, payment } = await checkout('upi');
    const res = await webhook(payment, 'processing');
    assert.equal(res.body.payment_status, 'PENDING');
    assert.equal((await getPayment(payment.id)).status, 'PENDING');
    assert.equal((await getOrder(order.id)).status, 'PENDING_PAYMENT');

    clock = afterWindow(payment);
    assert.deepEqual((await expiryRun()).outcomes, { deferred: 1 });
    const stored = await getPayment(payment.id);
    assert.equal(stored.status, 'PENDING');
    assert.equal(stored.checkout_session.status, 'EXPIRED');
    assert.equal((await getOrder(order.id)).status, 'PENDING_PAYMENT');

    // The gateway's later answer still resolves it.
    assert.equal((await webhook(payment, 'captured')).body.payment_status, 'SUCCESS');
    assert.equal((await getOrder(order.id)).status, 'PAID');
    assertAuditTrailComplete(await audit(payment.id), 'SUCCESS');
  });

  it('AC6: a SUCCESS payment moves the order out of PENDING_PAYMENT (to PAID)', async () => {
    const { order, payment, checkoutPath } = await checkout('card');
    assert.equal((await getOrder(order.id)).status, 'PENDING_PAYMENT');
    await completeCheckout(checkoutPath, 'card', 'pay');
    const updated = await getOrder(order.id);
    assert.notEqual(updated.status, 'PENDING_PAYMENT');
    assert.equal(updated.status, 'PAID');
    assert.ok((await audit(payment.id)).every((e) => e.event_type !== 'ORDER_NOTIFICATION_FAILED'));
  });

  it('AC7: a FAILED payment, and an EXPIRED one, mark the order as payment failed', async () => {
    const declined = await checkout('card');
    await completeCheckout(declined.checkoutPath, 'card', 'decline');
    assert.equal((await getOrder(declined.order.id)).status, 'PAYMENT_FAILED');

    const abandoned = await checkout('upi');
    clock = afterWindow(abandoned.payment);
    await expiryRun();
    assert.equal((await getPayment(abandoned.payment.id)).status, 'EXPIRED');
    assert.equal((await getOrder(abandoned.order.id)).status, 'PAYMENT_FAILED');
  });
});
