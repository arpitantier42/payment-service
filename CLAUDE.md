# Order Payment Processing System

Order → payment → webhook/reconciliation system. Components (from the design): order-service,
order-db, payment-service, payment-db, reconciliation-worker; payment gateway and secrets
manager are external.

## Stack
- Node.js 20, plain JavaScript ES modules (`"type": "module"`), no build step.
- Express 5 (async handler errors reach the error handler automatically).
- PostgreSQL via `pg`. Hand-written SQL, no ORM.
- Tests: `node:test` + `node:assert/strict` + `supertest`; `pg-mem` gives an in-memory Postgres
  so tests run the real migrations and SQL without a database server.

## Layout
```
src/shared/           cross-service helpers: db.js (pool), migrate.js (runner + CLI),
                      auth.js (bearer + api_key middleware), errors.js (error shape, error handler, UUID_RE),
                      retry.js (withRetry, UpstreamError, fetchUpstream), secrets.js (encrypted
                      credentials "secrets-manager" + encrypt CLI)
src/order-service/    app.js (createApp, routes), server.js (env wiring, listen),
                      orderRepository.js (SQL), validation.js, orderStatus.js
src/payment-service/  app.js, server.js, paymentRepository.js (SQL + audit + webhook_events), validation.js,
                      paymentStatus.js (state machine, orderStatusFor), gateway.js (gateway boundary:
                      http + mock checkout, webhook signature/payload parsing), orderClient.js
                      (GET /orders/{id}, PATCH /orders/{id}/status), paymentOutcome.js (applyStatus +
                      notifyOrder, shared by webhook and reconciliation)
db/<db-name>/migrations/NNN_description.sql   one dir per store (order-db, payment-db)
test/helpers/db.js    createTestPool('<db-name>') -> pg-mem pool with migrations applied
test/<component>/*.test.js
```
New services go in `src/<service-name>/` with the same app.js/server.js split, their own
`db/<store>/migrations`, and an `npm run start:<service>` script.

## Commands
- Install: `npm install`
- Test: `npm test` (runs `test/*/*.test.js`; put tests one directory deep)
- Migrate: `DATABASE_URL=... npm run migrate:order-db` / `npm run migrate:payment-db`
- Run: `DATABASE_URL=... ORDER_SERVICE_BEARER_TOKENS=dev-token ORDER_SERVICE_API_KEYS=dev-internal-key npm run start:order-service`
- Run payment-service: export the payment block of `.env.example` (DATABASE_URL → payment-db), then
  `npm run start:payment-service`
- Encrypt gateway credentials: `SECRETS_MASTER_KEY=... npm run encrypt-secret -- '{"key_id":"..","key_secret":".."}'`
- Full local stack: `docker compose up --build` (order-db :5433, order-service :3001,
  payment-db :5434, payment-service :3002 with the mock gateway)

## Configuration (env, see .env.example)
- `DATABASE_URL` — Postgres connection string for the service's store.
- `ORDER_SERVICE_PORT` (default 3001), `ORDER_SERVICE_BEARER_TOKENS` (comma-separated),
  `ORDER_SERVICE_API_KEYS` (comma-separated X-API-Key values for internal callers).
- payment-service: `PAYMENT_SERVICE_PORT` (3002), `PAYMENT_SERVICE_BEARER_TOKENS`,
  `ORDER_SERVICE_URL` + `ORDER_SERVICE_TOKEN` (bearer it uses for GET /orders/{id}),
  `ORDER_SERVICE_TIMEOUT_MS`, `PAYMENT_GATEWAY_NAME` (`mock` | razorpay | stripe),
  `PAYMENT_GATEWAY_BASE_URL`, `PAYMENT_GATEWAY_TIMEOUT_MS`, `PAYMENT_GATEWAY_RETRY_ATTEMPTS` (3),
  `PAYMENT_GATEWAY_RETRY_BASE_DELAY_MS` (200), `CHECKOUT_SESSION_TTL_MINUTES` (15),
  `SECRETS_MASTER_KEY` (32 bytes base64) + `PAYMENT_GATEWAY_CREDENTIALS_ENCRYPTED` (AES-256-GCM
  sealed `{"key_id","key_secret"}`), `PAYMENT_GATEWAY_WEBHOOK_SECRET_ENCRYPTED` (sealed webhook
  HMAC secret, same `encrypt-secret` CLI), `ORDER_SERVICE_API_KEY` (X-API-Key for the order PATCH).
  All required at startup. The values in .env.example / compose are dev-only samples.

