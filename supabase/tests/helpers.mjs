// Shared setup for database tests: an embedded Postgres with every migration applied.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

export async function freshDb(userIds) {
  const db = await PGlite.create({ extensions: { vector } });
  await db.exec(readFileSync(join(here, 'supabase-shim.sql'), 'utf8'));
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
  }
  for (const [i, id] of userIds.entries()) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `u${i}@test.dev`]);
  }

  async function as(role, uid, sql, params = []) {
    await db.exec('begin');
    try {
      await db.query(`set local role ${role}`);
      await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
      const res = await db.query(sql, params);
      await db.exec('commit');
      return { rows: res.rows, affected: res.affectedRows ?? 0 };
    } catch (error) {
      await db.exec('rollback');
      return { error: error.message };
    }
  }
  return { db, as };
}
