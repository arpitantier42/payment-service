import { setTimeout as delay } from 'node:timers/promises';

/** Default retry policy for outbound calls (NFR-004): 3 attempts, exponential backoff 200ms, 400ms. */
export const DEFAULT_RETRY_POLICY = Object.freeze({ attempts: 3, baseDelayMs: 200, factor: 2 });

/**
 * Error thrown by outbound clients. `retryable` marks transient failures (network error,
 * timeout, 5xx, 429) that `withRetry` may try again; anything else fails immediately.
 */
export class UpstreamError extends Error {
  constructor(message, { retryable = false, status, cause } = {}) {
    super(message, { cause });
    this.name = 'UpstreamError';
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * Runs `fn(attempt)` up to `policy.attempts` times, waiting baseDelayMs * factor^(n-1) between
 * attempts, while the thrown error has `retryable === true`. Rethrows the last error with
 * `attempts` (how many were made) set on it. Only wrap calls that are safe to repeat (idempotent
 * or keyed by an idempotency key).
 */
export async function withRetry(fn, policy = DEFAULT_RETRY_POLICY, { sleep = delay } = {}) {
  const { attempts, baseDelayMs, factor } = { ...DEFAULT_RETRY_POLICY, ...policy };
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!err?.retryable || attempt >= attempts) {
        if (err && typeof err === 'object') err.attempts = attempt;
        throw err;
      }
      await sleep(baseDelayMs * factor ** (attempt - 1));
    }
  }
}

/**
 * `fetch` with a per-call timeout that maps failures to `UpstreamError`: network errors,
 * timeouts, 5xx and 429 are retryable; other statuses are returned to the caller as-is.
 */
export async function fetchUpstream(name, url, { timeoutMs, fetchImpl = fetch, ...init }) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new UpstreamError(`${name} ${timedOut ? 'timed out' : 'unreachable'}`, { retryable: true, cause: err });
  }
  if (res.status >= 500 || res.status === 429) {
    throw new UpstreamError(`${name} responded ${res.status}`, { retryable: true, status: res.status });
  }
  return res;
}
