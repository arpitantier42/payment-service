import { createEncryptedSecretsManager } from '../shared/secrets.js';
import { createApp } from './app.js';

const env = process.env;
const port = Number(env.CUSTOMER_CLIENT_PORT ?? 3000);
const required = (name) => {
  if (!env[name]) throw new Error(`${name} is not set`);
  return env[name];
};
const timeoutMs = Number(env.CUSTOMER_CLIENT_UPSTREAM_TIMEOUT_MS ?? 10_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error('CUSTOMER_CLIENT_UPSTREAM_TIMEOUT_MS must be a positive integer');
}

const paymentServiceUrl = required('PAYMENT_SERVICE_URL');

// Dev only: stand-in for the gateway's hosted checkout page (pairs with payment-service's
// PAYMENT_GATEWAY_NAME=mock + MOCK_GATEWAY_CHECKOUT_BASE_URL). It signs webhooks, so it needs the
// sealed webhook secret; never enable it against a real gateway.
let mockCheckout = null;
if (env.MOCK_CHECKOUT_ENABLED === 'true') {
  const secrets = createEncryptedSecretsManager({
    encryptedGatewayCredentials: '',
    encryptedWebhookSecret: required('PAYMENT_GATEWAY_WEBHOOK_SECRET_ENCRYPTED'),
    masterKey: required('SECRETS_MASTER_KEY'),
  });
  await secrets.getWebhookSecret(); // fail at startup if it cannot be decrypted
  mockCheckout = {
    webhookUrl: env.MOCK_CHECKOUT_WEBHOOK_URL || `${paymentServiceUrl.replace(/\/+$/, '')}/webhooks/payments`,
    getWebhookSecret: () => secrets.getWebhookSecret(),
  };
}

const app = createApp({
  orderServiceUrl: required('ORDER_SERVICE_URL'),
  orderServiceToken: required('CUSTOMER_CLIENT_ORDER_SERVICE_TOKEN'),
  paymentServiceUrl,
  paymentServiceToken: required('CUSTOMER_CLIENT_PAYMENT_SERVICE_TOKEN'),
  timeoutMs,
  mockCheckout,
});

const server = app.listen(port, () =>
  console.log(`customer-client listening on :${port}${mockCheckout ? ' (mock hosted checkout enabled)' : ''}`),
);

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
