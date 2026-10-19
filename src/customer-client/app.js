import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { errorHandler, sendError } from '../shared/errors.js';
import { createMockCheckoutRouter } from './mockCheckout.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

/** Copies only `keys` from a JSON object body; anything else is forwarded as-is for upstream to reject. */
const pick = (body, keys) =>
  body && typeof body === 'object' && !Array.isArray(body)
    ? Object.fromEntries(keys.filter((k) => Object.hasOwn(body, k)).map((k) => [k, body[k]]))
    : body;

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

  /** Calls an upstream service and relays its status + JSON body; 503 when it cannot be reached. */
  async function relay(res, name, url, { method = 'GET', token, headers = {}, body }) {
    let upstream;
    try {
      upstream = await fetchImpl(url, {
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
    } catch (err) {
      console.error(`${name} unreachable: ${err?.message ?? err}`);
      return sendError(res, 503, `${name.replace('-', '_')}_unavailable`, `${name} could not be reached; try again`);
    }
    const text = await upstream.text();
    res.status(upstream.status);
    if (!text) return res.end();
    res.type(upstream.headers.get('content-type') ?? 'application/json').send(text);
  }

  const api = express.Router();
  api.use(express.json({ limit: '10kb' }));
  // Orders and payments are per-customer and change over time; never cache them.
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // REQ-001: place an order -> OP-001 createOrder (order-service answers 201 PENDING_PAYMENT).
  api.post('/orders', (req, res) =>
    relay(res, 'order-service', `${orderRoot}/orders`, {
      method: 'POST',
      token: orderServiceToken,
      body: pick(req.body ?? {}, ['customer_id', 'total_amount', 'currency']),
    }),
  );

  // OP-002 getOrder: lets the result page show the order status after checkout.
  api.get('/orders/:orderId', (req, res) =>
    relay(res, 'order-service', `${orderRoot}/orders/${encodeURIComponent(req.params.orderId)}`, {
      token: orderServiceToken,
    }),
  );

  // REQ-002: payment initiation -> OP-004 initiatePayment. The browser owns the Idempotency-Key
  // (kept per order + request, replayed on retry); it is forwarded untouched.
  api.post('/payments', (req, res) => {
    const key = req.get('idempotency-key');
    return relay(res, 'payment-service', `${paymentRoot}/payments`, {
      method: 'POST',
      token: paymentServiceToken,
      headers: key !== undefined ? { 'idempotency-key': key } : {},
      body: pick(req.body ?? {}, ['order_id', 'amount', 'currency', 'payment_method']),
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
