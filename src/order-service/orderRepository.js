const COLUMNS = 'id, customer_id, status, total_amount, currency, created_at, updated_at';

/** Maps an `orders` row to the API `Order` shape. */
function toOrder(row) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    status: row.status,
    // pg returns bigint as a string; amounts are validated to be safe integers on write.
    total_amount: Number(row.total_amount),
    currency: row.currency,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/** order-db access for order-service. `pool` is a pg.Pool (or compatible). */
export function createOrderRepository(pool) {
  return {
    async insert({ id, customerId, status, totalAmount, currency, now }) {
      const { rows } = await pool.query(
        `insert into orders (${COLUMNS}) values ($1, $2, $3, $4, $5, $6, $6) returning ${COLUMNS}`,
        [id, customerId, status, totalAmount, currency, now],
      );
      return toOrder(rows[0]);
    },

    async findById(id) {
      const { rows } = await pool.query(`select ${COLUMNS} from orders where id = $1`, [id]);
      return rows[0] ? toOrder(rows[0]) : null;
    },

    /**
     * Compare-and-set: moves the order to `to` only if it is still in `from`. Returns the
     * updated order, or null when the order is missing or its status changed concurrently.
     */
    async updateStatus({ id, from, to, now }) {
      const { rows } = await pool.query(
        `update orders set status = $3, updated_at = $4 where id = $1 and status = $2 returning ${COLUMNS}`,
        [id, from, to, now],
      );
      return rows[0] ? toOrder(rows[0]) : null;
    },
  };
}
