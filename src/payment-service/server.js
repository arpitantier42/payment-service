import { createPool } from '../shared/db.js';
import { createEncryptedSecretsManager } from '../shared/secrets.js';
import { createApp } from './app.js';
import { createHttpGateway, createMockGateway } from './gateway.js';
import { createOrderClient } from './orderClient.js';
import { createPaymentRepository } from './paymentRepository.js';

const env = process.env;
const port = Number(env.PAYMENT_SERVICE_PORT ?? 3002);
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

const bearerTokens = csv('PAYMENT_SERVICE_BEARER_TOKENS');
if (bearerTokens.length === 0) {
  console.warn('PAYMENT_SERVICE_BEARER_TOKENS is empty: every bearer-authenticated request will get 401');
}

// Retry policy for outbound calls (NFR-004, RSK-005: configurable, not hard-coded).
const retryPolicy = {
  attempts: Math.max(1, int('PAYMENT_GATEWAY_RETRY_ATTEMPTS', 3)),
  baseDelayMs: int('PAYMENT_GATEWAY_RETRY_BASE_DELAY_MS', 200),
  factor: 2,
};

const gatewayName = env.PAYMENT_GATEWAY_NAME ?? 'mock';
const gateway =
  gatewayName === 'mock'
    ? createMockGateway()
    : createHttpGateway({
        name: gatewayName,
        baseUrl: required('PAYMENT_GATEWAY_BASE_URL'),
        timeoutMs: int('PAYMENT_GATEWAY_TIMEOUT_MS', 10_000),
      });

const secrets = createEncryptedSecretsManager({
  encryptedGatewayCredentials: required('PAYMENT_GATEWAY_CREDENTIALS_ENCRYPTED'),
  masterKey: required('SECRETS_MASTER_KEY'),
});
// Fail at startup rather than on the first payment if the credentials cannot be decrypted.
await secrets.getGatewayCredentials();

const orders = createOrderClient({
  baseUrl: required('ORDER_SERVICE_URL'),
  token: required('ORDER_SERVICE_TOKEN'),
  timeoutMs: int('ORDER_SERVICE_TIMEOUT_MS', 3_000),
  retryPolicy,
});

const pool = createPool(env.DATABASE_URL);
const app = createApp({
  payments: createPaymentRepository(pool),
  orders,
  gateway,
  secrets,
  bearerTokens,
  checkoutTtlMs: int('CHECKOUT_SESSION_TTL_MINUTES', 15) * 60 * 1000,
  gatewayRetryPolicy: retryPolicy,
});

const server = app.listen(port, () => console.log(`payment-service listening on :${port} (gateway: ${gateway.name})`));

function shutdown() {
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
