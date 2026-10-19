-- ENT-004 WebhookEvent <- REQ-007, REQ-010
-- One gateway webhook delivery and its verification outcome. Only deliveries whose signature
-- verified are stored: an unauthenticated request must not be able to claim (and so "dedupe
-- away") a real gateway event id, nor fill the table.
create table webhook_events (
    id                uuid not null,
    gateway_event_id  text not null,  -- gateway's own event id; a redelivery of it is not applied twice
    payment_id        uuid,  -- null when the event cannot be matched to a stored payment (rejected)
    signature_valid   boolean not null,
    status            text not null,  -- RECEIVED | VERIFIED | REJECTED | APPLIED
    outcome           text,  -- why it ended as it did: applied | unchanged | stale | conflict | unknown_payment | details_mismatch
    raw_payload       jsonb not null,  -- full gateway payload, kept for disputes and reconciliation
    received_at       timestamptz not null,
    processed_at      timestamptz,  -- set once applied or rejected; null while in flight
    primary key (id),
    constraint webhook_events_status_check check (status in ('RECEIVED', 'VERIFIED', 'REJECTED', 'APPLIED')),
    constraint webhook_events_payment_id_fkey foreign key (payment_id) references payments (id)
);
create unique index webhook_events_gateway_event_id_key on webhook_events (gateway_event_id);
create index webhook_events_payment_id_idx on webhook_events (payment_id);

-- Webhooks may identify the payment by the gateway's transaction id only.
create index payments_gateway_reference_idx on payments (gateway_reference);
