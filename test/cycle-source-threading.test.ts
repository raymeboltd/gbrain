import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __testing as synthTesting } from '../src/core/cycle/synthesize.ts';
import { __testing as patternsTesting } from '../src/core/cycle/patterns.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('vault', 'Vault') ON CONFLICT (id) DO NOTHING`,
  );
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-source-threading-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

describe('dream cycle source threading', () => {
  test('summary page writes to the active source and active checkout root', async () => {
    const slug = 'dream-cycle-summaries/2099-01-01';
    await synthTesting.writeSummaryPage(
      engine,
      brainDir,
      slug,
      '2099-01-01',
      [],
      [],
      'vault',
    );

    expect(await engine.getPage(slug, { sourceId: 'vault' })).not.toBeNull();
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
    expect(existsSync(join(brainDir, `${slug}.md`))).toBe(true);
    expect(existsSync(join(brainDir, '.sources', 'vault', `${slug}.md`))).toBe(false);
  });

  test('synthesis reverse-write treats the active non-default source as root', async () => {
    const slug = 'wiki/personal/reflections/source-threaded';
    await engine.putPage(slug, {
      type: 'note',
      title: 'Source threaded',
      compiled_truth: 'vault body',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'vault' });

    const count = await synthTesting.reverseWriteRefs(
      engine,
      brainDir,
      [{ slug, source_id: 'vault' }],
      'vault',
    );
    expect(count).toBe(1);
    expect(readFileSync(join(brainDir, `${slug}.md`), 'utf8')).toContain('vault body');
    expect(existsSync(join(brainDir, '.sources', 'vault', `${slug}.md`))).toBe(false);
  });

  test('patterns only gathers reflections from the requested source', async () => {
    const slug = 'wiki/personal/reflections/source-filter';
    await engine.putPage(slug, {
      type: 'note',
      title: 'Default reflection',
      compiled_truth: 'default body',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
    await engine.putPage(slug, {
      type: 'note',
      title: 'Vault reflection',
      compiled_truth: 'vault body',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'vault' });

    const rows = await patternsTesting.gatherReflections(engine, 30, 'vault');
    const match = rows.find(row => row.slug === slug);
    expect(match?.title).toBe('Vault reflection');
    expect(match?.excerpt).toContain('vault body');
  });
});
