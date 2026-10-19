import { fetchUpstream, UpstreamError, withRetry } from '../shared/retry.js';

/**
 * order-service client for payment-service (OP-002 getOrder). Uses a service bearer token from
 * configuration. GETs are safe to repeat, so transient failures are retried with `retryPolicy`.
 */
export function createOrderClient({ baseUrl, token, apiKey, timeoutMs = 3_000, retryPolicy, fetchImpl = fetch, sleep }) {
  if (!baseUrl) throw new Error('order-service base URL is not set');
  const root = baseUrl.replace(/\/+$/, '');

  return {
    /** Returns the trusted `Order`, or null when order-service answers 404. */
    async getOrder(orderId) {
      return withRetry(
        async () => {
          const res = await fetchUpstream('order-service', `${root}/orders/${encodeURIComponent(orderId)}`, {
            method: 'GET',
            timeoutMs,
            fetchImpl,
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          });
          if (res.status === 404) return null;
          if (!res.ok) throw new UpstreamError(`order-service responded ${res.status}`, { status: res.status });
          return res.json();
        },
        retryPolicy,
        sleep ? { sleep } : undefined,
      );
    },

    /**
     * OP-003 updateOrderPaymentStatus (REQ-009), authenticated with `X-API-Key`. Setting a status
     * is idempotent, so transient failures are retried; throws `UpstreamError` once they are
     * exhausted. Returns `{ outcome: 'applied' | 'conflict' | 'not_found', order? }`: 409 means the
     * order moved on (don't retry), 404 an unknown order.
     */
    async updateOrderStatus(orderId, status) {
      if (!apiKey) throw new UpstreamError('order-service API key is not configured');
      return withRetry(
        async () => {
          const res = await fetchUpstream('order-service', `${root}/orders/${encodeURIComponent(orderId)}/status`, {
            method: 'PATCH',
            timeoutMs,
            fetchImpl,
            headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ status }),
          });
          if (res.status === 404) return { outcome: 'not_found' };
          if (res.status === 409) return { outcome: 'conflict' };
          if (!res.ok) throw new UpstreamError(`order-service responded ${res.status}`, { status: res.status });
          return { outcome: 'applied', order: await res.json() };
        },
        retryPolicy,
        sleep ? { sleep } : undefined,
      );
    },
  };
}
