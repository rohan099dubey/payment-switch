import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { sha256Hex } from './hash';
import type { Logger } from './logger';

/** Session-level advisory lock so concurrent instances never migrate at the same time. */
export const MIGRATION_LOCK_KEY = 727274;

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

interface AppliedRow {
  version: string;
  checksum: string;
}

/**
 * Applies every `NNNN_name.sql` in `dir` not yet recorded in `schema_migrations`, in
 * order, each in its own transaction.
 *
 * Stricter than the bare spec: it records each file's sha256 and refuses to start if an
 * already-applied migration has been edited, because migrations are append-only too.
 */
export async function runMigrations(pool: Pool, dir: string, logger?: Logger): Promise<string[]> {
  const files = await listMigrationFiles(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version    text PRIMARY KEY,
           checksum   text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const { rows } = await client.query<AppliedRow>('SELECT version, checksum FROM schema_migrations');
      const done = new Map(rows.map((row) => [row.version, row.checksum]));

      for (const file of files) {
        const sql = await readFile(path.join(dir, file), 'utf8');
        const checksum = sha256Hex(sql);
        const existing = done.get(file);
        if (existing !== undefined) {
          if (existing !== checksum) {
            throw new Error(`migration ${file} was modified after being applied (checksum mismatch)`);
          }
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`, {
            cause: err,
          });
        }
        applied.push(file);
        logger?.info({ migration: file }, 'migration applied');
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  return applied;
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
