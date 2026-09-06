/**
 * Regression test for the extract_facts per-page fault isolation fix.
 *
 * Intended path once the patch lands:
 *   test/e2e/extract-facts-ambiguous-identity-isolation.test.ts
 * Harness mirrors test/e2e/facts-fence-reconcile-postgres.test.ts (7cab841c3).
 *
 * Production symptom this pins (gbrain-prod-02, source `personal`):
 * a page whose fence-owned DB rows carry duplicate (claim, source) keys makes
 * reconcileRetainedFacts throw FACT_RECONCILE_AMBIGUOUS_IDENTITY
 * (src/core/facts/reconcile-retained.ts:46). The fence side can never match that
 * cardinality because dedupeFactsByContentKey (src/core/cycle/extract-facts.ts:95-105,
 * applied at :612) caps the desired set at one row per key. Pre-fix the throw
 * escapes the per-page loop (src/core/cycle/extract-facts.ts:529-791 has no
 * per-page catch; guardedFactReconcile at :180-213 has none either) and is only
 * caught at the phase boundary (src/core/cycle.ts:1544), so every page after the
 * first ambiguous one is left unreconciled.
 *
 * Pre-fix this file FAILS on the first assertion (the call rejects).
 * Post-fix it passes: the ambiguous page is skipped with a warning and a
 * pagesFailed count, its rows are preserved, and the NEXT page still reconciles.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { renderFactsTable, type ParsedFact } from '../../src/core/facts-fence.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;

if (skip) test.skip('extract_facts ambiguous-identity isolation skipped (DATABASE_URL unset)', () => {});

describe.skipIf(skip)('extract_facts isolates FACT_RECONCILE_AMBIGUOUS_IDENTITY to one page', () => {
  // Ordered: opts.slugs is used verbatim (extract-facts.ts:507-510), so the
  // ambiguous page is guaranteed to be visited before the clean one.
  const dupSlug = 'people/ambiguous-identity-example';
  const cleanSlug = 'people/ambiguous-identity-neighbour';
  const DUP_CLAIM = 'Robin uses Apple Health as a health data integration';
  const SRC = 'source-event';
  let engine: PostgresEngine;

  const cleanup = async () => {
    for (const s of [dupSlug, cleanSlug]) {
      await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug = $1', [s]);
      await engine.executeRaw('DELETE FROM pages WHERE slug = $1', [s]);
    }
  };

  beforeAll(async () => {
    engine = new PostgresEngine();
    assertSafeE2eDatabaseUrl(databaseUrl!);
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
    await cleanup();

    // ── Ambiguous page: fence carries the SAME claim twice ─────────────
    const dupFacts: ParsedFact[] = [1, 2].map(rowNum => ({
      rowNum, claim: DUP_CLAIM, kind: 'fact', confidence: 0.95,
      visibility: 'private', notability: 'medium', source: SRC,
      context: `raw/gmail/thread-${rowNum}`, active: true,
    }));
    await engine.putPage(dupSlug, {
      title: 'Ambiguous Identity Example', type: 'person',
      compiled_truth: renderFactsTable(dupFacts), frontmatter: {}, timeline: '',
    });
    // Plant the production shape directly: two ACTIVE rows sharing
    // (fact, source) with distinct row_num. No deleteForPageFirst, so this
    // insert does not go through reconcileRetainedFacts.
    await engine.insertFacts(
      dupFacts.map(f => ({
        fact: DUP_CLAIM, source: SRC, row_num: f.rowNum, source_markdown_slug: dupSlug,
        context: f.context ?? null, confidence: 0.95,
        kind: 'fact' as const, visibility: 'private' as const, notability: 'medium' as const,
      })),
      { source_id: 'default' },
    );

    // ── Clean neighbour: one unique fence row, nothing in the DB yet ────
    const cleanFacts: ParsedFact[] = [{
      rowNum: 1, claim: 'neighbour page reconciles normally', kind: 'fact',
      confidence: 1, visibility: 'private', notability: 'medium', source: SRC, active: true,
    }];
    await engine.putPage(cleanSlug, {
      title: 'Ambiguous Identity Neighbour', type: 'person',
      compiled_truth: renderFactsTable(cleanFacts), frontmatter: {}, timeline: '',
    });
  });

  afterAll(async () => {
    if (engine) { await cleanup(); await engine.disconnect(); }
  });

  test('the walk continues past the ambiguous page and reconciles the next one', async () => {
    // Pre-fix: this call REJECTS with FACT_RECONCILE_AMBIGUOUS_IDENTITY.
    const result = await runExtractFacts(engine, { slugs: [dupSlug, cleanSlug] });

    // 1. The failure is recorded, not thrown.
    expect(result.pagesFailed).toBe(1);
    expect(result.warnings.some(w =>
      w.includes(dupSlug) && w.includes('FACT_RECONCILE_AMBIGUOUS_IDENTITY'))).toBe(true);

    // 2. The ambiguous page is untouched — reconcileRetainedFacts validates
    //    every identity before it issues a single statement, so "skip the page"
    //    and "preserve the page" are the same outcome.
    const dupRows = await engine.executeRaw<{ n: string }>(
      'SELECT count(*) AS n FROM facts WHERE source_markdown_slug = $1 AND expired_at IS NULL',
      [dupSlug],
    );
    expect(Number(Array.from(dupRows)[0]!.n)).toBe(2);

    // 3. The page AFTER it in the walk still got reconciled — this is the
    //    whole point: pre-fix the throw stranded every later page.
    const cleanRows = await engine.executeRaw<{ fact: string }>(
      'SELECT fact FROM facts WHERE source_markdown_slug = $1 AND expired_at IS NULL',
      [cleanSlug],
    );
    expect(Array.from(cleanRows).map(r => r.fact)).toEqual(['neighbour page reconciles normally']);
    expect(result.pagesScanned).toBe(2);
  });
});
