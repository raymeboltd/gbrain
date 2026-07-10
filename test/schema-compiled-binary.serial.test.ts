import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(import.meta.dir, '..');
let workDir: string;
let binary: string;
let gbrainHome: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'gbrain-schema-compiled-'));
  binary = join(workDir, 'gbrain');
  gbrainHome = join(workDir, 'home');
  mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });
  writeFileSync(
    join(gbrainHome, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'pglite', schema_pack: 'gbrain-base-v2' }),
  );
  const built = spawnSync(
    'bun',
    ['build', '--compile', '--outfile', binary, 'src/cli.ts'],
    { cwd: REPO_ROOT, encoding: 'utf-8' },
  );
  if (built.status !== 0) throw new Error(built.stderr || built.stdout);
}, 30_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function run(args: string[]) {
  return spawnSync(binary, args, {
    cwd: workDir,
    encoding: 'utf-8',
    env: { ...process.env, GBRAIN_HOME: gbrainHome },
  });
}

describe('compiled schema-pack assets', () => {
  test('active pack loads from the compiled binary', () => {
    const result = run(['schema', 'active']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Active pack: gbrain-base-v2 v1.0.0');
  });

  test('list exposes every bundled pack from the same registry', () => {
    const result = run(['schema', 'list']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gbrain-everything');
    expect(result.stdout).toContain('gbrain-base-v2');
  });
});
