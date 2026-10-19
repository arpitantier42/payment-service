import { fetchUpstream, UpstreamError, withRetry } from '../shared/retry.js';

/**
 * order-service client for payment-service (OP-002 getOrder). Uses a service bearer token from
 * configuration. GETs are safe to repeat, so transient failures are retried with `retryPolicy`.
 */
export function createOrderClient({ baseUrl, token, timeoutMs = 3_000, retryPolicy, fetchImpl = fetch, sleep }) {
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
  };
}
