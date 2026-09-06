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
): Promise<{ retained: Map<FenceInput, number>; deleted: number }> {
  const existing = await query(
    `SELECT id,fact,source,row_num,context FROM facts WHERE source_id=$1 AND source_markdown_slug=$2
       AND NOT (COALESCE(source,'') LIKE ANY($3::text[]))
       AND NOT ($4::boolean AND row_num IS NULL AND expired_at IS NOT NULL)
       ORDER BY id FOR UPDATE`,
    [sourceId, del.slug, (del.excludeSourcePrefixes ?? []).map(p => `${p}%`), del.preserveExpiredLegacy ?? false],
  );
  const desired = new Map<string, FenceInput[]>();
  for (const row of rows.filter(r => r.source_markdown_slug === del.slug)) {
    const key = retainedFactKey(row.fact, row.source);
    desired.set(key, [...(desired.get(key) ?? []), row]);
  }
  const groups = new Map<string, typeof existing>();
  for (const old of existing) {
    const key = retainedFactKey(String(old.fact), old.source as string | null);
    groups.set(key, [...(groups.get(key) ?? []), old]);
  }
  // Validate every identity before any deletion or coordinate update. Unique
  // claims can be renumbered. Duplicates require a complete exact coordinate /
  // context bijection; a partial match must never discard another event's ID.
  const retained = new Map<FenceInput, number>();
  const coordinate = (row: { row_num?: unknown; context?: unknown }) =>
    JSON.stringify([row.row_num ?? null, row.context ?? null]);
  const ambiguous = () => new Error(
    `FACT_RECONCILE_AMBIGUOUS_IDENTITY: ${sourceId}/${del.slug} has no complete duplicate identity bijection; existing facts preserved`,
  );
  for (const [key, oldRows] of groups) {
    const inputs = desired.get(key) ?? [];
    if (oldRows.length <= 1 && inputs.length <= 1) {
      if (inputs[0]) retained.set(inputs[0], Number(oldRows[0].id));
      continue;
    }
    if (oldRows.length !== inputs.length) throw ambiguous();
    const byCoordinate = new Map(oldRows.map(old => [coordinate(old), old]));
    if (byCoordinate.size !== oldRows.length) throw ambiguous();
    for (const input of inputs) {
      const key = coordinate(input);
      const old = byCoordinate.get(key);
      if (!old || input.row_num == null) throw ambiguous();
      retained.set(input, Number(old.id));
      byCoordinate.delete(key);
    }
    if (byCoordinate.size) throw ambiguous();
  }
  const retainedIds = new Set(retained.values());
  let deleted = 0;
  for (const old of existing) {
    const id = Number(old.id);
    if (!retainedIds.has(id)) {
      await query('DELETE FROM facts WHERE id=$1 AND source_id=$2 RETURNING id', [id, sourceId]);
      deleted++;
    } else {
      // Free the partial-unique row coordinate before any row swaps.
      await query('UPDATE facts SET row_num=NULL WHERE id=$1 AND source_id=$2 RETURNING id', [id, sourceId]);
    }
  }
  for (const [row, id] of retained) {
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
