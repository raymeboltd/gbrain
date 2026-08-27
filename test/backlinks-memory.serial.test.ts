import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Production regression: the legacy walker retained the full Markdown corpus
 * plus extracted copies. An 0.82 GiB brain therefore peaked near 10 GiB RSS
 * during every Autopilot backlinks phase.
 *
 * Run the public seam in a fresh process so maxRSS is attributable to this
 * scan, not to the Bun test runner and its other suites.
 */
describe('findBacklinkGaps memory bound', () => {
  function runProbe(pageCount: number, lane: 'raw' | 'people'): { gaps: number; maxRSS: number } {
    const root = mkdtempSync(join(tmpdir(), `gbrain-backlinks-memory-${lane}-${pageCount}-`));
    try {
      mkdirSync(join(root, 'people'));
      mkdirSync(join(root, 'raw'));
      mkdirSync(join(root, 'meetings'));
      if (lane === 'raw') {
        writeFileSync(join(root, 'people/alice.md'), '# Alice\n');
        writeFileSync(join(root, 'meetings/anchor.md'), '# Anchor\n\nMet [Alice](../people/alice).\n');
      }

      const oneMiBPage = lane === 'raw'
        ? '# Raw\n\n' + 'x'.repeat(1024 * 1024 - 8)
        : '# Person\n\n' + 'x'.repeat(1024 * 1024 - 11);
      for (let i = 0; i < pageCount; i++) {
        writeFileSync(join(root, lane, `page-${i}.md`), oneMiBPage);
        if (lane === 'people') {
          writeFileSync(
            join(root, 'meetings', `mention-${i}.md`),
            `# Mention ${i}\n\nMet [Person ${i}](../people/page-${i}).\n`,
          );
        }
      }

      const probe = `
        import { findBacklinkGaps } from './src/commands/backlinks.ts';
        const gaps = findBacklinkGaps(process.argv[1]);
        console.log(JSON.stringify({ gaps: gaps.length, maxRSS: process.resourceUsage().maxRSS }));
      `;
      const child = Bun.spawnSync([process.execPath, '-e', probe, root], {
        cwd: join(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(child.exitCode, child.stderr.toString()).toBe(0);
      return JSON.parse(child.stdout.toString()) as { gaps: number; maxRSS: number };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test('peak RSS stays flat as raw corpus bytes grow 8x', () => {
    const small = runProbe(16, 'raw');
    const large = runProbe(128, 'raw');

    expect(small.gaps).toBe(1);
    expect(large.gaps).toBe(1);
    expect(large.maxRSS - small.maxRSS).toBeLessThan(64 * 1024 * 1024);
  }, 20_000);

  test('peak RSS stays bounded when target pages grow 8x', () => {
    const small = runProbe(16, 'people');
    const large = runProbe(128, 'people');

    expect(small.gaps).toBe(16);
    expect(large.gaps).toBe(128);
    expect(large.maxRSS - small.maxRSS).toBeLessThan(256 * 1024 * 1024);
  }, 20_000);
});
