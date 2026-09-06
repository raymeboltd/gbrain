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

/** Duplicate fence claims retain distinct event identities only with an exact bijection. */
export async function assertDuplicateFactIdentity(engine: BrainEngine) {
  const sourceId = 'duplicate-fact-fixture';
  const slug = 'projects/duplicate-fixture';
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  const rows = [1, 2].map(row_num => ({
    fact: 'Repeated fixture claim', source: 'source-event', row_num,
    source_markdown_slug: slug, context: `raw/fixture-${row_num}`,
    source_session: `fixture-session-${row_num}`, claim_metric: 'count', claim_value: row_num,
  }));
  const read = () => engine.executeRaw('SELECT * FROM facts WHERE source_id=$1 ORDER BY id', [sourceId]);
  const reconcile = (input: typeof rows) => engine.insertFacts(input, {source_id: sourceId}, {deleteForPageFirst: {slug}});
  try {
    await engine.insertFacts(rows, {source_id: sourceId});
    await engine.executeRaw("UPDATE facts SET created_at='2020-01-02T03:04:05Z' WHERE source_id=$1", [sourceId]);
    const column = await engine.executeRaw<{ type: string }>("SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='facts'::regclass AND attname='embedding'");
    const width = Number(column[0].type.match(/\((\d+)\)/)![1]);
    await engine.executeRaw(`UPDATE facts SET embedding=$1::${column[0].type},embedded_at='2020-02-03T00:00:00Z' WHERE source_id=$2`, ['[' + Array(width).fill('0.25').join(',') + ']', sourceId]);
    const initial = await read();
    await engine.executeRaw(`INSERT INTO source_event_receipts(source_id,event_id,revision_id,event_key,artifact_slug,source_kind,source_key,source_uri,source_slug,content_hash,processor_version,observed_at,event_date,status,target_results)
      VALUES($1,'duplicate-event','r1','duplicate-event',$2,'fixture','key','fixture://local',$2,'hash','fixture',now(),now(),'applied',jsonb_build_array(jsonb_build_object('fact_ids',jsonb_build_array($3::bigint,$4::bigint))))`, [sourceId, slug, Number(initial[0].id), Number(initial[1].id)]);
    const receipts = () => engine.executeRaw('SELECT * FROM source_event_receipts WHERE source_id=$1', [sourceId]);
    const receiptBefore = await receipts();
    const result = await reconcile([...rows].reverse());
    expect(result.updated).toBe(2);
    expect(result.inserted).toBe(0);
    expect(result.deleted).toBe(0);
    expect(await read()).toEqual(initial);
    expect(await receipts()).toEqual(receiptBefore);
    // Another source may carry the same slug / claim / coordinate.
    await engine.insertFacts([{...rows[0], source_session:'other-source'}], {source_id:'default'});
    const other = await engine.executeRaw('SELECT * FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', ['default',slug]);
    // Count mismatch, claim edits, context edits, coordinate swaps and duplicate
    // inputs cannot prove a complete original-ID mapping. All fail atomically.
    const candidates = [
      [rows[0]],
      rows.map((r,i) => i ? {...r,fact:'Changed claim'} : r),
      rows.map((r,i) => i ? {...r,context:'changed context'} : r),
      rows.map(r => ({...r,row_num:3-r.row_num})),
      [rows[0], rows[0]],
      rows.map(r => ({...r,fact:'Different replacement'})),
    ];
    for (const candidate of candidates) {
      await expect(reconcile(candidate)).rejects.toThrow('FACT_RECONCILE_AMBIGUOUS_IDENTITY');
      expect(await read()).toEqual(initial);
      expect(await receipts()).toEqual(receiptBefore);
    }
    expect(await engine.executeRaw('SELECT * FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', ['default',slug])).toEqual(other);
    // Distinct retained row IDs must also drive supersession's second pass.
    const replacement = {...rows[0], row_num:3, fact:'Superseding fixture claim'};
    const superseded = rows.map(r => ({...r, expired_at:new Date('2026-01-01'), superseded_by_row:3}));
    await reconcile([...superseded, replacement]);
    const final = await read();
    const replacementId = final.find(r => r.fact===replacement.fact)!.id;
    for (const old of initial) {
      const retained = final.find(r => r.id===old.id)!;
      expect(retained.superseded_by).toBe(replacementId);
      for (const field of ['source_session','created_at','embedding','embedded_at','claim_value']) expect(retained[field]).toEqual(old[field]);
    }
    expect(await receipts()).toEqual(receiptBefore);
  } finally {
    await engine.executeRaw('DELETE FROM source_event_receipts WHERE source_id=$1',[sourceId]);
    await engine.executeRaw('DELETE FROM facts WHERE source_id=$1 OR (source_id=$2 AND source_markdown_slug=$3)',[sourceId,'default',slug]);
    await engine.executeRaw('DELETE FROM sources WHERE id=$1',[sourceId]);
  }
}