## Conventions
- `createApp(deps)` takes its dependencies (repositories, tokens, clock `now`) so tests inject
  a pg-mem-backed repository; `server.js` is the only place that reads env.
- API JSON uses snake_case field names exactly as in the OpenAPI schemas; repositories map rows
  to that shape (bigint → Number, timestamps → ISO strings).
- Error body: `{ "error": { "code", "message", "details?" } }` via `sendError`. Validation
  failures are 400 `validation_failed` with `details: [{ field, message }]`.
- Amounts are integers in minor units (safe integers); currency is a 3-letter uppercase code.
- Server owns ids (`randomUUID()`), status and timestamps; client-sent values for them are ignored.
- `bearer` auth = `bearerAuth(tokens)` middleware (static configured tokens, placeholder for a
  real IdP). `api_key` auth = `apiKeyAuth(keys)` (X-API-Key header, static configured keys) for
  internal service-to-service endpoints; both return 401 `unauthorized`. A bearer token does not
  satisfy api_key and vice versa.
- Status changes are validated by a state machine (`checkTransition` in the service's status
  module) then applied with a compare-and-set SQL update (`where id = $1 and status = $2`);
  an invalid transition is 409 `invalid_status_transition`; requesting the current status is an
  idempotent 200 no-op (safe for webhook redelivery / reconciliation retries).
- A malformed UUID in a path returns 404 (it cannot reference an existing record).
- Each route is commented with its OP id and REQ ids.
- Outbound calls (gateway, order-service, later reconciliation) go through `withRetry` +
  `fetchUpstream`: network errors/timeouts/5xx/429 are `UpstreamError{retryable:true}`, 4xx are not.
  Default policy 3 attempts, backoff 200ms·2^n; tests inject `sleep` to avoid waiting.
- Payment status writes: every `payments` insert/status change is paired with an
  `audit_log_entries` row in the same transaction (`paymentRepository` does this; use
  `updateStatus({id, from, to, eventType, actor, metadata, now})`, a compare-and-set, and
  `checkTransition` from `paymentStatus.js`). Events without a status change use `recordEvent`.
  Actors: `system` | `gateway_webhook` | `reconciliation_job`.
- Gateway credentials are never stored or logged: `secrets.getGatewayCredentials()` decrypts them
  per call. Provider-specific code stays in `gateway.js`; gateway calls are keyed by payment id
  (`Idempotency-Key` header to the gateway) so retries/resumes cannot create a second session.
- pg-mem caveats: `rollback` does not undo writes, and `insert ... on conflict do nothing
  returning` returns the existing row. Detect duplicates by catching `23505` (`isUniqueViolation`)
  and re-reading instead.

