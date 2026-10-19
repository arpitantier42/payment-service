import { createHmac, timingSafeEqual } from 'node:crypto';
import { fetchUpstream, UpstreamError } from '../shared/retry.js';

/**
 * payment-gateway boundary (REQ-005, RSK-004). Everything provider-specific stays behind this
 * interface so initiatePayment does not change when Razorpay/Stripe is chosen:
 *
 *   createCheckoutSession({ credentials, payment, expiresAt })
 *     -> { gatewaySessionId, gatewayReference, checkoutUrl }
 *   getTransactionStatus({ credentials, payment })          (reconciliation-worker)
 *     -> { status: SUCCESS|FAILED|PENDING|EXPIRED|NOT_FOUND, gatewayStatus, gatewayReference, amount, currency }
 *
 * One call = one attempt; the caller wraps it in `withRetry`. Failures throw `UpstreamError`
 * (`retryable` for network errors, timeouts, 5xx, 429). Requests carry the payment id as the
 * gateway idempotency key, so a retried or resumed call returns the same session instead of
 * opening a second one.
 */

/**
 * Generic HTTP adapter for a provider-neutral checkout API:
 *   POST {baseUrl}/checkout/sessions   (Basic auth key_id:key_secret, Idempotency-Key header)
 *   body { reference, order_id, amount, currency, payment_method, expires_at }
 *   2xx  { id, transaction_id, checkout_url }
 * Replace the body mapping here when a concrete provider is selected.
 */
export function createHttpGateway({ name, baseUrl, timeoutMs = 10_000, fetchImpl = fetch }) {
  if (!baseUrl) throw new Error('payment gateway base URL is not set');
  const root = baseUrl.replace(/\/+$/, '');

  return {
    name,
    async createCheckoutSession({ credentials, payment, expiresAt }) {
      const auth = Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString('base64');
      const res = await fetchUpstream('payment gateway', `${root}/checkout/sessions`, {
        method: 'POST',
        timeoutMs,
        fetchImpl,
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/json',
          'idempotency-key': payment.id,
        },
        body: JSON.stringify({
          reference: payment.id,
          order_id: payment.order_id,
          amount: payment.amount,
          currency: payment.currency,
          payment_method: payment.payment_method,
          expires_at: expiresAt.toISOString(),
        }),
      });
      if (!res.ok) {
        throw new UpstreamError(`payment gateway rejected the checkout request (${res.status})`, { status: res.status });
      }
      const body = await res.json().catch(() => null);
      if (!body || typeof body.id !== 'string' || typeof body.checkout_url !== 'string') {
        throw new UpstreamError('payment gateway returned an unexpected checkout response');
      }
      return {
        gatewaySessionId: body.id,
        gatewayReference: typeof body.transaction_id === 'string' ? body.transaction_id : body.id,
        checkoutUrl: body.checkout_url,
      };
    },

    /**
     * Transaction status query used by reconciliation (OP-007, REQ-010):
     *   GET {baseUrl}/transactions/{payment id}   (the `reference` sent at checkout; Basic auth)
     *   2xx { status, amount?, currency?, transaction_id? }   404 = the gateway has no such transaction
     * Returns `parseTransactionStatus(body)` or `{ status: 'NOT_FOUND' }`.
     */
    async getTransactionStatus({ credentials, payment }) {
      const auth = Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString('base64');
      const res = await fetchUpstream('payment gateway', `${root}/transactions/${encodeURIComponent(payment.id)}`, {
        method: 'GET',
        timeoutMs,
        fetchImpl,
        headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
      });
      if (res.status === 404) return { status: TRANSACTION_NOT_FOUND, gatewayStatus: null };
      if (!res.ok) {
        throw new UpstreamError(`payment gateway rejected the status query (${res.status})`, { status: res.status });
      }
      const parsed = parseTransactionStatus(await res.json().catch(() => null));
      if (!parsed) throw new UpstreamError('payment gateway returned an unexpected status response');
      return parsed;
    },
  };
}

/**
 * Offline gateway for local runs (PAYMENT_GATEWAY_NAME=mock): accepts every checkout and reports
 * every transaction as `transactionStatus` (default "created": still awaiting the customer).
 */
export function createMockGateway({ checkoutBaseUrl = 'https://checkout.mock.invalid', transactionStatus = 'created' } = {}) {
  return {
    name: 'mock',
    async createCheckoutSession({ payment }) {
      return {
        gatewaySessionId: `mock_cs_${payment.id}`,
        gatewayReference: `mock_txn_${payment.id}`,
        checkoutUrl: `${checkoutBaseUrl}/${payment.id}`,
      };
    },
    async getTransactionStatus({ payment }) {
      return parseTransactionStatus({ status: transactionStatus, transaction_id: payment.gateway_reference });
    },
  };
}

/** `getTransactionStatus` result when the gateway has no record of the payment. */
export const TRANSACTION_NOT_FOUND = 'NOT_FOUND';

