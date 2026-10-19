import express from 'express';
import { apiKeyAuth } from '../shared/auth.js';
import { errorHandler, sendError } from '../shared/errors.js';

/**
 * Builds the reconciliation-worker HTTP app (CMP-006). Its endpoints are triggered by the
 * scheduler (the in-process interval in server.js, or an external cron presenting a key).
 * @param {{
 *   reconciler: { run(): Promise<object> },
 *   apiKeys: string[],               // scheduler credentials (X-API-Key)
 * }} deps
 */
export function createApp({ reconciler, apiKeys }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  const requireApiKey = apiKeyAuth(apiKeys);
  app.use('/internal', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // OP-007 reconcilePendingPayments · REQ-008, REQ-009, REQ-010 (REQ-011 audit)
  // 200 with the run summary once the batch completes; per-payment failures are reported in it
  // and retried by the next run.
  app.post('/internal/payments/reconciliation-runs', requireApiKey, async (req, res) => {
    res.status(200).json(await reconciler.run());
  });

  app.use((req, res) => sendError(res, 404, 'not_found', 'route not found'));
  app.use(errorHandler);
  return app;
}
