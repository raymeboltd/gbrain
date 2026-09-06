import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { renderFactsTable, type ParsedFact } from '../../src/core/facts-fence.ts';

/** Real-engine contract shared by PGLite and Postgres. No provider calls. */
export async function assertFactProvenanceRoundTrip(engine: BrainEngine) {
  const slug = 'projects/provenance-fixture';
  const sourceId = 'fact-provenance-fixture';
  await engine.executeRaw(`INSERT INTO sources(id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [sourceId]);
  const facts: ParsedFact[] = [1, 2, 3].map(rowNum => ({
    rowNum, claim: `Claim ${rowNum}`, kind: 'fact', confidence: 1,
    visibility: 'private', notability: 'medium', source: 'source-event',
    validFrom: '2026-01-02', context: 'raw/fixture', active: true,
  }));
  const put = async () => engine.putPage(slug, {
    title: 'Provenance fixture', type: 'project', compiled_truth: renderFactsTable(facts),
  }, { sourceId });
  const read = async () => Array.from(await engine.executeRaw<Record<string, unknown>>(
    `SELECT id,fact,row_num,source_session,created_at,claim_metric,claim_value,event_type,
       expired_at,superseded_by FROM facts WHERE source_id=$1 ORDER BY row_num`, [sourceId],
  ));
  try {
    await put();
    await runExtractFacts(engine, { sourceId, slugs: [slug] });
    await engine.executeRaw(`UPDATE facts SET source_session='source-event:fixture-run',
      created_at='2026-01-03T04:05:06Z',claim_metric='team_size',claim_value=7,event_type='meeting'
      WHERE source_id=$1`, [sourceId]);
    const before = await read();
    // Swap row coordinates and add a superseding claim; neither is a new
    // provenance event for the existing claims.
    facts[0].rowNum = 2;
    facts[1].rowNum = 1;
    facts[0].active = false;
    facts[0].supersededBy = 4;
    facts[0].context = 'raw/fixture | superseded by #4';
    facts.push({ ...facts[2], rowNum: 4, claim: 'Replacement claim' });
    facts[1].claimMetric = 'mrr';
    facts[1].claimValue = 50000;
    await put();
    const result = await runExtractFacts(engine, { sourceId, slugs: [slug] });
    expect(result.factsDeleted).toBe(0);
    expect(result.factsInserted).toBe(1);
    expect(result.factsUpdated).toBe(3);
    const after = await read();
    for (const old of before) {
      const kept = after.find(r => r.fact === old.fact)!;
      expect(kept.id).toBe(old.id);
      expect(kept.source_session).toBe(old.source_session);
      expect(String(kept.created_at)).toBe(String(old.created_at));
      expect(kept.event_type).toBe('meeting');
    }
    expect(after.find(r => r.fact === 'Claim 2')?.claim_metric).toBe('mrr');
    expect(Number(after.find(r => r.fact === 'Claim 2')?.claim_value)).toBe(50000);
    expect(after.find(r => r.fact === 'Claim 3')?.claim_metric).toBe('team_size');
    const struck = after.find(r => r.fact === 'Claim 1')!;
    expect(struck.expired_at).not.toBeNull();
    expect(Number(struck.superseded_by)).toBe(Number(after.find(r => r.fact === 'Replacement claim')!.id));
    const second = await runExtractFacts(engine, { sourceId, slugs: [slug] });
    expect(second.factsInserted + second.factsDeleted + second.factsUpdated).toBe(0);
    expect(await read()).toEqual(after);
    // A failed fresh insert must roll retained-row renumbering back as well.
    await expect(engine.insertFacts([
      {fact:'Claim 3', source:'source-event', row_num:8, source_markdown_slug:slug},
      {fact:'Invalid claim', source:'source-event', row_num:9, source_markdown_slug:slug, confidence:2},
    ], { source_id:sourceId }, {deleteForPageFirst:{slug}})).rejects.toThrow();
    expect(await read()).toEqual(after);
    // The lower ID lacks provenance; the newer duplicate is owned by an
    // event. Arbitrarily retaining the lower ID would sever that event.
    await engine.executeRaw(`UPDATE facts SET source_session=NULL WHERE source_id=$1 AND fact='Claim 3'`, [sourceId]);
    await engine.insertFacts([{fact:'Claim 3',source:'source-event',source_session:'source-event:newer-owner',
      row_num:7,source_markdown_slug:slug}], {source_id:sourceId});
    const ambiguous = await read();
    await expect(runExtractFacts(engine,{sourceId,slugs:[slug]})).rejects.toThrow('FACT_RECONCILE_AMBIGUOUS_IDENTITY');
    expect(await read()).toEqual(ambiguous);
  } finally {
    await engine.executeRaw('DELETE FROM facts WHERE source_id=$1', [sourceId]);
    await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [sourceId]);
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
  }
}
