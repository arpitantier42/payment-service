import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../../src/order-service/app.js';
import { createOrderRepository } from '../../src/order-service/orderRepository.js';
import { createTestPool } from '../helpers/db.js';

const TOKEN = 'test-token';
const AUTH = `Bearer ${TOKEN}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validOrder = () => ({
  customer_id: '6f1c2b0e-7f43-4a51-9a8e-2d6f3c1b9e01',
  total_amount: 129900,
  currency: 'INR',
});

let pool;
let app;

beforeEach(async () => {
  pool = await createTestPool('order-db');
  app = createApp({ orders: createOrderRepository(pool), bearerTokens: [TOKEN] });
});

afterEach(async () => {
  await pool.end();
});

describe('POST /orders', () => {
  it('creates an order with status PENDING_PAYMENT and persists it', async () => {
    const res = await request(app).post('/orders').set('Authorization', AUTH).send(validOrder());

    assert.equal(res.status, 201);
    assert.match(res.body.id, UUID_RE);
    assert.equal(res.headers.location, `/orders/${res.body.id}`);
    assert.equal(res.body.status, 'PENDING_PAYMENT');
    assert.equal(res.body.customer_id, validOrder().customer_id);
    assert.equal(res.body.total_amount, 129900);
    assert.equal(res.body.currency, 'INR');
    assert.ok(!Number.isNaN(Date.parse(res.body.created_at)));
    assert.equal(res.body.updated_at, res.body.created_at);

    const { rows } = await pool.query('select * from orders where id = $1', [res.body.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'PENDING_PAYMENT');
  });

  it('assigns a unique id to every order', async () => {
    const ids = new Set();
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/orders').set('Authorization', AUTH).send(validOrder());
      assert.equal(res.status, 201);
      ids.add(res.body.id);
    }
    assert.equal(ids.size, 5);
  });

  it('ignores server-owned fields supplied by the client', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', AUTH)
      .send({ ...validOrder(), id: '00000000-0000-4000-8000-000000000000', status: 'PAID' });

    assert.equal(res.status, 201);
    assert.notEqual(res.body.id, '00000000-0000-4000-8000-000000000000');
    assert.equal(res.body.status, 'PENDING_PAYMENT');
  });

  for (const field of ['customer_id', 'total_amount', 'currency']) {
    it(`rejects a missing ${field} with 400`, async () => {
      const body = validOrder();
      delete body[field];
      const res = await request(app).post('/orders').set('Authorization', AUTH).send(body);

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_failed');
      assert.deepEqual(res.body.error.details, [{ field, message: 'is required' }]);
    });
  }

  const invalid = [
    ['customer_id', 'not-a-uuid'],
    ['customer_id', 42],
    ['total_amount', 0],
    ['total_amount', -100],
    ['total_amount', 10.5],
    ['total_amount', '1000'],
    ['total_amount', Number.MAX_SAFE_INTEGER + 1],
    ['currency', 'inr'],
    ['currency', 'RUPEES'],
  ];
  for (const [field, value] of invalid) {
    it(`rejects ${field}=${JSON.stringify(value)} with 400`, async () => {
      const res = await request(app)
        .post('/orders')
        .set('Authorization', AUTH)
        .send({ ...validOrder(), [field]: value });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.details[0].field, field);
    });
  }

  it('rejects malformed JSON with 400', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .send('{"customer_id":');

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_json');
  });

  it('rejects an empty body with 400 and creates nothing', async () => {
    const res = await request(app).post('/orders').set('Authorization', AUTH).send();

    assert.equal(res.status, 400);
    const { rows } = await pool.query('select count(*)::int as n from orders');
    assert.equal(rows[0].n, 0);
  });

  it('requires a valid bearer token', async () => {
    const missing = await request(app).post('/orders').send(validOrder());
    const wrong = await request(app).post('/orders').set('Authorization', 'Bearer nope').send(validOrder());

    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    const { rows } = await pool.query('select count(*)::int as n from orders');
    assert.equal(rows[0].n, 0);
  });
});

describe('GET /orders/:orderId', () => {
  it('returns the order with its status and trusted payable amount', async () => {
    const created = await request(app).post('/orders').set('Authorization', AUTH).send(validOrder());
    const res = await request(app).get(`/orders/${created.body.id}`).set('Authorization', AUTH);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, created.body);
  });

  it('finds an order by an upper-cased id', async () => {
    const created = await request(app).post('/orders').set('Authorization', AUTH).send(validOrder());
    const res = await request(app).get(`/orders/${created.body.id.toUpperCase()}`).set('Authorization', AUTH);

    assert.equal(res.status, 200);
    assert.equal(res.body.id, created.body.id);
  });

  it('returns 404 for an id that does not exist', async () => {
    const res = await request(app)
      .get('/orders/3b0a9a51-1c1d-4b8e-9f2a-6a0d4e2c7b11')
      .set('Authorization', AUTH);

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'order_not_found');
  });

  it('returns 404 for a malformed id', async () => {
    const res = await request(app).get('/orders/not-a-uuid').set('Authorization', AUTH);
    assert.equal(res.status, 404);
  });

  it('requires a valid bearer token', async () => {
    const created = await request(app).post('/orders').set('Authorization', AUTH).send(validOrder());
    const res = await request(app).get(`/orders/${created.body.id}`);
    assert.equal(res.status, 401);
  });
});
