import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp as createOrderApp } from '../../src/order-service/app.js';
import { createOrderRepository } from '../../src/order-service/orderRepository.js';
import { createApp as createPaymentApp } from '../../src/payment-service/app.js';
import { createHttpGateway, parseTransactionStatus, signWebhookPayload, TRANSACTION_NOT_FOUND } from '../../src/payment-service/gateway.js';
import { createOrderClient } from '../../src/payment-service/orderClient.js';
import { createPaymentRepository } from '../../src/payment-service/paymentRepository.js';
import { createApp } from '../../src/reconciliation-worker/app.js';
import { createReconciler } from '../../src/reconciliation-worker/reconciler.js';
import { UpstreamError } from '../../src/shared/retry.js';
import { createEncryptedSecretsManager, encryptSecret } from '../../src/shared/secrets.js';
import { createTestPool } from '../helpers/db.js';

const TOKEN = 'payment-test-token';
const ORDER_TOKEN = 'order-service-token';
const ORDER_API_KEY = 'order-internal-key';
const SCHEDULER_KEY = 'scheduler-key';
const WEBHOOK_SECRET = 'whsec_test_signing_secret';
const T0 = new Date('2026-10-19T10:00:00.000Z');
const THRESHOLD_MS = 10 * 60 * 1000;
const RUN = '/internal/payments/reconciliation-runs';

let clock;
let orderPool;
let paymentPool;
let orderServer;
let paymentApp;
let worker;
let reconciler;
let orderDown;
let orderCalls;
let checkoutDown;
let gatewayAnswers;
let gatewayCalls;
let sleeps;

