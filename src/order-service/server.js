import { createPool } from '../shared/db.js';
import { createApp } from './app.js';
import { createOrderRepository } from './orderRepository.js';

const port = Number(process.env.ORDER_SERVICE_PORT ?? 3001);
const csv = (name) =>
  (process.env[name] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
const bearerTokens = csv('ORDER_SERVICE_BEARER_TOKENS');
if (bearerTokens.length === 0) {
  console.warn('ORDER_SERVICE_BEARER_TOKENS is empty: every bearer-authenticated request will get 401');
}
const apiKeys = csv('ORDER_SERVICE_API_KEYS');
if (apiKeys.length === 0) {
  console.warn('ORDER_SERVICE_API_KEYS is empty: every api_key-authenticated request will get 401');
}

const pool = createPool(process.env.DATABASE_URL);
const app = createApp({ orders: createOrderRepository(pool), bearerTokens, apiKeys });

const server = app.listen(port, () => console.log(`order-service listening on :${port}`));

function shutdown() {
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