/**
 * Provider states a status query can report -> payment status. Adds the "no outcome yet" and
 * "checkout window lapsed" states a webhook never carries to the webhook mapping.
 */
const TRANSACTION_STATUS_MAP = Object.freeze({
  created: 'PENDING',
  open: 'PENDING',
  requires_payment_method: 'PENDING',
  expired: 'EXPIRED',
});

/**
 * Normalises a status-query body to `{ status, gatewayStatus, gatewayReference, amount, currency }`
 * (amount/currency/reference null when absent), or null when the status is not recognised.
 */
export function parseTransactionStatus(body) {
  if (!body || typeof body !== 'object' || typeof body.status !== 'string') return null;
  const key = body.status.toLowerCase();
  const status = Object.hasOwn(WEBHOOK_STATUS_MAP, key)
    ? WEBHOOK_STATUS_MAP[key]
    : Object.hasOwn(TRANSACTION_STATUS_MAP, key)
      ? TRANSACTION_STATUS_MAP[key]
      : undefined;
  if (!status) return null;
  return {
    status,
    gatewayStatus: body.status,
    gatewayReference: typeof body.transaction_id === 'string' ? body.transaction_id : null,
    amount: Number.isSafeInteger(body.amount) ? body.amount : null,
    currency: typeof body.currency === 'string' ? body.currency.toUpperCase() : null,
  };
}

/*
 * Inbound webhooks (OP-006, REQ-007). Provider-neutral contract, adapt here when a provider is
 * chosen:
 *   header  X-Gateway-Signature: hex HMAC-SHA256 of the raw request body with the webhook
 *           secret (an optional "sha256=" prefix is accepted)
 *   body    { event_id, payment_id?, gateway_reference?, status, amount, currency }
 *           payment_id is the `reference` sent at checkout; at least one of payment_id /
 *           gateway_reference identifies the payment. `status` is the provider's transaction
 *           state, mapped by WEBHOOK_STATUS_MAP.
 */

/** Provider transaction states -> payment status (SUCCESS = completed, FAILED = declined, PENDING = unresolved). */
const WEBHOOK_STATUS_MAP = Object.freeze({
  success: 'SUCCESS',
  succeeded: 'SUCCESS',
  captured: 'SUCCESS',
  completed: 'SUCCESS',
  paid: 'SUCCESS',
  failed: 'FAILED',
  declined: 'FAILED',
  pending: 'PENDING',
  processing: 'PENDING',
  authorized: 'PENDING',
});

export const signWebhookPayload = (rawBody, secret) => createHmac('sha256', secret).update(rawBody).digest('hex');

/** Constant-time check of `signature` against the HMAC of the raw body bytes. */
export function verifyWebhookSignature({ rawBody, signature, secret }) {
  if (!rawBody || !secret || typeof signature !== 'string') return false;
  const given = signature.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  return timingSafeEqual(Buffer.from(given.toLowerCase(), 'hex'), Buffer.from(signWebhookPayload(rawBody, secret), 'hex'));
}

/**
 * Normalises a verified webhook body. Returns `{ value }` with
 * `{ gatewayEventId, paymentId, gatewayReference, status, amount, currency, gatewayStatus }`,
 * or `{ errors: [{ field, message }] }`.
 */
export function parseWebhookPayload(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: 'body', message: 'must be a JSON object' }] };
  }
  const str = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= 255;
  if (!str(body.event_id)) errors.push({ field: 'event_id', message: 'is required' });
  if (body.payment_id != null && !str(body.payment_id)) errors.push({ field: 'payment_id', message: 'must be a string' });
  if (body.gateway_reference != null && !str(body.gateway_reference)) {
    errors.push({ field: 'gateway_reference', message: 'must be a string' });
  }
  if (body.payment_id == null && body.gateway_reference == null) {
    errors.push({ field: 'payment_id', message: 'payment_id or gateway_reference is required' });
  }
  const key = typeof body.status === 'string' ? body.status.toLowerCase() : '';
  const status = Object.hasOwn(WEBHOOK_STATUS_MAP, key) ? WEBHOOK_STATUS_MAP[key] : undefined;
  if (!status) errors.push({ field: 'status', message: 'is not a recognised transaction status' });
  if (!Number.isSafeInteger(body.amount) || body.amount <= 0) {
    errors.push({ field: 'amount', message: 'must be a positive integer in minor units' });
  }
  if (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency)) {
    errors.push({ field: 'currency', message: 'must be a 3-letter currency code' });
  }
  if (errors.length) return { errors };
  return {
    value: {
      gatewayEventId: body.event_id,
      paymentId: body.payment_id ?? null,
      gatewayReference: body.gateway_reference ?? null,
      status,
      gatewayStatus: body.status,
      amount: body.amount,
      currency: body.currency.toUpperCase(),
    },
  };
}
