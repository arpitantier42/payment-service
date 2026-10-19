import assert from 'node:assert/strict';

/**
 * REQ-011: the status-changing audit entries of one payment chain from PAYMENT_INITIATED to
 * `currentStatus`, and every actor is a known one.
 * @param {Array<{ event_type: string, previous_status: string|null, new_status: string, actor: string }>} entries
 * @param {string} currentStatus
 */
export function assertAuditTrailComplete(entries, currentStatus) {
  const changes = entries.filter((e) => e.previous_status === null || e.previous_status !== e.new_status);
  const creation = changes.filter((e) => e.previous_status === null);
  assert.equal(creation.length, 1, 'exactly one creation entry');
  assert.equal(creation[0].event_type, 'PAYMENT_INITIATED');
  let current = creation[0].new_status;
  const remaining = changes.filter((e) => e !== creation[0]);
  while (remaining.length) {
    const i = remaining.findIndex((e) => e.previous_status === current);
    assert.ok(i >= 0, `no audit entry continues the chain from ${current}`);
    current = remaining.splice(i, 1)[0].new_status;
  }
  assert.equal(current, currentStatus, 'audit trail ends at the current status');
  for (const e of entries) assert.ok(['system', 'gateway_webhook', 'reconciliation_job'].includes(e.actor));
}
