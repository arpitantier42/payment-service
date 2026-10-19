import { fetchUpstream, UpstreamError } from '../shared/retry.js';

/**
 * payment-gateway boundary (REQ-005, RSK-004). Everything provider-specific stays behind this
 * interface so initiatePayment does not change when Razorpay/Stripe is chosen:
 *
 *   createCheckoutSession({ credentials, payment, expiresAt })
 *     -> { gatewaySessionId, gatewayReference, checkoutUrl }
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
  };
}

/** Offline gateway for local runs (PAYMENT_GATEWAY_NAME=mock): accepts every checkout. */
export function createMockGateway({ checkoutBaseUrl = 'https://checkout.mock.invalid' } = {}) {
  return {
    name: 'mock',
    async createCheckoutSession({ payment }) {
      return {
        gatewaySessionId: `mock_cs_${payment.id}`,
        gatewayReference: `mock_txn_${payment.id}`,
        checkoutUrl: `${checkoutBaseUrl}/${payment.id}`,
      };
    },
  };
}
