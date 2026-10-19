import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../../src/customer-client/app.js';

// The customer-client's own enforcement of REQ-001 / REQ-002, independent of order-service and
// payment-service: both are replaced by permissive stubs that accept anything and record every
// call, so these tests fail if the client stops checking (rather than relying on the services).

const ORDER_URL = 'http://order.stub';
const PAYMENT_URL = 'http://payment.stub';
const KNOWN_ORDER = randomUUID();

let calls;
let createdOrder;
let client;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  createdOrder = (body) => ({ id: randomUUID(), status: 'PENDING_PAYMENT', ...body });
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, headers: init.headers, body });
    const { origin, pathname } = new URL(url);
    if (origin === ORDER_URL && init.method === 'POST') return json(201, createdOrder(body));
    if (origin === ORDER_URL) {
      const id = pathname.split('/').pop();
      return id === KNOWN_ORDER
        ? json(200, { id, status: 'PENDING_PAYMENT', total_amount: 500, currency: 'INR' })
        : json(404, { error: { code: 'order_not_found', message: 'no order' } });
    }
    // Permissive payment-service stub: would "create" a payment for any request.
    return json(201, { id: randomUUID(), status: 'INITIATED', ...body });
  };
  client = request(
    createApp({
      orderServiceUrl: ORDER_URL,
      orderServiceToken: 'o-token',
      paymentServiceUrl: PAYMENT_URL,
      paymentServiceToken: 'p-token',
      fetchImpl,
    }),
  );
});

const paymentCalls = () => calls.filter((c) => c.url.startsWith(PAYMENT_URL));
const validPayment = () => ({ order_id: KNOWN_ORDER, amount: 500, currency: 'INR', payment_method: 'card' });

describe('customer-client contract: order creation (REQ-001)', () => {
  it('sends only the client fields and returns the PENDING_PAYMENT order with its UUID', async () => {
    const customer = randomUUID();
    const res = await client
      .post('/api/orders')
      .send({ customer_id: customer, total_amount: 500, currency: 'INR', status: 'PAID', id: 'x' });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'PENDING_PAYMENT');
    assert.deepEqual(calls[0].body, { customer_id: customer, total_amount: 500, currency: 'INR' });
    assert.equal(calls[0].headers.authorization, 'Bearer o-token');
  });

  it('rejects an invalid order without calling order-service', async () => {
    for (const body of [{}, { customer_id: randomUUID(), currency: 'INR' }, { customer_id: randomUUID(), total_amount: 5 }, []]) {
      const res = await client.post('/api/orders').send(body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_failed');
    }
    assert.equal(calls.length, 0);
  });

  it('does not report success for a created order that is not PENDING_PAYMENT or lacks a UUID id', async () => {
    for (const wrong of [{ status: 'PAID' }, { id: 'order-1' }, { id: undefined }]) {
      createdOrder = (body) => ({ id: randomUUID(), status: 'PENDING_PAYMENT', ...body, ...wrong });
      const res = await client.post('/api/orders').send({ customer_id: randomUUID(), total_amount: 500, currency: 'INR' });
      assert.equal(res.status, 502, JSON.stringify(wrong));
      assert.equal(res.body.error.code, 'unexpected_order_response');
    }
  });
});

describe('customer-client contract: payment request (REQ-002)', () => {
  it('forwards a complete request with its Idempotency-Key after confirming the order exists', async () => {
    const res = await client.post('/api/payments').set('Idempotency-Key', 'key-1').send({ ...validPayment(), status: 'SUCCESS' });
    assert.equal(res.status, 201);
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [`GET ${ORDER_URL}/orders/${KNOWN_ORDER}`, `POST ${PAYMENT_URL}/payments`],
    );
    assert.deepEqual(paymentCalls()[0].body, validPayment());
    assert.equal(paymentCalls()[0].headers['idempotency-key'], 'key-1');
    assert.equal(paymentCalls()[0].headers.authorization, 'Bearer p-token');
  });

  it('rejects a request missing order id, amount, currency or payment method without forwarding it', async () => {
    for (const field of Object.keys(validPayment())) {
      const { [field]: _omitted, ...body } = validPayment();
      const res = await client.post('/api/payments').set('Idempotency-Key', 'key-1').send(body);
      assert.equal(res.status, 400, field);
      assert.equal(res.body.error.code, 'validation_failed');
      assert.deepEqual(res.body.error.details.map((d) => d.field), [field]);
    }
    const noKey = await client.post('/api/payments').send(validPayment());
    assert.equal(noKey.status, 400);
    assert.deepEqual(noKey.body.error.details.map((d) => d.field), ['Idempotency-Key']);
    assert.equal(calls.length, 0);
  });

  it('rejects a payment for an order id that does not exist without forwarding it', async () => {
    const res = await client
      .post('/api/payments')
      .set('Idempotency-Key', 'key-2')
      .send({ ...validPayment(), order_id: randomUUID() });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'order_not_found');
    assert.equal(paymentCalls().length, 0);
  });

  it('does not forward the payment when the order cannot be verified', async () => {
    const down = request(
      createApp({
        orderServiceUrl: ORDER_URL,
        orderServiceToken: 'o-token',
        paymentServiceUrl: PAYMENT_URL,
        paymentServiceToken: 'p-token',
        fetchImpl: async (url) => {
          calls.push({ url });
          if (url.startsWith(ORDER_URL)) throw new TypeError('fetch failed');
          return json(201, {});
        },
      }),
    );
    const res = await down.post('/api/payments').set('Idempotency-Key', 'key-3').send(validPayment());
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'order_service_unavailable');
    assert.equal(paymentCalls().length, 0);
  });
});
