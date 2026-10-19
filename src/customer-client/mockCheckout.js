import { randomUUID } from 'node:crypto';
import express from 'express';
import { signWebhookPayload } from '../payment-service/gateway.js';

/**
 * DEV ONLY: stand-in for the payment gateway's hosted checkout page, for local runs with the mock
 * gateway (whose checkout_url points here). A real gateway hosts this page itself.
 *
 *   GET  /mock-checkout/{paymentId}   page offering only the method chosen at initiation (REQ-006)
 *   POST /mock-checkout/{paymentId}   form: payment_method, outcome=pay|decline -> signed webhook
 *                                     to payment-service, then 303 back to /?payment_id=...
 *
 * Like a real hosted checkout it refuses sessions that are no longer ACTIVE or are past
 * `expires_at` (410), and payments that already have an outcome (409).
 */
export function createMockCheckoutRouter({ getPayment, webhookUrl, getWebhookSecret, fetchImpl = fetch, timeoutMs = 10_000, now = () => new Date() }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '2kb' }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  /** Loads the payment and checks the session can still be paid; sends the error page if not. */
  async function loadPayable(req, res) {
    const payment = await getPayment(req.params.paymentId);
    if (!payment) {
      page(res, 404, 'Checkout not found', '<p>This checkout link does not match any payment.</p>');
      return null;
    }
    const session = payment.checkout_session;
    if (!['INITIATED', 'PENDING', 'EXPIRED'].includes(payment.status)) {
      page(res, 409, 'Checkout already completed', `<p>This payment is already ${esc(payment.status)}.</p>${backLink(payment)}`);
      return null;
    }
    if (!session || session.status !== 'ACTIVE' || new Date(session.expires_at) <= now()) {
      page(
        res,
        410,
        'Checkout session expired',
        `<p>This checkout session has expired. Return to the shop and start a new payment.</p>${backLink(payment)}`,
      );
      return null;
    }
    return payment;
  }

  router.get('/:paymentId', async (req, res) => {
    const payment = await loadPayable(req, res);
    if (!payment) return;
    const id = esc(payment.id);
    page(
      res,
      200,
      'Mock gateway checkout',
      `<p class="note">Development stand-in for the gateway's hosted checkout. No money moves.</p>
<dl>
  <dt>Amount</dt><dd>${esc(formatAmount(payment.amount, payment.currency))}</dd>
  <dt>Payment method</dt><dd data-testid="method">${esc(payment.payment_method)}</dd>
  <dt>Session expires</dt><dd>${esc(payment.checkout_session.expires_at)}</dd>
</dl>
<form method="post" action="/mock-checkout/${id}">
  <input type="hidden" name="payment_method" value="${esc(payment.payment_method)}">
  <button type="submit" name="outcome" value="pay">Pay with ${esc(payment.payment_method)}</button>
  <button type="submit" name="outcome" value="decline" class="secondary">Decline</button>
</form>`,
    );
  });

  router.post('/:paymentId', async (req, res) => {
    const payment = await loadPayable(req, res);
    if (!payment) return;
    const { outcome, payment_method: method } = req.body ?? {};
    if (method !== payment.payment_method) {
      return page(res, 400, 'Payment method not allowed', `<p>This checkout was opened for ${esc(payment.payment_method)}.</p>`);
    }
    if (outcome !== 'pay' && outcome !== 'decline') {
      return page(res, 400, 'Invalid request', '<p>Choose pay or decline.</p>');
    }

    // Same contract as a real gateway webhook (see payment-service gateway.js).
    const rawBody = JSON.stringify({
      event_id: `mock_evt_${randomUUID()}`,
      payment_id: payment.id,
      gateway_reference: payment.gateway_reference,
      status: outcome === 'pay' ? 'captured' : 'failed',
      amount: payment.amount,
      currency: payment.currency,
      payment_method: payment.payment_method,
    });
    let delivered = false;
    try {
      const res2 = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gateway-signature': signWebhookPayload(rawBody, await getWebhookSecret()),
        },
        body: rawBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
      delivered = res2.ok;
      if (!delivered) console.error(`mock checkout: webhook answered ${res2.status}`);
    } catch (err) {
      console.error(`mock checkout: webhook delivery failed: ${err?.message ?? err}`);
    }
    if (!delivered) {
      return page(res, 502, 'Payment not confirmed', `<p>The payment result could not be delivered. Try again.</p>`);
    }
    res.redirect(303, returnUrl(payment));
  });

  return router;
}

const returnUrl = (payment) =>
  `/?payment_id=${encodeURIComponent(payment.id)}&order_id=${encodeURIComponent(payment.order_id)}`;
const backLink = (payment) => `<p><a href="${esc(returnUrl(payment))}">Back to the shop</a></p>`;

function formatAmount(amount, currency) {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(res, status, title, body) {
  res
    .status(status)
    .type('html')
    .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/style.css"></head>
<body><main class="card"><h1>${esc(title)}</h1>${body}</main></body></html>`);
}
