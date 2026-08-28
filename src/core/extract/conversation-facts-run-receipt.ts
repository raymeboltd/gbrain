import type { BrainEngine } from '../engine.ts';
import { writeReceipt } from './receipt-writer.ts';
import { classifyRunStop, upsertExtractRollup } from './rollup-writer.ts';

export interface ConversationFactsRunResult {
  pages_considered: number;
  pages_processed: number;
  pages_failed: number;
  facts_inserted: number;
  spent_usd?: number;
}

/** Persist the best-effort receipt and operational rollup for one extraction run. */
export async function writeConversationFactsRunReceipt(
  engine: BrainEngine,
  sourceId: string,
  result: ConversationFactsRunResult,
  halted: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  const runId = `ecf-${Date.now().toString(36)}-${sourceId.slice(0, 4)}`;

  if (result.facts_inserted > 0) {
    try {
      await writeReceipt(engine, {
        kind: 'facts.conversation',
        source_id: sourceId,
        run_id: runId,
        round: 'full',
        extracted_at: now,
        total_rows: result.facts_inserted,
        cost_usd: result.spent_usd ?? 0,
        summary:
          `Extracted ${result.facts_inserted} facts from ` +
          `${result.pages_processed}/${result.pages_considered} eligible pages` +
          (result.pages_failed > 0
            ? `; ${result.pages_failed} page(s) failed and remain unfinished.`
            : '.'),
      });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      console.error(`[extract-conversation-facts] receipt write failed: ${msg}`);
    }
  }

  await upsertExtractRollup(engine, {
    kind: 'facts.conversation',
    source_id: sourceId,
    cost_delta: result.spent_usd ?? 0,
    ...classifyRunStop({
      budget_exhausted: halted,
      error: result.pages_failed > 0,
    }),
  });
}
