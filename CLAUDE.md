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
                      auth.js (bearer + api_key middleware), errors.js (error shape, error handler, UUID_RE)
src/order-service/    app.js (createApp, routes), server.js (env wiring, listen),
                      orderRepository.js (SQL), validation.js, orderStatus.js
db/<db-name>/migrations/NNN_description.sql   one dir per store (order-db; later payment-db)
test/helpers/db.js    createTestPool('<db-name>') -> pg-mem pool with migrations applied
test/<component>/*.test.js
```
New services go in `src/<service-name>/` with the same app.js/server.js split, their own
`db/<store>/migrations`, and an `npm run start:<service>` script.

## Commands
- Install: `npm install`
- Test: `npm test` (runs `test/*/*.test.js`; put tests one directory deep)
- Migrate: `DATABASE_URL=... npm run migrate:order-db`
- Run: `DATABASE_URL=... ORDER_SERVICE_BEARER_TOKENS=dev-token ORDER_SERVICE_API_KEYS=dev-internal-key npm run start:order-service`
- Full local stack: `docker compose up --build` (Postgres on host :5433, order-service on :3001)

## Configuration (env, see .env.example)
- `DATABASE_URL` — Postgres connection string for the service's store.
- `ORDER_SERVICE_PORT` (default 3001), `ORDER_SERVICE_BEARER_TOKENS` (comma-separated),
  `ORDER_SERVICE_API_KEYS` (comma-separated X-API-Key values for internal callers).

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

## Status
- WI-001 done: `POST /orders`, `GET /orders/{orderId}`, `orders` table.
- WI-002 done: `PATCH /orders/{orderId}/status` (api_key). Body is an `Order`; only `status` is
  read (one of PENDING_PAYMENT | PAID | PAYMENT_FAILED | CANCELLED, else 400). Order state machine:
  PENDING_PAYMENT → PAID | PAYMENT_FAILED | CANCELLED; PAYMENT_FAILED → PAID | CANCELLED;
  PAID and CANCELLED are terminal. Callers map payment outcomes to order status:
  SUCCESS → `PAID`, FAILED / EXPIRED → `PAYMENT_FAILED` (INITIATED/PENDING: don't notify).
  Treat 200 as applied (also when already in that status), 409 as "order moved on, don't retry",
  404 as unknown order; retry on 5xx/network errors.
- Not yet built: payment-service, reconciliation-worker. They call the PATCH with
  `X-API-Key` (configure a key from `ORDER_SERVICE_API_KEYS` in their env).
  Payment-side rules (reject missing order id/amount/currency/method, reject unknown order) are
  payment-service's job; it should call `GET /orders/{orderId}` and treat 404 as "reject".
