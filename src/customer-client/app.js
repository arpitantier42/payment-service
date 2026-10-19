import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { errorHandler, sendError } from '../shared/errors.js';
import { createMockCheckoutRouter } from './mockCheckout.js';
// Same validators the browser runs, so the rules are enforced server-side too.
import { buildOrderRequest, isPendingOrder, validatePaymentRequest } from './public/checkout.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

/**
 * Builds the customer-client app (CMP-008): serves the browser UI from `public/` and a thin
 * same-origin API ("backend for frontend") that calls order-service and payment-service with the
 * client's bearer tokens, so no service credential reaches the browser. Upstream answers (status
 * and body, including errors) are passed through unchanged.
 * @param {{
 *   orderServiceUrl: string, orderServiceToken: string,
 *   paymentServiceUrl: string, paymentServiceToken: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   mockCheckout?: { webhookUrl: string, getWebhookSecret(): Promise<string> } | null,
 *   now?: () => Date,
 * }} deps  `mockCheckout` mounts the dev-only stand-in for the gateway's hosted checkout page.
 */
export function createApp({
  orderServiceUrl,
  orderServiceToken,
  paymentServiceUrl,
  paymentServiceToken,
  timeoutMs = 10_000,
  fetchImpl = fetch,
  mockCheckout = null,
  now = () => new Date(),
}) {
  const orderRoot = orderServiceUrl.replace(/\/+$/, '');
  const paymentRoot = paymentServiceUrl.replace(/\/+$/, '');

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  /** Calls an upstream service: `{ status, contentType, text }`, or null when it cannot be reached. */
  async function call(name, url, { method = 'GET', token, headers = {}, body }) {
    try {
      const upstream = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: upstream.status, contentType: upstream.headers.get('content-type'), text: await upstream.text() };
    } catch (err) {
      console.error(`${name} unreachable: ${err?.message ?? err}`);
      return null;
    }
  }

  const unavailable = (res, name) =>
    sendError(res, 503, `${name.replace('-', '_')}_unavailable`, `${name} could not be reached; try again`);

  /** Sends an upstream answer (status + body) unchanged. */
  function pass(res, upstream) {
    res.status(upstream.status);
    if (!upstream.text) return res.end();
    res.type(upstream.contentType ?? 'application/json').send(upstream.text);
  }

  /** Calls an upstream service and relays its status + JSON body; 503 when it cannot be reached. */
  async function relay(res, name, url, init) {
    const upstream = await call(name, url, init);
    return upstream ? pass(res, upstream) : unavailable(res, name);
  }

  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const api = express.Router();
  api.use(express.json({ limit: '10kb' }));
  // Orders and payments are per-customer and change over time; never cache them.
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // REQ-001: place an order -> OP-001 createOrder. The client validates the order before sending
  // it, and only reports success for a new order with a UUID id in status PENDING_PAYMENT; any
  // other 201 is a contract break (502), so the customer is never sent on to pay a wrong order.
  api.post('/orders', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { value, errors } = buildOrderRequest({
      customerId: body.customer_id,
      totalAmount: body.total_amount,
      currency: body.currency,
    });
    if (errors) return sendError(res, 400, 'validation_failed', 'required order fields are missing or invalid', errors);

    const upstream = await call('order-service', `${orderRoot}/orders`, { method: 'POST', token: orderServiceToken, body: value });
    if (!upstream) return unavailable(res, 'order-service');
    if (upstream.status !== 201) return pass(res, upstream);
    const order = parse(upstream.text);
    if (!isPendingOrder(order)) {
      console.error('order-service returned a created order that is not a PENDING_PAYMENT order with a UUID id');
      return sendError(res, 502, 'unexpected_order_response', 'the order could not be confirmed; try again');
    }
    res.status(201).json(order);
  });

  // OP-002 getOrder: lets the result page show the order status after checkout.
  api.get('/orders/:orderId', (req, res) =>
    relay(res, 'order-service', `${orderRoot}/orders/${encodeURIComponent(req.params.orderId)}`, {
      token: orderServiceToken,
    }),
  );

  // REQ-002: payment initiation -> OP-004 initiatePayment. The browser owns the Idempotency-Key
  // (kept per order + request, replayed on retry); it is forwarded untouched. Enforced here before
  // anything reaches payment-service (which checks both again):
  //   1. order id, amount, currency, payment method and the key are required -> 400
  //   2. the order must exist at order-service -> 404 order_not_found, no payment is created
  api.post('/payments', async (req, res) => {
    const key = req.get('idempotency-key');
    const { value, errors } = validatePaymentRequest(req.body, key);
    if (errors) return sendError(res, 400, 'validation_failed', 'required payment fields are missing or invalid', errors);

    const order = await call('order-service', `${orderRoot}/orders/${encodeURIComponent(value.order_id)}`, {
      token: orderServiceToken,
    });
    if (!order || (order.status !== 200 && order.status !== 404)) return unavailable(res, 'order-service');
    if (order.status === 404) {
      return sendError(res, 404, 'order_not_found', 'the order id does not reference an existing order');
    }

    return relay(res, 'payment-service', `${paymentRoot}/payments`, {
      method: 'POST',
      token: paymentServiceToken,
      headers: { 'idempotency-key': key },
      body: value,
    });
  });

  // OP-005 getPayment: polled after the customer returns from the hosted checkout (REQ-006).
  api.get('/payments/:paymentId', (req, res) =>
    relay(res, 'payment-service', `${paymentRoot}/payments/${encodeURIComponent(req.params.paymentId)}`, {
      token: paymentServiceToken,
    }),
  );

  api.use((req, res) => sendError(res, 404, 'not_found', 'route not found'));
  app.use('/api', api);

  if (mockCheckout) {
    app.use(
      '/mock-checkout',
      createMockCheckoutRouter({
        ...mockCheckout,
        getPayment: async (paymentId) => {
          const res = await fetchImpl(`${paymentRoot}/payments/${encodeURIComponent(paymentId)}`, {
            headers: { authorization: `Bearer ${paymentServiceToken}`, accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (res.status === 404) return null;
          if (!res.ok) throw new Error(`payment-service responded ${res.status}`);
          return res.json();
        },
        fetchImpl,
        timeoutMs,
        now,
      }),
    );
  }

  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

  app.use((req, res) => sendError(res, 404, 'not_found', 'route not found'));
  app.use(errorHandler);
  return app;
}