beforeEach(async () => {
  clock = T0;
  const now = () => clock;
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
  checkoutDown = false;
  gatewayAnswers = new Map();
  gatewayCalls = [];
  sleeps = [];
  const orders = createOrderClient({
    baseUrl: `http://127.0.0.1:${orderServer.address().port}`,
    token: ORDER_TOKEN,
    apiKey: ORDER_API_KEY,
    retryPolicy: { attempts: 3, baseDelayMs: 10, factor: 2 },
    sleep: async () => {},
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
  // One fake gateway for both deployables. `gatewayAnswers` holds, per payment id, a list of
  // answers consumed one per status query (the last one repeats): a provider body, 'not_found',
  // or an Error to throw.
  const gateway = {
    name: 'razorpay',
    async createCheckoutSession({ payment }) {
      if (checkoutDown) throw new UpstreamError('payment gateway responded 503', { retryable: true, status: 503 });
      return {
        gatewaySessionId: `cs_${payment.id}`,
        gatewayReference: `txn_${payment.id}`,
        checkoutUrl: `https://checkout.example/${payment.id}`,
      };
    },
    async getTransactionStatus({ credentials, payment }) {
      gatewayCalls.push({ paymentId: payment.id, credentials });
      const answers = gatewayAnswers.get(payment.id) ?? [{ status: 'created' }];
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer instanceof Error) throw answer;
      if (answer === 'not_found') return { status: TRANSACTION_NOT_FOUND, gatewayStatus: null };
      return parseTransactionStatus({ amount: payment.amount, currency: payment.currency, ...answer });
    },
  };
  const payments = createPaymentRepository(paymentPool);
  paymentApp = createPaymentApp({ payments, orders, gateway, secrets, bearerTokens: [TOKEN], sleep: async () => {}, now });
  reconciler = createReconciler({
    payments,
    orders,
    gateway,
    secrets,
    thresholdMs: THRESHOLD_MS,
    gatewayRetryPolicy: { attempts: 3, baseDelayMs: 10, factor: 2 },
    sleep: async (ms) => sleeps.push(ms),
    now,
  });
  worker = createApp({ reconciler, apiKeys: [SCHEDULER_KEY] });
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

const initiate = (order, key = `idem-${order.id}`) =>
  request(paymentApp)
    .post('/payments')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Idempotency-Key', key)
    .send({ order_id: order.id, amount: order.total_amount, currency: order.currency, payment_method: 'card' });

/** An order with an INITIATED payment (with a checkout session unless the gateway is down). */
async function setup() {
  const order = await createOrder();
  const res = await initiate(order);
  assert.equal(res.status, checkoutDown ? 502 : 201);
  const payment = res.status === 201 ? res.body : (await paymentPool.query('select * from payments')).rows[0];
  orderCalls.length = 0;
  return { order, payment };
}

/** Moves the clock past the threshold and triggers a run like the scheduler does. */
async function runReconciliation({ advanceMs = THRESHOLD_MS + 60_000 } = {}) {
  clock = new Date(clock.getTime() + advanceMs);
  const res = await request(worker).post(RUN).set('X-API-Key', SCHEDULER_KEY);
  assert.equal(res.status, 200);
  return res.body;
}

const getPayment = async (id) =>
  (await request(paymentApp).get(`/payments/${id}`).set('Authorization', `Bearer ${TOKEN}`)).body;
const getOrder = async (id) =>
  (await request(orderServer).get(`/orders/${id}`).set('Authorization', `Bearer ${ORDER_TOKEN}`)).body;
const auditFor = async (paymentId) =>
  (await paymentPool.query('select * from audit_log_entries where payment_id = $1', [paymentId])).rows;
const patches = () => orderCalls.filter((c) => c.method === 'PATCH');

/** Status-changing audit entries chain from PAYMENT_INITIATED to the current status (REQ-011). */
async function assertAuditTrailComplete(paymentId) {
  const { status } = await getPayment(paymentId);
  const changes = (await auditFor(paymentId)).filter((e) => e.previous_status === null || e.previous_status !== e.new_status);
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

describe('POST /internal/payments/reconciliation-runs — auth', () => {
  it('requires the scheduler X-API-Key (401 otherwise, before touching any payment)', async () => {
    await setup();
    clock = new Date(T0.getTime() + 2 * THRESHOLD_MS);
    for (const req of [
      request(worker).post(RUN),
      request(worker).post(RUN).set('X-API-Key', 'wrong'),
      request(worker).post(RUN).set('Authorization', `Bearer ${TOKEN}`),
      request(worker).post(RUN).set('X-API-Key', ORDER_API_KEY),
    ]) {
      const res = await req;
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'unauthorized');
    }
    assert.equal(gatewayCalls.length, 0);
  });
});

describe('reconciliation — selecting stuck payments (REQ-010)', () => {
  it('only polls INITIATED/PENDING payments unchanged for longer than the threshold', async () => {
    const { payment: old } = await setup();
    clock = new Date(T0.getTime() + 5 * 60_000);
    const { payment: recent } = await setup();
    const { payment: done, order: doneOrder } = await setup();
    gatewayAnswers.set(old.id, [{ status: 'created' }]);
    // A payment the webhook already resolved is not polled.
    const raw = JSON.stringify({ event_id: 'evt_1', payment_id: done.id, status: 'captured', amount: done.amount, currency: done.currency });
    const hook = await request(paymentApp)
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Gateway-Signature', signWebhookPayload(raw, WEBHOOK_SECRET))
      .send(raw);
    assert.equal(hook.status, 200);
    assert.equal((await getOrder(doneOrder.id)).status, 'PAID');

    const run = await runReconciliation({ advanceMs: 6 * 60_000 }); // old: 11 min, recent: 6 min
    assert.equal(run.examined, 1);
    assert.deepEqual(gatewayCalls.map((c) => c.paymentId), [old.id]);
    assert.ok(!gatewayCalls.some((c) => c.paymentId === recent.id));
    // Credentials are fetched from the secrets manager for the query.
    assert.deepEqual(gatewayCalls[0].credentials, { keyId: 'k', keySecret: 's' });
  });

  it('returns 200 with an empty batch when nothing is stuck', async () => {
    const run = await runReconciliation();
    assert.equal(run.examined, 0);
    assert.deepEqual(run.payments, []);
    assert.ok(run.run_id);
  });
});

describe('reconciliation — resolving against the gateway (REQ-008, REQ-009, REQ-011)', () => {
  it('a completed transaction sets SUCCESS, completes the session and marks the order PAID', async () => {
    const { order, payment } = await setup();
    gatewayAnswers.set(payment.id, [{ status: 'captured', transaction_id: payment.gateway_reference }]);
    const run = await runReconciliation();
    assert.equal(run.examined, 1);
    assert.deepEqual(run.payments[0], {
      payment_id: payment.id,
      previous_status: 'INITIATED',
      status: 'SUCCESS',
      gateway_status: 'captured',
      outcome: 'applied',
      order_notification: 'applied',
    });
    const stored = await getPayment(payment.id);
    assert.equal(stored.status, 'SUCCESS');
    assert.equal(stored.checkout_session.status, 'COMPLETED');
    assert.equal((await getOrder(order.id)).status, 'PAID');
    assert.deepEqual(JSON.parse(patches()[0].body), { status: 'PAID' });
    assert.equal(patches()[0].headers['x-api-key'], ORDER_API_KEY);

    const reconciled = (await auditFor(payment.id)).find((e) => e.event_type === 'RECONCILED');
    assert.equal(reconciled.actor, 'reconciliation_job');
    assert.equal(reconciled.previous_status, 'INITIATED');
    assert.equal(reconciled.new_status, 'SUCCESS');
    assert.equal(reconciled.metadata.gateway_status, 'captured');
    assert.equal(reconciled.metadata.reconciliation_run_id, run.run_id);
    await assertAuditTrailComplete(payment.id);

    // Resolved: the next run leaves it alone.
    assert.equal((await runReconciliation()).examined, 0);
  });

  it('a declined transaction sets FAILED and marks the order PAYMENT_FAILED', async () => {
    const { order, payment } = await setup();
    gatewayAnswers.set(payment.id, [{ status: 'declined' }]);
    await runReconciliation();
    assert.equal((await getPayment(payment.id)).status, 'FAILED');
    assert.equal((await getPayment(payment.id)).checkout_session.status, 'COMPLETED');
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');
    await assertAuditTrailComplete(payment.id);
  });

  it('an unresolved transaction sets PENDING (order untouched), keeps being polled, then resolves', async () => {
    const { order, payment } = await setup();
    gatewayAnswers.set(payment.id, [{ status: 'processing' }, { status: 'processing' }, { status: 'captured' }]);

    const first = await runReconciliation();
    assert.equal(first.payments[0].outcome, 'applied');
    assert.equal(first.payments[0].order_notification, 'skipped');
    assert.equal((await getPayment(payment.id)).status, 'PENDING');
    assert.equal((await getOrder(order.id)).status, 'PENDING_PAYMENT');
    assert.equal(patches().length, 0);

    const second = await runReconciliation();
    assert.equal(second.payments[0].outcome, 'unchanged');
    assert.ok((await auditFor(payment.id)).some((e) => e.event_type === 'RECONCILIATION_UNRESOLVED'));

    const third = await runReconciliation();
    assert.equal(third.payments[0].status, 'SUCCESS');
    assert.equal((await getOrder(order.id)).status, 'PAID');
    await assertAuditTrailComplete(payment.id);
  });

  it('an expired gateway transaction sets EXPIRED, expires the session and fails the order', async () => {
    const { order, payment } = await setup();
    gatewayAnswers.set(payment.id, [{ status: 'expired' }]);
    await runReconciliation();
    const stored = await getPayment(payment.id);
    assert.equal(stored.status, 'EXPIRED');
    assert.equal(stored.checkout_session.status, 'EXPIRED');
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');
  });

  it('a payment whose checkout never reached the gateway (unknown there) is FAILED, freeing the order', async () => {
    checkoutDown = true;
    const { order, payment } = await setup();
    checkoutDown = false;
    assert.equal(payment.status, 'INITIATED');
    assert.equal(payment.gateway_reference, null);
    gatewayAnswers.set(payment.id, ['not_found']);
    await runReconciliation();
    assert.equal((await getPayment(payment.id)).status, 'FAILED');
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');
    await assertAuditTrailComplete(payment.id);
    // The customer can pay again with a new attempt.
    assert.equal((await initiate(order, 'second-attempt')).status, 201);
  });

  it('does not change a payment the gateway reports with different details, and audits it', async () => {
    const { order, payment } = await setup();
    gatewayAnswers.set(payment.id, [{ status: 'captured', amount: 1 }]);
    const run = await runReconciliation();
    assert.equal(run.payments[0].outcome, 'details_mismatch');
    assert.equal((await getPayment(payment.id)).status, 'INITIATED');
    assert.equal((await getOrder(order.id)).status, 'PENDING_PAYMENT');
    const audit = (await auditFor(payment.id)).find((e) => e.event_type === 'RECONCILIATION_MISMATCH');
    assert.deepEqual(audit.metadata.mismatched, ['amount']);
  });

  it('a known reference the gateway cannot find is left unresolved, not failed', async () => {
    const { payment } = await setup();
    gatewayAnswers.set(payment.id, ['not_found']);
    const run = await runReconciliation();
    assert.equal(run.payments[0].outcome, 'not_found_at_gateway');
    assert.equal((await getPayment(payment.id)).status, 'INITIATED');
  });
});

describe('reconciliation — retries (REQ-010, NFR-004)', () => {
  it('retries a transient gateway failure with exponential backoff and then applies the result', async () => {
    const { order, payment } = await setup();
    const transient = () => new UpstreamError('payment gateway timed out', { retryable: true });
    gatewayAnswers.set(payment.id, [transient(), transient(), { status: 'captured' }]);
    const run = await runReconciliation();
    assert.equal(gatewayCalls.length, 3);
    assert.deepEqual(sleeps, [10, 20]);
    assert.equal(run.payments[0].status, 'SUCCESS');
    assert.equal((await getOrder(order.id)).status, 'PAID');
  });

  it('a gateway that stays down is audited and the payment is reconciled by the next run', async () => {
    const { order, payment } = await setup();
    const down = () => new UpstreamError('payment gateway responded 503', { retryable: true, status: 503 });
    gatewayAnswers.set(payment.id, [down(), down(), down(), { status: 'failed' }]);
    const first = await runReconciliation();
    assert.equal(first.payments[0].outcome, 'gateway_unavailable');
    assert.equal(gatewayCalls.length, 3);
    assert.equal((await getPayment(payment.id)).status, 'INITIATED');
    const failed = (await auditFor(payment.id)).find((e) => e.event_type === 'RECONCILIATION_GATEWAY_FAILED');
    assert.equal(failed.metadata.attempts, 3);
    assert.equal(failed.actor, 'reconciliation_job');

    const second = await runReconciliation();
    assert.equal(second.payments[0].status, 'FAILED');
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');
  });

  it('a gateway 4xx is not retried within the run', async () => {
    const { payment } = await setup();
    gatewayAnswers.set(payment.id, [new UpstreamError('payment gateway rejected the status query (401)', { status: 401 })]);
    const run = await runReconciliation();
    assert.equal(run.payments[0].outcome, 'gateway_unavailable');
    assert.equal(gatewayCalls.length, 1);
  });

  it('an unreachable order-service is retried, then re-notified by the next run', async () => {
    const { order, payment } = await setup();
    gatewayAnswers.set(payment.id, [{ status: 'captured' }]);
    orderDown = true;
    const first = await runReconciliation();
    assert.equal(first.payments[0].status, 'SUCCESS');
    assert.equal(first.payments[0].order_notification, 'failed');
    assert.equal(patches().length, 3); // the order client's retry policy
    assert.deepEqual(first.order_notifications_retried, []);
    assert.equal((await getOrder(order.id)).status, 'PENDING_PAYMENT');
    assert.ok((await auditFor(payment.id)).some((e) => e.event_type === 'ORDER_NOTIFICATION_FAILED'));

    orderDown = false;
    const second = await runReconciliation();
    assert.equal(second.examined, 0);
    assert.deepEqual(second.order_notifications_retried, [{ payment_id: payment.id, order_id: order.id, outcome: 'applied' }]);
    assert.equal((await getOrder(order.id)).status, 'PAID');
    // Delivered: not sent again.
    assert.deepEqual((await runReconciliation()).order_notifications_retried, []);
  });

  it('also re-sends an order notification a webhook could not deliver', async () => {
    const { order, payment } = await setup();
    orderDown = true;
    const raw = JSON.stringify({ event_id: 'evt_2', payment_id: payment.id, status: 'declined', amount: payment.amount, currency: payment.currency });
    const hook = await request(paymentApp)
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Gateway-Signature', signWebhookPayload(raw, WEBHOOK_SECRET))
      .send(raw);
    assert.equal(hook.status, 503);
    orderDown = false;
    const run = await runReconciliation();
    assert.equal(run.order_notifications_retried[0].outcome, 'applied');
    assert.equal((await getOrder(order.id)).status, 'PAYMENT_FAILED');
  });
});

describe('reconciliation — duplicates and overlap (REQ-010)', () => {
  it('a repeated initiation with the same key is one payment, polled once', async () => {
    const order = await createOrder();
    const first = await initiate(order);
    const second = await initiate(order);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    gatewayAnswers.set(first.body.id, [{ status: 'captured' }]);
    const run = await runReconciliation();
    assert.equal(run.examined, 1);
    assert.equal(gatewayCalls.length, 1);
  });

  it('overlapping triggers share one run', async () => {
    const { payment } = await setup();
    gatewayAnswers.set(payment.id, [{ status: 'captured' }]);
    clock = new Date(T0.getTime() + 2 * THRESHOLD_MS);
    const [a, b] = await Promise.all([reconciler.run(), reconciler.run()]);
    assert.equal(a.run_id, b.run_id);
    assert.equal(gatewayCalls.length, 1);
    assert.equal((await auditFor(payment.id)).filter((e) => e.event_type === 'RECONCILED').length, 1);
  });
});

describe('gateway status query adapter', () => {
  const payment = { id: 'p-1', amount: 500, currency: 'INR' };
  const credentials = { keyId: 'kid', keySecret: 'ksec' };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('queries by payment reference with Basic auth and maps the provider state', async () => {
    let seen;
    const gateway = createHttpGateway({
      name: 'stripe',
      baseUrl: 'https://gw.example/',
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return json(200, { status: 'succeeded', amount: 500, currency: 'inr', transaction_id: 'txn_1' });
      },
    });
    assert.deepEqual(await gateway.getTransactionStatus({ credentials, payment }), {
      status: 'SUCCESS',
      gatewayStatus: 'succeeded',
      gatewayReference: 'txn_1',
      amount: 500,
      currency: 'INR',
    });
    assert.equal(seen.url, 'https://gw.example/transactions/p-1');
    assert.equal(seen.init.method, 'GET');
    assert.equal(seen.init.headers.authorization, `Basic ${Buffer.from('kid:ksec').toString('base64')}`);
  });

  it('maps 404 to NOT_FOUND, 5xx to a retryable error and an unknown state to an error', async () => {
    const make = (res) => createHttpGateway({ name: 'stripe', baseUrl: 'https://gw', fetchImpl: async () => res });
    assert.equal((await make(json(404, {})).getTransactionStatus({ credentials, payment })).status, TRANSACTION_NOT_FOUND);
    await assert.rejects(make(json(502, {})).getTransactionStatus({ credentials, payment }), { retryable: true });
    await assert.rejects(make(json(200, { status: 'weird' })).getTransactionStatus({ credentials, payment }), { retryable: false });
  });

  it('maps "no outcome yet" states to PENDING and expiry to EXPIRED', () => {
    for (const [status, expected] of [
      ['created', 'PENDING'],
      ['processing', 'PENDING'],
      ['captured', 'SUCCESS'],
      ['declined', 'FAILED'],
      ['expired', 'EXPIRED'],
    ]) {
      assert.equal(parseTransactionStatus({ status }).status, expected);
    }
    assert.equal(parseTransactionStatus({ status: 'constructor' }), null);
  });
});
