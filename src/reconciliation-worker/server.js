import { createPool } from '../shared/db.js';
import { createEncryptedSecretsManager } from '../shared/secrets.js';
import { createHttpGateway, createMockGateway } from '../payment-service/gateway.js';
import { createOrderClient } from '../payment-service/orderClient.js';
import { createPaymentRepository } from '../payment-service/paymentRepository.js';
import { createApp } from './app.js';
import { createReconciler } from './reconciler.js';
import { createSessionExpirer } from './sessionExpirer.js';

const env = process.env;
const port = Number(env.RECONCILIATION_WORKER_PORT ?? 3003);
const csv = (name) =>
  (env[name] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
const int = (name, fallback) => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
};
const required = (name) => {
  if (!env[name]) throw new Error(`${name} is not set`);
  return env[name];
};

const apiKeys = csv('RECONCILIATION_WORKER_API_KEYS');
if (apiKeys.length === 0) {
  console.warn('RECONCILIATION_WORKER_API_KEYS is empty: runs can only be started by the in-process schedule');
}

// NFR-004 / RSK-005: retry, threshold, batch and interval are configuration, not hard-coded.
const retryPolicy = {
  attempts: Math.max(1, int('PAYMENT_GATEWAY_RETRY_ATTEMPTS', 3)),
  baseDelayMs: int('PAYMENT_GATEWAY_RETRY_BASE_DELAY_MS', 200),
  factor: 2,
};

const gatewayName = env.PAYMENT_GATEWAY_NAME ?? 'mock';
const gateway =
  gatewayName === 'mock'
    ? createMockGateway({ transactionStatus: env.MOCK_GATEWAY_TRANSACTION_STATUS || 'created' })
    : createHttpGateway({
        name: gatewayName,
        baseUrl: required('PAYMENT_GATEWAY_BASE_URL'),
        timeoutMs: int('PAYMENT_GATEWAY_TIMEOUT_MS', 10_000),
      });

const secrets = createEncryptedSecretsManager({
  encryptedGatewayCredentials: required('PAYMENT_GATEWAY_CREDENTIALS_ENCRYPTED'),
  masterKey: required('SECRETS_MASTER_KEY'),
});
await secrets.getGatewayCredentials(); // fail at startup if they cannot be decrypted

const orders = createOrderClient({
  baseUrl: required('ORDER_SERVICE_URL'),
  // X-API-Key for PATCH /orders/{id}/status (one of order-service's ORDER_SERVICE_API_KEYS).
  apiKey: required('ORDER_SERVICE_API_KEY'),
  timeoutMs: int('ORDER_SERVICE_TIMEOUT_MS', 3_000),
  retryPolicy,
});

const pool = createPool(required('DATABASE_URL'));
const reconciler = createReconciler({
  payments: createPaymentRepository(pool),
  orders,
  gateway,
  secrets,
  thresholdMs: int('RECONCILIATION_THRESHOLD_MINUTES', 10) * 60 * 1000,
  batchSize: Math.max(1, int('RECONCILIATION_BATCH_SIZE', 100)),
  gatewayRetryPolicy: retryPolicy,
});

const sessionExpirer = createSessionExpirer({
  payments: createPaymentRepository(pool),
  orders,
  graceMs: int('SESSION_EXPIRY_GRACE_SECONDS', 60) * 1000,
  batchSize: Math.max(1, int('SESSION_EXPIRY_BATCH_SIZE', int('RECONCILIATION_BATCH_SIZE', 100))),
});

const app = createApp({ reconciler, sessionExpirer, apiKeys });
const server = app.listen(port, () => console.log(`reconciliation-worker listening on :${port} (gateway: ${gateway.name})`));

// The schedule (default every 15 minutes); 0 leaves triggering to an external scheduler.
const intervalMinutes = int('RECONCILIATION_INTERVAL_MINUTES', 15);
async function scheduledRun() {
  try {
    const run = await reconciler.run();
    console.log(`reconciliation run ${run.run_id}: examined ${run.examined} ${JSON.stringify(run.outcomes)}`);
  } catch (err) {
    console.error(`reconciliation run failed: ${err.stack ?? err}`);
  }
}
const timer = intervalMinutes > 0 ? setInterval(scheduledRun, intervalMinutes * 60 * 1000) : null;

// OP-008 schedule (default every 5 minutes, so a session is expired at most TTL + grace + 5 min
// after creation); 0 leaves triggering to an external scheduler.
const expiryIntervalMinutes = int('SESSION_EXPIRY_INTERVAL_MINUTES', 5);
async function scheduledExpiry() {
  try {
    const run = await sessionExpirer.run();
    if (run.examined) console.log(`session expiry run ${run.run_id}: examined ${run.examined} ${JSON.stringify(run.outcomes)}`);
  } catch (err) {
    console.error(`session expiry run failed: ${err.stack ?? err}`);
  }
}
const expiryTimer = expiryIntervalMinutes > 0 ? setInterval(scheduledExpiry, expiryIntervalMinutes * 60 * 1000) : null;

function shutdown() {
  if (timer) clearInterval(timer);
  if (expiryTimer) clearInterval(expiryTimer);
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
