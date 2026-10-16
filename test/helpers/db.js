import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import { runMigrations } from '../../src/shared/migrate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Fresh in-memory Postgres (pg-mem) with the given db's migrations applied. Returns a pg.Pool. */
export async function createTestPool(dbName) {
  const db = newDb();
  db.public.registerFunction({ name: 'gen_random_uuid', returns: 'uuid', implementation: randomUUID, impure: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await runMigrations(pool, path.join(root, 'db', dbName, 'migrations'));
  return pool;
}
