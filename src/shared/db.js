import pg from 'pg';

export function createPool(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new pg.Pool({ connectionString });
}
