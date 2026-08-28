import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import type { BrainEngine } from '../engine.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../facts-fence.ts';
import { withPageLock } from '../page-lock.ts';
import { resolvePageWriteTarget } from '../write-through.ts';

interface FactFenceRow {
  id: number;
  source_id: string;
  row_num: number | null;
  source_markdown_slug: string | null;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function removePendingMarker(context: string | undefined, runId: string): string | undefined {
  const marker = `source-event-pending:${runId}`;
  const parts = (context ?? '').split('|').map((part) => part.trim()).filter(Boolean);
  if (!parts.includes(marker)) return context;
  const kept = parts.filter((part) => part !== marker);
  return kept.length > 0 ? kept.join(' | ') : undefined;
}

/**
 * Mark or finalize a filesystem-canonical fact row around the source-event DB
 * commit. Every affected page is marked before the transaction. The marker is
 * removed only after the durable receipt commit, so extract_facts cannot race
 * a correction and rebuild a partially committed projection.
 */
export async function prepareSourceEventFactFence(
  engine: BrainEngine,
  input: {
    sourceId: string;
    factId: number;
    action: 'mark_pending' | 'activate_pending' | 'expire_prior' | 'clear_pending';
    runId: string;
    reason: string;
  },
): Promise<void> {
  const rows = await engine.executeRaw<FactFenceRow>(
    `SELECT id,source_id,row_num,source_markdown_slug FROM facts WHERE id=$1 AND source_id=$2`,
    [input.factId, input.sourceId],
  );
  const row = rows[0];
  if (!row || row.row_num === null || row.source_markdown_slug === null) {
    throw new Error(`source-event: fact ${input.factId} is not filesystem-canonical`);
  }
  const resolved = await resolvePageWriteTarget(engine, row.source_markdown_slug, row.source_id);
  if (!resolved.ok || !existsSync(resolved.filePath)) {
    throw new Error(`source-event: canonical fact file unavailable for ${input.factId}`);
  }
  const filePath = resolved.filePath;
  const tmpPath = `${filePath}.tmp`;
  await withPageLock(row.source_markdown_slug, async () => {
    const body = readFileSync(filePath, 'utf8');
    const parsed = parseFactsFence(body);
    if (parsed.warnings.length > 0) {
      throw new Error(`source-event: malformed fact fence for ${input.factId}: ${parsed.warnings.join('; ')}`);
    }
    const target = parsed.facts.find((fact) => fact.rowNum === row.row_num);
    if (!target) throw new Error(`source-event: fact ${input.factId} missing from canonical fence`);
    const updated: ParsedFact[] = parsed.facts.map((fact) => {
      if (fact.rowNum !== row.row_num) return fact;
      const marker = `source-event-pending:${input.runId}`;
      if (input.action === 'mark_pending') {
        const parts = (fact.context ?? '').split('|').map((part) => part.trim()).filter(Boolean);
        if (parts.includes(marker)) return fact;
        return { ...fact, context: [...parts, marker].join(' | ') };
      }
      if (input.action === 'clear_pending') {
        return { ...fact, context: removePendingMarker(fact.context, input.runId) };
      }
      if (input.action === 'activate_pending') {
        if (fact.active && !(fact.context ?? '').includes(marker)) return fact;
        return {
          ...fact,
          active: true,
          validUntil: undefined,
          context: removePendingMarker(fact.context, input.runId),
          forgotten: false,
          supersededBy: undefined,
        };
      }
      const baseContext = removePendingMarker(fact.context, input.runId)?.trim();
      if (!fact.active && (baseContext ?? '').includes(`forgotten: ${input.reason}`)
          && !(fact.context ?? '').includes(marker)) return fact;
      return {
        ...fact,
        active: false,
        validUntil: todayUtc(),
        context: baseContext ? `${baseContext} | forgotten: ${input.reason}` : `forgotten: ${input.reason}`,
        forgotten: true,
        supersededBy: undefined,
      };
    });
    const begin = body.indexOf('<!--- gbrain:facts:begin -->');
    const end = body.indexOf('<!--- gbrain:facts:end -->', begin + 1);
    if (begin < 0 || end < 0) throw new Error(`source-event: fact fence disappeared for ${input.factId}`);
    const rendered = renderFactsTable(updated);
    const next = body.slice(0, begin) + rendered + body.slice(end + '<!--- gbrain:facts:end -->'.length);
    writeFileSync(tmpPath, next, 'utf8');
    const validation = parseFactsFence(readFileSync(tmpPath, 'utf8'));
    if (validation.warnings.length > 0) {
      throw new Error(`source-event: prepared fact fence invalid for ${input.factId}: ${validation.warnings.join('; ')}`);
    }
    renameSync(tmpPath, filePath);
  }, { timeoutMs: 5_000 });
}
