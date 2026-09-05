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

describe('migrations v145-v148 source-event receipts and skew repair', () => {
  test('v149 retains the full source-event two-phase contract', async () => {
    expect(LATEST_VERSION).toBe(149);
    const columns = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='source_event_receipts' ORDER BY column_name`,
    );
    const names = columns.map((row) => row.column_name);
    for (const name of [
      'source_key', 'processor_version', 'target_results', 'status', 'event_id',
      'revision_id', 'artifact_slug', 'projection_state', 'run_id',
      'prior_revision_id', 'pending_revision_id', 'pending_fact_ids', 'artifact_hash',
    ]) {
      expect(names).toContain(name);
    }
    const indexes = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='source_event_receipts'`,
    );
    expect(indexes.map((row) => row.indexname)).toContain('idx_source_event_receipts_projection_state');
    const constraints = await engine.executeRaw<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='source_event_receipts'::regclass`,
    );
    const contract = constraints.map((row) => row.definition).join('\n');
    expect(contract).toContain("projection_state");
    expect(contract).toContain("jsonb_typeof(pending_fact_ids) = 'array'");
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
    expect(await runMigrations(engine)).toEqual({ applied: 7, current: LATEST_VERSION });

    const rows = await engine.executeRaw<{ source_key: string; processor_version: string; event_id: string; revision_id: string; artifact_slug: string }>(
      `SELECT source_key,processor_version,event_id,revision_id,artifact_slug
         FROM source_event_receipts WHERE event_key='legacy-key'`,
    );
    expect(rows[0]).toEqual({
      source_key: 'page:raw/legacy/1', processor_version: 'legacy',
      event_id: 'legacy-key', revision_id: 'legacy-key', artifact_slug: 'source-events/legacy-key',
    });
  });

  test('repairs upstream v143-v144 DDL skipped by an old downstream v145 ledger', async () => {
    await engine.executeRaw('DROP TABLE IF EXISTS loop_suppressions');
    await engine.executeRaw('DROP TABLE IF EXISTS open_loops');
    await engine.executeRaw('ALTER TABLE dream_verdicts DROP COLUMN IF EXISTS expires_at');
    await engine.setConfig('version', '145');

    expect(await runMigrations(engine)).toEqual({ applied: 4, current: LATEST_VERSION });

    const dreamColumns = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='dream_verdicts' AND column_name='expires_at'`,
    );
    expect(dreamColumns).toHaveLength(1);
    const loopTables = await engine.executeRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('open_loops','loop_suppressions') ORDER BY table_name`,
    );
    expect(loopTables.map((row) => row.table_name)).toEqual(['loop_suppressions', 'open_loops']);
  });
});
