import type { NewFact } from '../engine.ts';

export type FenceInput = NewFact & { row_num: number; source_markdown_slug: string; superseded_by_row?: number };
type Query = (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
export const retainedFactKey = (fact: string, source: string | null | undefined) => `${fact}\u0000${source ?? 'fence:reconcile'}`;

/** Keep identity and DB-only provenance for surviving canonical claims. All
 * statements run in the caller's insert transaction, including row renumbering.
 * Never carry provenance across a changed claim or source. */
export async function reconcileRetainedFacts(
  query: Query, rows: FenceInput[], sourceId: string,
  del: { slug: string; excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean },
): Promise<{ retained: Map<string, number>; deleted: number }> {
  const existing = await query(
    `SELECT id,fact,source FROM facts WHERE source_id=$1 AND source_markdown_slug=$2
       AND NOT (COALESCE(source,'') LIKE ANY($3::text[]))
       AND NOT ($4::boolean AND row_num IS NULL AND expired_at IS NOT NULL)
       ORDER BY id FOR UPDATE`,
    [sourceId, del.slug, (del.excludeSourcePrefixes ?? []).map(p => `${p}%`), del.preserveExpiredLegacy ?? false],
  );
  const desired = new Map(rows.filter(r => r.source_markdown_slug === del.slug).map(r => [retainedFactKey(r.fact, r.source), r]));
  // A duplicate can own a source-event artifact or another fact's FK.
  // Picking either ID silently severs the other's provenance. Fail closed
  // before touching coordinates; explicit identity repair must resolve it.
  const seen = new Set<string>();
  for (const old of existing) {
    const key = retainedFactKey(String(old.fact), old.source as string | null);
    if (desired.has(key) && seen.has(key)) {
      throw new Error(`FACT_RECONCILE_AMBIGUOUS_IDENTITY: ${sourceId}/${del.slug} has duplicate claim/source IDs; existing facts preserved`);
    }
    seen.add(key);
  }
  const retained = new Map<string, number>();
  let deleted = 0;
  for (const old of existing) {
    const key = retainedFactKey(String(old.fact), old.source as string | null);
    const id = Number(old.id);
    if (!desired.has(key)) {
      await query('DELETE FROM facts WHERE id=$1 AND source_id=$2 RETURNING id', [id, sourceId]);
      deleted++;
    } else {
      retained.set(key, id);
      // Free the partial-unique row coordinate before any row swaps.
      await query('UPDATE facts SET row_num=NULL WHERE id=$1 AND source_id=$2 RETURNING id', [id, sourceId]);
    }
  }
  for (const [key, id] of retained) {
    const row = desired.get(key)!;
    await query(
      `UPDATE facts SET row_num=$3, kind=$4, visibility=$5, notability=$6,
         context=$7, valid_from=COALESCE($8::timestamptz,valid_from), valid_until=$9,
         expired_at=$10, superseded_by=NULL, confidence=$11,
         claim_metric=COALESCE($12,claim_metric), claim_value=COALESCE($13,claim_value),
         claim_unit=COALESCE($14,claim_unit), claim_period=COALESCE($15,claim_period),
         event_type=COALESCE($16,event_type)
       WHERE id=$1 AND source_id=$2 RETURNING id`,
      [id, sourceId, row.row_num, row.kind ?? 'fact', row.visibility ?? 'private',
        row.notability ?? 'medium', row.context ?? null, row.valid_from ?? null,
        row.valid_until ?? null, row.expired_at ?? null, row.confidence ?? 1,
        row.claim_metric ?? null, row.claim_value ?? null, row.claim_unit ?? null,
        row.claim_period ?? null, row.event_type ?? null],
    );
  }
  return { retained, deleted };
}
