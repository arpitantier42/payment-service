import { timingSafeEqual } from 'node:crypto';
import { sendError } from './errors.js';

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * `bearer` security scheme: requires `Authorization: Bearer <token>` matching one of `tokens`.
 * Placeholder for a real identity provider; tokens come from configuration.
 */
export function bearerAuth(tokens) {
  const allowed = tokens.filter(Boolean);
  return (req, res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    if (!match || !allowed.some((t) => safeEqual(t, match[1]))) {
      res.set('WWW-Authenticate', 'Bearer');
      return sendError(res, 401, 'unauthorized', 'a valid bearer token is required');
    }
    next();
  };
}

/**
 * `api_key` security scheme for internal service-to-service endpoints: requires an
 * `X-API-Key` header matching one of `keys` (from configuration).
 */
export function apiKeyAuth(keys) {
  const allowed = keys.filter(Boolean);
  return (req, res, next) => {
    const key = req.get('x-api-key') ?? '';
    if (!key || !allowed.some((k) => safeEqual(k, key))) {
      return sendError(res, 401, 'unauthorized', 'a valid X-API-Key header is required');
    }
    next();
  };
}
