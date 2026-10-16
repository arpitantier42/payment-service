import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './db.js';

/**
 * Applies every `*.sql` file in `dir` (sorted by name) that has not been applied yet.
 * Applied files are recorded in `schema_migrations`; each file runs in its own transaction.
 */
export async function runMigrations(pool, dir) {
  await pool.query(
    'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null)',
  );
  const { rows } = await pool.query('select name from schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name, applied_at) values ($1, $2)', [
        file,
        new Date(),
      ]);
      await client.query('commit');
      ran.push(file);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return ran;
}

// CLI: node src/shared/migrate.js <migrations-dir>   (uses DATABASE_URL)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node src/shared/migrate.js <migrations-dir>');
    process.exit(2);
  }
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const ran = await runMigrations(pool, path.resolve(dir));
    console.log(ran.length ? `applied: ${ran.join(', ')}` : 'up to date');
  } finally {
    await pool.end();
  }
}