## Status
- WI-001 done: `POST /orders`, `GET /orders/{orderId}`, `orders` table.
- WI-002 done: `PATCH /orders/{orderId}/status` (api_key). Body is an `Order`; only `status` is
  read (one of PENDING_PAYMENT | PAID | PAYMENT_FAILED | CANCELLED, else 400). Order state machine:
  PENDING_PAYMENT → PAID | PAYMENT_FAILED | CANCELLED; PAYMENT_FAILED → PAID | CANCELLED;
  PAID and CANCELLED are terminal. Callers map payment outcomes to order status:
  SUCCESS → `PAID`, FAILED / EXPIRED → `PAYMENT_FAILED` (INITIATED/PENDING: don't notify).
  Treat 200 as applied (also when already in that status), 409 as "order moved on, don't retry",
  404 as unknown order; retry on 5xx/network errors.
- WI-003 done: payment-service `POST /payments` + `GET /payments/{paymentId}` (bearer), payment-db
  (`payments`, `checkout_sessions`, `audit_log_entries`). Payment responses are the `Payment`
  schema plus `checkout_session` (CheckoutSession or null). POST /payments flow: validate body +
  `Idempotency-Key` (400) → existing key? replay (200; 422 `idempotency_key_reused` if body
  differs; if it has no checkout session and is INITIATED, re-run the gateway step = resume) →
  GET order from order-service (404; 503 `order_service_unavailable`; 409 `order_not_payable`
  unless PENDING_PAYMENT/PAYMENT_FAILED) → amount+currency must equal the order's (422
  `amount_mismatch`) → insert INITIATED + PAYMENT_INITIATED audit (unique-index clash with another
  key's INITIATED/PENDING payment for the order → 409 `payment_in_progress`) → credentials →
  gateway (retried) → store session + gateway_reference + CHECKOUT_SESSION_CREATED audit → 201.
  Gateway failure → 502 `gateway_unavailable`; timeouts/5xx leave the payment INITIATED with a
  GATEWAY_CALL_FAILED audit (reconciliation or same-key retry resolves it); a 4xx rejection marks
  it FAILED (GATEWAY_REJECTED audit). Payment states: INITIATED → PENDING|SUCCESS|FAILED|EXPIRED,
  PENDING → SUCCESS|FAILED|EXPIRED; others terminal.
- WI-004 done: `GET /payments/{paymentId}` hardened + REQ-011 QA. Bearer-only (401 before any
  lookup, also for unknown ids; X-API-Key does not satisfy it), reads payment-db only (no
  order-service/gateway call, no writes), returns the stored status. All `/payments*` responses
  carry `Cache-Control: no-store`. Tests: `assertAuditTrailComplete` in `payments.test.js` checks
  that status-changing audit entries chain from PAYMENT_INITIATED to the current status — reuse
  it for webhook/reconciliation tests; `clients.test.js` checks `.env.example`/compose hold only
  sealed gateway credentials.
- WI-005 done: `POST /webhooks/payments` (no caller auth; `X-Gateway-Signature` = hex HMAC-SHA256
  of the raw body, optional `sha256=` prefix; `req.rawBody` is kept by express.json `verify`).
  Payload (gateway.js `parseWebhookPayload`): `{ event_id, payment_id?, gateway_reference?, status,
  amount, currency }`, provider status mapped to SUCCESS/FAILED/PENDING. Flow: bad/missing signature
  → 400 `invalid_signature`, NOT stored (so it can't claim a real event id) → bad payload 400
  `validation_failed` → insert `webhook_events` RECEIVED (dedupe on `gateway_event_id`; a repeat of
  an APPLIED/REJECTED event replays its answer, a repeat of RECEIVED/VERIFIED is re-processed) →
  unknown payment / amount / currency / gateway_reference mismatch → 422 (`unknown_payment` |
  `transaction_mismatch`, event REJECTED, WEBHOOK_REJECTED audit) → VERIFIED → `applyStatus`
  (WEBHOOK_APPLIED audit; same status = `unchanged`; PENDING after a final status = `stale`, other
  invalid = `conflict` → 200, event REJECTED, WEBHOOK_IGNORED / WEBHOOK_CONFLICT audit) → checkout
  session COMPLETED on SUCCESS/FAILED → `notifyOrder` (retried; still failing → 503
  `order_service_unavailable`, event stays VERIFIED so a redelivery finishes it; 409/404 →
  ORDER_NOTIFICATION_REJECTED audit, not retried) → APPLIED, 200 with the `WebhookEvent` +
  `outcome` + `payment_status`. `webhook_events.outcome` is an extra column (applied | unchanged |
  stale | conflict | unknown_payment | details_mismatch).
- Not yet built: reconciliation-worker. Reuse `createPaymentOutcomes` (`paymentOutcome.js`) with
  actor `reconciliation_job` and `createOrderClient({ apiKey })` for the order PATCH (configure a
  key from `ORDER_SERVICE_API_KEYS`). Mark checkout sessions COMPLETED/EXPIRED consistently
  (webhook sets COMPLETED; only expire ACTIVE ones). `payments.order_id` has no FK (orders live in
  order-db). Tests: `test/payment-service/webhooks.test.js` shows signing deliveries
  (`signWebhookPayload`) and simulating order-service outages via `fetchImpl`.
