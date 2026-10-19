-- payment-db: payments, checkout sessions and the payment audit log.
-- `payments.order_id` references order-service's `orders.id`, which lives in a different store
-- (order-db), so it is not a database foreign key; payment-service checks the order exists via
-- GET /orders/{orderId} before inserting.

-- ENT-002 Payment <- REQ-004, REQ-008, REQ-010
-- One payment attempt against an order.
create table payments (
    id                 uuid not null,
    order_id           uuid not null,
    idempotency_key    text not null,  -- client-supplied Idempotency-Key header; a repeat returns this row
    amount             bigint not null,  -- minor units, validated against orders.total_amount
    currency           text not null,
    payment_method     text not null,  -- e.g. card, upi, netbanking
    gateway_name       text not null,  -- razorpay | stripe | mock
    gateway_reference  text,  -- gateway transaction id; null until the gateway accepts the checkout
    status             text not null,  -- INITIATED | PENDING | SUCCESS | FAILED | EXPIRED
    created_at         timestamptz not null,
    updated_at         timestamptz not null,
    primary key (id),
    constraint payments_status_check
        check (status in ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'EXPIRED')),
    constraint payments_amount_check check (amount > 0)
);
create unique index payments_idempotency_key_key on payments (idempotency_key);
-- RSK-003: at most one non-terminal payment per order, whatever idempotency key the client sends.
create unique index payments_order_id_active_key on payments (order_id)
    where status in ('INITIATED', 'PENDING');

-- ENT-003 CheckoutSession <- REQ-005, REQ-006
-- The gateway-hosted checkout session created for a single payment attempt.
create table checkout_sessions (
    id                  uuid not null,
    payment_id          uuid not null,
    gateway_session_id  text not null,
    checkout_url        text not null,
    status              text not null,  -- ACTIVE | COMPLETED | EXPIRED
    expires_at          timestamptz not null,  -- bounded checkout window
    created_at          timestamptz not null,
    primary key (id),
    constraint checkout_sessions_status_check check (status in ('ACTIVE', 'COMPLETED', 'EXPIRED')),
    constraint checkout_sessions_payment_id_fkey foreign key (payment_id) references payments (id)
);
create unique index checkout_sessions_payment_id_key on checkout_sessions (payment_id);
create index checkout_sessions_status_expires_at_idx on checkout_sessions (status, expires_at);

-- ENT-005 AuditLogEntry <- REQ-011
-- One recorded state change on a payment, for audit and investigation.
create table audit_log_entries (
    id               uuid not null,
    payment_id       uuid not null,
    event_type       text not null,  -- PAYMENT_INITIATED, CHECKOUT_SESSION_CREATED, GATEWAY_CALL_FAILED, ...
    previous_status  text,  -- null for the creation event
    new_status       text not null,
    actor            text not null,  -- system | gateway_webhook | reconciliation_job
    metadata         jsonb,
    created_at       timestamptz not null,
    primary key (id),
    constraint audit_log_entries_payment_id_fkey foreign key (payment_id) references payments (id)
);
create index audit_log_entries_payment_id_idx on audit_log_entries (payment_id, created_at);
