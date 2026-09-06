import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resolveSlugForPath } from '../src/core/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let root: string;
let repo: string;
const originalHome = process.env.GBRAIN_HOME;
const originalFetch = globalThis.fetch;
const opts = () => ({ repoPath: repo, sourceId: 'default', strategy: 'markdown' as const,
  noPull: true, noEmbed: true, noExtract: true, noSchemaPack: true, workingTree: false });
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
function put(path: string, body = path) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), `# Synthetic note\n\n${body}\n`);
}
function commit() { git('add', '--all'); git('commit', '-m', 'Synthetic fixture change'); }
async function rows() {
  return engine.executeRaw<{ slug: string; row: unknown }>(
    "SELECT slug,to_jsonb(p) AS row FROM pages p WHERE source_id='default' ORDER BY slug",
  );
}
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  root = mkdtempSync(join(tmpdir(), 'gbrain-excluded-mutations-'));
  process.env.GBRAIN_HOME = join(root, 'home');
  repo = join(root, 'repo'); mkdirSync(repo);
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  globalThis.fetch = Object.assign(async () => { throw new Error('No provider calls permitted'); }, {
    preconnect: () => { throw new Error('No provider preconnect permitted'); },
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});

test('excluded deletion and unsyncable cleanup preserve rows; allowed cleanup still runs', async () => {
  for (const path of ['held/deleted.md', 'allowed/deleted.md', 'held/data.json', 'allowed/data.json']) put(path);
  commit(); await performSync(engine, opts());
  for (const path of ['held/data.json', 'allowed/data.json']) {
    await importFromContent(engine, resolveSlugForPath(path), `# Legacy synthetic page\n\n${path}`, {
      sourceId: 'default', sourcePath: path, noEmbed: true,
    });
  }
  const before = (await rows()).filter(r => r.slug.startsWith('held'));
  unlinkSync(join(repo, 'held/deleted.md')); unlinkSync(join(repo, 'allowed/deleted.md'));
  put('held/data.json', 'changed excluded JSON'); put('allowed/data.json', 'changed allowed JSON');
  commit();
  const reads = spyOn(engine, 'getPage');
  try {
    await performSync(engine, { ...opts(), exclude: ['held/**'] });
    expect(reads.mock.calls.filter(([slug]) => slug.startsWith('held'))).toEqual([]);
  } finally { reads.mockRestore(); }
  expect((await rows()).filter(r => r.slug.startsWith('held'))).toEqual(before);
  for (const path of ['allowed/deleted.md', 'allowed/data.json']) {
    const page = await engine.getPage(resolveSlugForPath(path), { sourceId: 'default' });
    expect(page).toBeNull();
  }
  expect((await engine.executeRaw<{ last_commit: string }>("SELECT last_commit FROM sources WHERE id='default'"))[0].last_commit).toBe(git('rev-parse', 'HEAD'));
});

test('either excluded rename endpoint defers the whole identity move; allowed renames still run', async () => {
  const moves = [
    ['held/out.md', 'allowed/from-held.md'],
    ['allowed/into-held.md', 'held/in.md'],
    ['held/inside.md', 'held/renamed.md'],
    ['held/to-json.md', 'allowed/from-held.json'],
    ['allowed/to-held-json.md', 'held/destination.json'],
    ['allowed/move.md', 'allowed/renamed.md'],
    ['allowed/to-json.md', 'allowed/destination.json'],
  ];
  for (const [from] of moves) put(from, `${from}\n`.repeat(20));
  commit(); await performSync(engine, opts());
  // Existing destination rows must survive too; excluded renames cannot merge
  // either identity or overwrite the destination's independently stored body.
  for (const [, to] of moves.slice(0, 2)) await importFromContent(engine, resolveSlugForPath(to), '# Existing destination\n\nIndependent synthetic body', {
    sourceId: 'default', sourcePath: to, noEmbed: true,
  });
  const protectedSlugs = [...moves.slice(0, 5).map(([from]) => resolveSlugForPath(from)),
    ...moves.slice(0, 2).map(([, to]) => resolveSlugForPath(to))];
  const before = (await rows()).filter(r => protectedSlugs.includes(r.slug));
  for (const [from, to] of moves) { mkdirSync(dirname(join(repo, to)), { recursive: true }); renameSync(join(repo, from), join(repo, to)); }
  commit();
  expect(git('diff', '--name-status', '-M', 'HEAD^', 'HEAD').split('\n').every(line => line.startsWith('R'))).toBeTrue();
  const reads = spyOn(engine, 'getPage');
  let result;
  try {
    result = await performSync(engine, { ...opts(), exclude: ['held/**'] });
    expect(reads.mock.calls.filter(([slug]) => protectedSlugs.includes(slug))).toEqual([]);
  } finally { reads.mockRestore(); }
  expect((await rows()).filter(r => protectedSlugs.includes(r.slug))).toEqual(before);
  for (const [, to] of moves.slice(2, 5)) expect(await engine.getPage(resolveSlugForPath(to), { sourceId: 'default' })).toBeNull();
  expect(await engine.getPage('allowed/renamed', { sourceId: 'default' })).not.toBeNull();
  expect(await engine.getPage('allowed/move', { sourceId: 'default' })).toBeNull();
  expect(await engine.getPage('allowed/to-json', { sourceId: 'default' })).toBeNull();
  expect(result.renamed).toBe(1);
  // Advancing the bookmark does not implicitly replay a deferred rename.
  expect((await performSync(engine, opts())).status).toBe('up_to_date');
  expect((await rows()).filter(r => protectedSlugs.includes(r.slug))).toEqual(before);
});
