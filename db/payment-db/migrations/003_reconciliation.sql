-- reconciliation-worker (CMP-006, OP-007) support.

-- REQ-009: delivery state of the order-service notification for a resolved payment:
--   null      not attempted yet / payment not resolved
--   SENT      order-service applied it (200)
--   REJECTED  order-service answered 409/404 (order moved on / unknown); not retried
--   FAILED    order-service stayed unreachable after the client's retries; the reconciliation
--             run re-sends it until it is SENT or REJECTED
-- Not a payment status change, so it carries no audit entry of its own (the notification
-- events ORDER_NOTIFICATION_FAILED / _REJECTED are audited).
alter table payments add column order_notification_status text;
create index payments_order_notification_status_idx on payments (order_notification_status);

-- REQ-010: reconciliation selects INITIATED/PENDING payments not updated since the threshold.
create index payments_status_updated_at_idx on payments (status, updated_at);
