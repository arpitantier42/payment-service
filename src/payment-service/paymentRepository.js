import { randomUUID } from 'node:crypto';

const PAYMENT_COLUMNS =
  'id, order_id, idempotency_key, amount, currency, payment_method, gateway_name, gateway_reference, status, created_at, updated_at';
const SESSION_COLUMNS = 'id, payment_id, gateway_session_id, checkout_url, status, expires_at, created_at';
const AUDIT_COLUMNS = 'id, payment_id, event_type, previous_status, new_status, actor, metadata, created_at';

const iso = (value) => new Date(value).toISOString();

/** Maps a `payments` row to the API `Payment` shape. */
function toPayment(row) {
  return {
    id: row.id,
    order_id: row.order_id,
    idempotency_key: row.idempotency_key,
    // pg returns bigint as a string; amounts are validated to be safe integers on write.
    amount: Number(row.amount),
    currency: row.currency,
    payment_method: row.payment_method,
    gateway_name: row.gateway_name,
    gateway_reference: row.gateway_reference ?? null,
    status: row.status,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** Maps a `checkout_sessions` row to the API `CheckoutSession` shape. */
function toCheckoutSession(row) {
  return {
    id: row.id,
    payment_id: row.payment_id,
    gateway_session_id: row.gateway_session_id,
    checkout_url: row.checkout_url,
    status: row.status,
    expires_at: iso(row.expires_at),
    created_at: iso(row.created_at),
  };
}

function toAuditLogEntry(row) {
  return {
    id: row.id,
    payment_id: row.payment_id,
    event_type: row.event_type,
    previous_status: row.previous_status ?? null,
    new_status: row.new_status,
    actor: row.actor,
    metadata: row.metadata ?? null,
    created_at: iso(row.created_at),
  };
}

const WEBHOOK_COLUMNS =
  'id, gateway_event_id, payment_id, signature_valid, status, outcome, raw_payload, received_at, processed_at';

/** Maps a `webhook_events` row to the API `WebhookEvent` shape (plus `outcome`). */
function toWebhookEvent(row) {
  return {
    id: row.id,
    gateway_event_id: row.gateway_event_id,
    payment_id: row.payment_id ?? null,
    signature_valid: row.signature_valid,
    status: row.status,
    outcome: row.outcome ?? null,
    raw_payload: typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload) : row.raw_payload,
    received_at: iso(row.received_at),
    processed_at: row.processed_at ? iso(row.processed_at) : null,
  };
}

export const isUniqueViolation = (err) => err?.code === '23505';

async function insertAudit(db, { paymentId, eventType, previousStatus = null, newStatus, actor, metadata = null, now }) {
  await db.query(
    `insert into audit_log_entries (${AUDIT_COLUMNS}) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), paymentId, eventType, previousStatus, newStatus, actor, metadata && JSON.stringify(metadata), now],
  );
}

/**
 * payment-db access for payment-service. `pool` is a pg.Pool (or compatible).
 * Every write to `payments` is paired with an `audit_log_entries` row in the same transaction
 * (NFR-003).
 */
export function createPaymentRepository(pool) {
  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function sessionFor(paymentId) {
    const { rows } = await pool.query(`select ${SESSION_COLUMNS} from checkout_sessions where payment_id = $1`, [paymentId]);
    return rows[0] ? toCheckoutSession(rows[0]) : null;
  }

  async function findOne(where, param) {
    const { rows } = await pool.query(`select ${PAYMENT_COLUMNS} from payments where ${where} = $1`, [param]);
    if (!rows[0]) return null;
    const payment = toPayment(rows[0]);
    return { payment, checkoutSession: await sessionFor(payment.id) };
  }

  return {
    /** Returns `{ payment, checkoutSession }` (session null until the gateway accepted) or null. */
    findById: (id) => findOne('id', id),
    findByIdempotencyKey: (key) => findOne('idempotency_key', key),
    findByGatewayReference: (reference) => findOne('gateway_reference', reference),

    /**
     * Inserts the payment (status from `payment.status`, normally INITIATED) with its
     * PAYMENT_INITIATED audit entry. Throws a unique violation (see `isUniqueViolation`) when the
     * idempotency key is taken or the order already has an INITIATED/PENDING payment.
     */
    async createPayment({ payment, actor, metadata, now }) {
      return inTransaction(async (db) => {
        const { rows } = await db.query(
          `insert into payments (${PAYMENT_COLUMNS})
           values ($1, $2, $3, $4, $5, $6, $7, null, $8, $9, $9) returning ${PAYMENT_COLUMNS}`,
          [
            payment.id,
            payment.orderId,
            payment.idempotencyKey,
            payment.amount,
            payment.currency,
            payment.paymentMethod,
            payment.gatewayName,
            payment.status,
            now,
          ],
        );
        await insertAudit(db, {
          paymentId: payment.id,
          eventType: 'PAYMENT_INITIATED',
          newStatus: payment.status,
          actor,
          metadata,
          now,
        });
        return toPayment(rows[0]);
      });
    },

    /**
     * Stores the gateway's checkout session and transaction reference against the payment, with
     * a CHECKOUT_SESSION_CREATED audit entry. If a concurrent request already stored a session
     * for this payment, keeps that one. Returns the current `{ payment, checkoutSession }`.
     */
    async recordCheckoutSession({ paymentId, gatewayReference, gatewaySessionId, checkoutUrl, expiresAt, actor, now }) {
      try {
        await inTransaction(async (db) => {
          await db.query(
            `insert into checkout_sessions (${SESSION_COLUMNS}) values ($1, $2, $3, $4, 'ACTIVE', $5, $6)`,
            [randomUUID(), paymentId, gatewaySessionId, checkoutUrl, expiresAt, now],
          );
          const { rows } = await db.query(
            `update payments set gateway_reference = $2, updated_at = $3
             where id = $1 and gateway_reference is null returning status`,
            [paymentId, gatewayReference, now],
          );
          const status = rows[0]?.status;
          if (status) {
            await insertAudit(db, {
              paymentId,
              eventType: 'CHECKOUT_SESSION_CREATED',
              previousStatus: status,
              newStatus: status,
              actor,
              metadata: { gateway_reference: gatewayReference, gateway_session_id: gatewaySessionId, expires_at: iso(expiresAt) },
              now,
            });
          }
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
      return findOne('id', paymentId);
    },

    /**
     * Compare-and-set status change with its audit entry: moves the payment to `to` only if it is
     * still in `from`. Returns the updated payment, or null when the status changed concurrently.
     */
    async updateStatus({ id, from, to, eventType, actor, metadata, now }) {
      return inTransaction(async (db) => {
        const { rows } = await db.query(
          `update payments set status = $3, updated_at = $4 where id = $1 and status = $2 returning ${PAYMENT_COLUMNS}`,
          [id, from, to, now],
        );
        if (!rows[0]) return null;
        await insertAudit(db, { paymentId: id, eventType, previousStatus: from, newStatus: to, actor, metadata, now });
        return toPayment(rows[0]);
      });
    },

    /** Appends an audit entry for an event that does not change `payments` (e.g. a failed gateway call). */
    async recordEvent({ paymentId, eventType, status, actor, metadata, now }) {
      await insertAudit(pool, { paymentId, eventType, previousStatus: status, newStatus: status, actor, metadata, now });
    },

    /** Marks the payment's ACTIVE checkout session COMPLETED (the customer finished checkout). */
    async completeCheckoutSession(paymentId) {
      await pool.query(`update checkout_sessions set status = 'COMPLETED' where payment_id = $1 and status = 'ACTIVE'`, [
        paymentId,
      ]);
    },

    /**
     * Records a verified webhook delivery as RECEIVED, deduped by gateway event id (REQ-010).
     * Returns `{ event, duplicate }`: on a repeat delivery, `event` is the stored one and
     * `duplicate` is true.
     */
    async recordWebhookEvent({ gatewayEventId, rawPayload, signatureValid, now }) {
      try {
        const { rows } = await pool.query(
          `insert into webhook_events (${WEBHOOK_COLUMNS})
           values ($1, $2, null, $3, 'RECEIVED', null, $4, $5, null) returning ${WEBHOOK_COLUMNS}`,
          [randomUUID(), gatewayEventId, signatureValid, JSON.stringify(rawPayload), now],
        );
        return { event: toWebhookEvent(rows[0]), duplicate: false };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const { rows } = await pool.query(`select ${WEBHOOK_COLUMNS} from webhook_events where gateway_event_id = $1`, [
          gatewayEventId,
        ]);
        return { event: toWebhookEvent(rows[0]), duplicate: true };
      }
    },

    /** Moves a webhook event on (VERIFIED / REJECTED / APPLIED); `processedAt` once it is final. */
    async updateWebhookEvent({ id, status, paymentId = null, outcome = null, processedAt = null }) {
      const { rows } = await pool.query(
        `update webhook_events set status = $2, payment_id = coalesce($3, payment_id), outcome = coalesce($4, outcome),
           processed_at = coalesce($5, processed_at)
         where id = $1 returning ${WEBHOOK_COLUMNS}`,
        [id, status, paymentId, outcome, processedAt],
      );
      return rows[0] ? toWebhookEvent(rows[0]) : null;
    },

    async listAuditEntries(paymentId) {
      const { rows } = await pool.query(
        `select ${AUDIT_COLUMNS} from audit_log_entries where payment_id = $1 order by created_at`,
        [paymentId],
      );
      return rows.map(toAuditLogEntry);
    },
  };
}
