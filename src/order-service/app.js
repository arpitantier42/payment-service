import { randomUUID } from 'node:crypto';
import express from 'express';
import { bearerAuth } from '../shared/auth.js';
import { errorHandler, sendError, UUID_RE } from '../shared/errors.js';
import { OrderStatus } from './orderStatus.js';
import { validateCreateOrder } from './validation.js';

/**
 * Builds the order-service HTTP app.
 * @param {{ orders: ReturnType<import('./orderRepository.js').createOrderRepository>,
 *           bearerTokens: string[], now?: () => Date }} deps
 */
export function createApp({ orders, bearerTokens, now = () => new Date() }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  const requireBearer = bearerAuth(bearerTokens);

  // OP-001 createOrder · REQ-001
  app.post('/orders', requireBearer, async (req, res) => {
    const { value, errors } = validateCreateOrder(req.body);
    if (errors) {
      return sendError(res, 400, 'validation_failed', 'required order fields are missing or invalid', errors);
    }
    const order = await orders.insert({
      id: randomUUID(),
      ...value,
      status: OrderStatus.PENDING_PAYMENT,
      now: now(),
    });
    res.status(201).location(`/orders/${order.id}`).json(order);
  });

  // OP-002 getOrder · REQ-002, REQ-003
  app.get('/orders/:orderId', requireBearer, async (req, res) => {
    const { orderId } = req.params;
    // A malformed id cannot reference an existing order.
    const order = UUID_RE.test(orderId) ? await orders.findById(orderId.toLowerCase()) : null;
    if (!order) {
      return sendError(res, 404, 'order_not_found', 'no order exists with the given id');
    }
    res.json(order);
  });

  app.use((req, res) => sendError(res, 404, 'not_found', 'route not found'));
  app.use(errorHandler);
  return app;
}
