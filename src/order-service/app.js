import { randomUUID } from 'node:crypto';
import express from 'express';
import { apiKeyAuth, bearerAuth } from '../shared/auth.js';
import { errorHandler, sendError, UUID_RE } from '../shared/errors.js';
import { checkTransition, OrderStatus } from './orderStatus.js';
import { validateCreateOrder, validateStatusUpdate } from './validation.js';

/**
 * Builds the order-service HTTP app.
 * @param {{ orders: ReturnType<import('./orderRepository.js').createOrderRepository>,
 *           bearerTokens: string[], apiKeys?: string[], now?: () => Date }} deps
 */
export function createApp({ orders, bearerTokens, apiKeys = [], now = () => new Date() }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  const requireBearer = bearerAuth(bearerTokens);
  const requireApiKey = apiKeyAuth(apiKeys);

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

  // OP-003 updateOrderPaymentStatus · REQ-009
  // Called by payment-service / reconciliation-worker with the order status a payment outcome
  // maps to (SUCCESS -> PAID, FAILED/EXPIRED -> PAYMENT_FAILED). Same status again is a 200 no-op.
  app.patch('/orders/:orderId/status', requireApiKey, async (req, res) => {
    const { value, errors } = validateStatusUpdate(req.body);
    if (errors) {
      return sendError(res, 400, 'validation_failed', 'status is missing or invalid', errors);
    }
    const { orderId } = req.params;
    const id = UUID_RE.test(orderId) ? orderId.toLowerCase() : null;

    // Validate against the current status, then compare-and-set; if a concurrent update won
    // the race, re-read and re-validate against the new status.
    for (;;) {
      const order = id ? await orders.findById(id) : null;
      if (!order) {
        return sendError(res, 404, 'order_not_found', 'no order exists with the given id');
      }
      const check = checkTransition(order.status, value.status);
      if (check === 'unchanged') return res.json(order);
      if (check === 'invalid') {
        return sendError(
          res,
          409,
          'invalid_status_transition',
          `cannot change order status from ${order.status} to ${value.status}`,
          [{ field: 'status', message: `current status is ${order.status}` }],
        );
      }
      const updated = await orders.updateStatus({ id, from: order.status, to: value.status, now: now() });
      if (updated) return res.json(updated);
    }
  });

  app.use((req, res) => sendError(res, 404, 'not_found', 'route not found'));
  app.use(errorHandler);
  return app;
}
