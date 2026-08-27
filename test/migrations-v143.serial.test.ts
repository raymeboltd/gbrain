import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => engine.disconnect());

describe('migration v143 source-event receipts', () => {
  test('is the current migration and fresh schema exposes identity columns', async () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(143);
    const columns = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='source_event_receipts' ORDER BY column_name`,
    );
    const names = columns.map((row) => row.column_name);
    for (const name of ['source_key', 'processor_version', 'target_results', 'status', 'event_id', 'revision_id', 'artifact_slug']) {
      expect(names).toContain(name);
    }
  });

  test('fresh Postgres schema includes receipt metadata in the RLS seal', () => {
    const schema = readFileSync(join(import.meta.dir, '../src/schema.sql'), 'utf8');
    expect(schema).toContain('ALTER TABLE source_event_receipts ENABLE ROW LEVEL SECURITY');
  });

  test('upgrades a pre-identity receipt table instead of trusting CREATE IF NOT EXISTS', async () => {
    await engine.executeRaw('DROP TABLE source_event_receipts');
    await engine.executeRaw(`
      CREATE TABLE source_event_receipts (
        id BIGSERIAL PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        source_slug TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        event_date DATE NOT NULL,
        status TEXT NOT NULL,
        target_results JSONB NOT NULL DEFAULT '[]'::jsonb,
        candidates_count INTEGER NOT NULL DEFAULT 0,
        resolved_count INTEGER NOT NULL DEFAULT 0,
        links_written INTEGER NOT NULL DEFAULT 0,
        timeline_written INTEGER NOT NULL DEFAULT 0,
        facts_written INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        errors JSONB NOT NULL DEFAULT '[]'::jsonb,
        attempts INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(source_id, event_key)
      )
    `);
    await engine.executeRaw(
      `INSERT INTO source_event_receipts
         (source_id,event_key,source_kind,source_uri,source_slug,content_hash,observed_at,event_date,status)
       VALUES ('default','legacy-key','email','legacy://1','raw/legacy/1','hash',now(),'2026-01-01','partial')`,
    );
    await engine.setConfig('version', '142');
    expect(await runMigrations(engine)).toEqual({ applied: 2, current: LATEST_VERSION });

    const rows = await engine.executeRaw<{ source_key: string; processor_version: string; event_id: string; revision_id: string; artifact_slug: string }>(
      `SELECT source_key,processor_version,event_id,revision_id,artifact_slug
         FROM source_event_receipts WHERE event_key='legacy-key'`,
    );
    expect(rows[0]).toEqual({
      source_key: 'page:raw/legacy/1', processor_version: 'legacy',
      event_id: 'legacy-key', revision_id: 'legacy-key', artifact_slug: 'source-events/legacy-key',
    });
  });
});
