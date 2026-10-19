import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../../src/order-service/app.js';
import { createOrderRepository } from '../../src/order-service/orderRepository.js';
import { checkTransition, ORDER_STATUSES } from '../../src/order-service/orderStatus.js';
import { createTestPool } from '../helpers/db.js';

const AUTH = 'Bearer test-token';
const API_KEY = 'test-api-key';
const T0 = new Date('2026-10-19T10:00:00.000Z');
const T1 = new Date('2026-10-19T10:05:00.000Z');

let pool;
let app;
let clock;

beforeEach(async () => {
  pool = await createTestPool('order-db');
  clock = T0;
  app = createApp({
    orders: createOrderRepository(pool),
    bearerTokens: ['test-token'],
    apiKeys: [API_KEY],
    now: () => clock,
  });
});

afterEach(async () => {
  await pool.end();
});

async function createOrder() {
  const res = await request(app)
    .post('/orders')
    .set('Authorization', AUTH)
    .send({ customer_id: '6f1c2b0e-7f43-4a51-9a8e-2d6f3c1b9e01', total_amount: 50000, currency: 'INR' });
  assert.equal(res.status, 201);
  clock = T1;
  return res.body;
}

const patchStatus = (id, body, key = API_KEY) => {
  const req = request(app).patch(`/orders/${id}/status`);
  if (key) req.set('X-API-Key', key);
  return req.send(body);
};

async function setStatus(id, status) {
  await pool.query('update orders set status = $2 where id = $1', [id, status]);
}

