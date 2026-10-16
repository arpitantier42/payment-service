-- ENT-001 Order <- REQ-001, REQ-009
-- One customer order and its current fulfilment/payment status.
create table orders (
    id            uuid not null,
    customer_id   uuid not null,
    status        text not null,  -- PENDING_PAYMENT | PAID | PAYMENT_FAILED | CANCELLED
    total_amount  bigint not null,  -- payable amount in minor currency units; the trusted figure
    currency      text not null,  -- ISO 4217 currency code
    created_at    timestamptz not null,
    updated_at    timestamptz not null,
    primary key (id),
    constraint orders_status_check
        check (status in ('PENDING_PAYMENT', 'PAID', 'PAYMENT_FAILED', 'CANCELLED')),
    constraint orders_total_amount_check check (total_amount > 0)
);
