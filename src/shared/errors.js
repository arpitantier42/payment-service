/** Every error response body has the shape `{ error: { code, message, details? } }`. */
export function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details) error.details = details;
  return res.status(status).json({ error });
}

/** Final Express error handler: malformed JSON becomes 400, anything else 500. */
export function errorHandler(err, req, res, _next) {
  if (err.type === 'entity.parse.failed') {
    return sendError(res, 400, 'invalid_json', 'request body is not valid JSON');
  }
  if (err.type === 'entity.too.large') {
    return sendError(res, 413, 'payload_too_large', 'request body is too large');
  }
  console.error(err);
  return sendError(res, 500, 'internal_error', 'internal server error');
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