describe('PATCH /orders/:orderId/status', () => {
  it('AC1: a SUCCESS payment outcome moves the order out of PENDING_PAYMENT to PAID', async () => {
    const order = await createOrder();
    const res = await patchStatus(order.id, { status: 'PAID' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'PAID');
    assert.equal(res.body.id, order.id);
    assert.equal(res.body.total_amount, order.total_amount);
    assert.equal(res.body.created_at, T0.toISOString());
    assert.equal(res.body.updated_at, T1.toISOString());

    const fetched = await request(app).get(`/orders/${order.id}`).set('Authorization', AUTH);
    assert.equal(fetched.body.status, 'PAID');
  });

  it('AC2: a FAILED payment outcome marks the order PAYMENT_FAILED', async () => {
    const order = await createOrder();
    const res = await patchStatus(order.id, { status: 'PAYMENT_FAILED' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'PAYMENT_FAILED');
    const { rows } = await pool.query('select status from orders where id = $1', [order.id]);
    assert.equal(rows[0].status, 'PAYMENT_FAILED');
  });

  it('accepts a full Order body and only applies status', async () => {
    const order = await createOrder();
    const res = await patchStatus(order.id, {
      ...order,
      id: '00000000-0000-4000-8000-000000000000',
      total_amount: 1,
      currency: 'USD',
      status: 'PAID',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.id, order.id);
    assert.equal(res.body.total_amount, 50000);
    assert.equal(res.body.currency, 'INR');
    assert.equal(res.body.status, 'PAID');
  });

  it('lets a late success move a PAYMENT_FAILED order to PAID', async () => {
    const order = await createOrder();
    await patchStatus(order.id, { status: 'PAYMENT_FAILED' });
    const res = await patchStatus(order.id, { status: 'PAID' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'PAID');
  });

  it('treats a repeated notification as an idempotent 200 that changes nothing', async () => {
    const order = await createOrder();
    const first = await patchStatus(order.id, { status: 'PAID' });
    clock = new Date('2026-10-19T11:00:00.000Z');
    const second = await patchStatus(order.id, { status: 'PAID' });

    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
  });

  const invalid = [
    ['PAID', 'PAYMENT_FAILED'],
    ['PAID', 'PENDING_PAYMENT'],
    ['PAID', 'CANCELLED'],
    ['CANCELLED', 'PAID'],
    ['CANCELLED', 'PAYMENT_FAILED'],
    ['PAYMENT_FAILED', 'PENDING_PAYMENT'],
  ];
  for (const [from, to] of invalid) {
    it(`rejects ${from} -> ${to} with 409 and leaves the order unchanged`, async () => {
      const order = await createOrder();
      await setStatus(order.id, from);
      const res = await patchStatus(order.id, { status: to });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'invalid_status_transition');
      const { rows } = await pool.query('select status, updated_at from orders where id = $1', [order.id]);
      assert.equal(rows[0].status, from);
      assert.equal(new Date(rows[0].updated_at).toISOString(), T0.toISOString());
    });
  }

  it('returns 404 for an order that does not exist', async () => {
    const res = await patchStatus('3b0a9a51-1c1d-4b8e-9f2a-6a0d4e2c7b11', { status: 'PAID' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'order_not_found');
  });

  it('returns 404 for a malformed id', async () => {
    const res = await patchStatus('not-a-uuid', { status: 'PAID' });
    assert.equal(res.status, 404);
  });

  it('finds the order by an upper-cased id', async () => {
    const order = await createOrder();
    const res = await patchStatus(order.id.toUpperCase(), { status: 'PAID' });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, order.id);
  });

  for (const [label, body, message] of [
    ['a missing status', {}, 'is required'],
    ['an unknown status', { status: 'SUCCESS' }, undefined],
    ['a lower-case status', { status: 'paid' }, undefined],
    ['a non-object body', [], 'must be a JSON object'],
  ]) {
    it(`rejects ${label} with 400`, async () => {
      const order = await createOrder();
      const res = await patchStatus(order.id, body);

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_failed');
      if (message) assert.equal(res.body.error.details[0].message, message);
      const { rows } = await pool.query('select status from orders where id = $1', [order.id]);
      assert.equal(rows[0].status, 'PENDING_PAYMENT');
    });
  }

  it('requires a valid X-API-Key (a bearer token is not enough)', async () => {
    const order = await createOrder();
    const missing = await patchStatus(order.id, { status: 'PAID' }, null);
    const wrong = await patchStatus(order.id, { status: 'PAID' }, 'nope');
    const bearer = await request(app)
      .patch(`/orders/${order.id}/status`)
      .set('Authorization', AUTH)
      .send({ status: 'PAID' });

    for (const res of [missing, wrong, bearer]) {
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'unauthorized');
    }
    const { rows } = await pool.query('select status from orders where id = $1', [order.id]);
    assert.equal(rows[0].status, 'PENDING_PAYMENT');
  });

  it('rejects every api key when none are configured', async () => {
    const locked = createApp({ orders: createOrderRepository(pool), bearerTokens: ['test-token'] });
    const order = await createOrder();
    const res = await request(locked).patch(`/orders/${order.id}/status`).set('X-API-Key', '').send({ status: 'PAID' });
    assert.equal(res.status, 401);
  });
});

describe('orderRepository.updateStatus', () => {
  it('does not update when the order is no longer in the expected status', async () => {
    const order = await createOrder();
    const repo = createOrderRepository(pool);
    await setStatus(order.id, 'CANCELLED');

    const updated = await repo.updateStatus({ id: order.id, from: 'PENDING_PAYMENT', to: 'PAID', now: T1 });
    assert.equal(updated, null);
    assert.equal((await repo.findById(order.id)).status, 'CANCELLED');
  });
});

describe('checkTransition', () => {
  it('allows only the documented transitions', () => {
    const allowed = new Set([
      'PENDING_PAYMENT>PAID',
      'PENDING_PAYMENT>PAYMENT_FAILED',
      'PENDING_PAYMENT>CANCELLED',
      'PAYMENT_FAILED>PAID',
      'PAYMENT_FAILED>CANCELLED',
    ]);
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const expected = from === to ? 'unchanged' : allowed.has(`${from}>${to}`) ? 'allowed' : 'invalid';
        assert.equal(checkTransition(from, to), expected, `${from} -> ${to}`);
      }
    }
  });
});
