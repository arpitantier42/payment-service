import { createPool } from '../shared/db.js';
import { createApp } from './app.js';
import { createOrderRepository } from './orderRepository.js';

const port = Number(process.env.ORDER_SERVICE_PORT ?? 3001);
const bearerTokens = (process.env.ORDER_SERVICE_BEARER_TOKENS ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
if (bearerTokens.length === 0) {
  console.warn('ORDER_SERVICE_BEARER_TOKENS is empty: every authenticated request will get 401');
}

const pool = createPool(process.env.DATABASE_URL);
const app = createApp({ orders: createOrderRepository(pool), bearerTokens });

const server = app.listen(port, () => console.log(`order-service listening on :${port}`));

function shutdown() {
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
