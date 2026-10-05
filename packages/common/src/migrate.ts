import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { sha256Hex } from './hash';
import type { Logger } from './logger';

/** Session-level advisory lock so concurrent instances never migrate at the same time. */
export const MIGRATION_LOCK_KEY = 727274;

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

interface AppliedRow {
  filename: string;
  checksum: string;
}

interface PendingMigration {
  file: string;
  sql: string;
  checksum: string;
}

/**
 * Applies every `NNNN_name.sql` in `dir` not yet recorded in `schema_migrations`
 * (spec section 10), in filename order, all inside **one** transaction: either every
 * pending file applies or none does, and startup aborts.
 *
 * Adds a `checksum` column (ADR-014) and refuses to start if an applied migration was
 * edited, because "a migration is never edited after it is merged".
 */
export async function runMigrations(pool: Pool, dir: string, logger?: Logger): Promise<string[]> {
  const files = await listMigrationFiles(dir);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           filename   text PRIMARY KEY,
           checksum   text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const { rows } = await client.query<AppliedRow>('SELECT filename, checksum FROM schema_migrations');
      const done = new Map(rows.map((row) => [row.filename, row.checksum]));

      const pending: PendingMigration[] = [];
      for (const file of files) {
        const sql = await readFile(path.join(dir, file), 'utf8');
        const checksum = sha256Hex(sql);
        const existing = done.get(file);
        if (existing === undefined) {
          pending.push({ file, sql, checksum });
        } else if (existing !== checksum) {
          throw new Error(`migration ${file} was modified after being applied (checksum mismatch)`);
        }
      }
      if (pending.length === 0) return [];

      await client.query('BEGIN');
      let current = '';
      try {
        for (const migration of pending) {
          current = migration.file;
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
            migration.file,
            migration.checksum,
          ]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${current} failed: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
      const applied = pending.map((migration) => migration.file);
      logger?.info({ migrations: applied }, 'migrations applied');
      return applied;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();
  for (const name of sqlFiles) {
    if (!MIGRATION_FILE.test(name)) {
      throw new Error(`migration file ${name} does not match NNNN_name.sql`);
    }
  }
  const versions = sqlFiles.map((name) => name.slice(0, 4));
  if (new Set(versions).size !== versions.length) {
    throw new Error(`duplicate migration number in ${dir}`);
  }
  return sqlFiles;
}
