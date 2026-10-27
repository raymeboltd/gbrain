/** Refresh must preserve the existing sync processing consent across a crash.
 * Real local Git, native refresh journal and managed sync; provider I/O denied.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseRefreshArgs } from '../src/commands/sources-refresh.ts';
import { refreshWorktree, resumeWorktreeRefreshes } from '../src/core/persistence/worktree-refresh.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const backends = testBackends();
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});

const each = async (run: (f: RefreshFixture) => Promise<void>) => {
  for (const engine of engines) await withRefreshFixture(engine, async f => {
    const prior = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = Object.assign(async () => { networkCalls++; throw new Error('Provider/network I/O forbidden in refresh processing fixture'); }, { preconnect: prior.preconnect });
    try { await run(f); expect(networkCalls).toBe(0); }
    finally { await disposePersistenceConsumer(engine); globalThis.fetch = prior; }
  });
};

async function assertSuppressed(f: RefreshFixture, target: string): Promise<void> {
  await disposePersistenceConsumer(f.engine);
  const imports = await f.engine.executeRaw<{ source_id: string; processing: unknown }>(`SELECT source_id,intent->'processingOptions' AS processing
    FROM persistence_requests WHERE source_id=ANY($1::text[]) AND intent->>'kind'='managed_sync_import' AND intent->>'target'=$2`, [[f.alpha, f.beta], target]);
  expect(imports.length).toBeGreaterThan(0);
  for (const row of imports) expect(row.processing).toEqual({ noEmbed: true, noExtract: true, noSchemaPack: false });
  expect(await f.engine.executeRaw("SELECT kind FROM persistence_effects WHERE source_id=ANY($1::text[]) AND kind IN ('embedding','facts-backstop')", [[f.alpha, f.beta]])).toEqual([]);
  // Exercise the actual effect execution boundary with a zero-cost transport.
  let embeddingCalls = 0;
  await runPersistenceEffects(f.engine, { engine: f.engine.kind, embedding_disabled: false }, {
    hostId: localHostId(), limit: 100,
    embedding: { signature: 'test:refresh:1536', model: 'test:refresh', embed: async texts => {
      embeddingCalls++; return texts.map(() => new Float32Array(1536).fill(0.1));
    } },
  });
  expect(embeddingCalls).toBe(0);
  expect(await f.engine.executeRaw('SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=ANY($1::text[]) AND c.embedding IS NOT NULL', [[f.alpha, f.beta]])).toEqual([]);
}

test('refresh parser accepts independent opt-outs without changing omitted defaults', () => {
  expect(parseRefreshArgs(['notes', '--no-embed', '--no-extract']).options).toMatchObject({ noEmbed: true, noExtract: true });
  expect(parseRefreshArgs(['notes', '--no-embed']).options.noExtract).toBeUndefined();
  expect(parseRefreshArgs(['notes', '--no-extract']).options.noEmbed).toBeUndefined();
  expect(parseRefreshArgs(['notes']).options.noEmbed).toBeUndefined();
  expect(() => parseRefreshArgs(['notes', '--no-extract-typo'])).toThrow('Unknown sources refresh flag');
});

test('refresh freezes both opt-outs before merge and flagless owner recovery/resume preserves every member', () => each(async f => {
  f.push('alpha/new.md', page('New alpha', 'A synthetic observation about [[one]].'));
  const target = f.push('beta/new.md', page('New beta', 'Another synthetic observation about [[one]].'));
  await expect(refreshWorktree(f.engine, f.alpha, { noEmbed: true, noExtract: true, hooks: { boundary: point => {
    if (point === 'merged') throw new Error('injected interruption after merge');
  } } })).rejects.toThrow('injected interruption after merge');
  await disposePersistenceConsumer(f.engine);
  const [interrupted] = await f.refreshRows();
  expect(interrupted!.state).toBe('fenced');
  expect(interrupted!.outcome.processingOptions).toEqual({ noEmbed: true, noExtract: true, noSchemaPack: false });
  expect(f.head()).toBe(target);
  // A changed resume cannot overwrite the stored pre-merge processing intent.
  await expect(refreshWorktree(f.engine, f.alpha, { resume: true, noEmbed: false })).rejects.toMatchObject({ code: 'invalid_params' });
  expect((await f.refreshRows())[0].outcome).toEqual(interrupted!.outcome);
  await resumeWorktreeRefreshes(f.engine);
  expect((await f.refreshRows())[0].state).toBe('syncing');
  expect(await refreshWorktree(f.engine, f.alpha, { resume: true })).toMatchObject({ status: 'completed', target_head: target });
  expect(await f.lastCommit(f.alpha)).toBe(target);
  expect(await f.lastCommit(f.beta)).toBe(target);
  expect((await f.refreshRows())[0].outcome.processingOptions).toEqual(interrupted!.outcome.processingOptions);
  await assertSuppressed(f, target);
}), 180_000);

test('already-current checkout catch-up forwards both opt-outs without a refresh row', () => each(async f => {
  f.push('alpha/new.md', page('New alpha', 'A synthetic catch-up observation.'));
  const target = f.push('beta/new.md', page('New beta', 'Another synthetic catch-up observation.'));
  git(f.root, 'pull', '--ff-only', '--quiet'); // fixture only: DB is deliberately behind its checkout
  expect(await refreshWorktree(f.engine, f.alpha, { noEmbed: true, noExtract: true })).toMatchObject({ status: 'already_current', target_head: target });
  expect(await f.refreshRows()).toEqual([]);
  await assertSuppressed(f, target);
}), 180_000);
