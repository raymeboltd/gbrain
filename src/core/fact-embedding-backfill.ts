/** Source-scoped NULL-vector repair. The NULL cursor is the durable retry state;
 * existing embed jobs own progress and final receipts. Never rewrites facts. */
import type { BrainEngine } from './engine.ts';
import { embed, getEmbeddingModel, getEmbeddingDimensions, requireConfig, applyOpenAICompatConfig } from './ai/gateway.ts';
import { resolveRecipe } from './ai/model-resolver.ts';
import { tryAcquireDbLock } from './db-lock.ts';
import { embedBackfillLockId, EMBED_BACKFILL_LOCK_TTL_MIN } from './embed-backfill-lock.ts';

export interface FactEmbeddingResult {
  model: string;
  dimensions: number;
  source_id: string;
  status: 'complete' | 'partial' | 'planned';
  selected: number;
  embedded: number;
  conflicted: number;
  failed: number;
  /** Eligible NULL rows only; pending and logically expired facts are excluded. */
  remaining: number;
  errors: string[];
}
export interface FactEmbeddingOptions {
  sourceId: string;
  dryRun?: boolean;
  batchSize?: number;
  localOnly?: boolean;
  signal?: AbortSignal;
  onProgress?: (result: FactEmbeddingResult) => Promise<void>;
}
type Candidate = { id: string; fact: string; snapshot: string };
const ELIGIBLE = `source_id=$1 AND embedding IS NULL AND expired_at IS NULL
  AND COALESCE(context,'') NOT LIKE '%source-event-pending:%'`;

/** Uses the same resolved endpoint as the gateway, not a model-name heuristic. */
export function assertLocalFactEmbedding(model: string): void {
  const { recipe } = resolveRecipe(model);
  if (!['ollama', 'llama-server', 'lmstudio'].includes(recipe.id)) {
    throw new Error('Fact embedding --local-only requires a native local embedding provider');
  }
  const url = new URL(applyOpenAICompatConfig(recipe, requireConfig()).baseURL);
  if (!['http:', 'https:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password) {
    throw new Error('Fact embedding --local-only requires a loopback embedding endpoint');
  }
}

async function bindings(engine: BrainEngine, lock = false): Promise<string> {
  const rows = await engine.executeRaw<{ key: string; value: string }>(
    `SELECT key,value FROM config WHERE key IN ('embedding_model','embedding_dimensions','embedding_migration.state')
      ORDER BY key${lock ? ' FOR SHARE' : ''}`,
  );
  const model = rows.find(r => r.key === 'embedding_model')?.value;
  const dims = rows.find(r => r.key === 'embedding_dimensions')?.value;
  if (model !== getEmbeddingModel() || Number(dims) !== getEmbeddingDimensions()
      || rows.some(r => r.key === 'embedding_migration.state')) {
    throw new Error('Fact embedding requires matching persisted model/dimensions and no active migration');
  }
  return JSON.stringify(rows);
}

export async function runFactEmbeddingBackfill(engine: BrainEngine, opts: FactEmbeddingOptions): Promise<FactEmbeddingResult> {
  if (!opts.sourceId?.trim()) throw new Error('Fact embedding requires an explicit source');
  const sources = await engine.executeRaw(`SELECT id FROM sources WHERE id=$1 AND NOT archived`, [opts.sourceId]);
  if (sources.length !== 1) throw new Error('Fact embedding source does not exist');
  const model = getEmbeddingModel();
  const dimensions = getEmbeddingDimensions();
  if (opts.localOnly) assertLocalFactEmbedding(model);
  const initialBindings = await bindings(engine);
  const width = await engine.executeRaw<{ dims: number }>(
    `SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid='facts'::regclass
      AND attname='embedding' AND attnum>0 AND NOT attisdropped`,
  );
  if (Number(width[0]?.dims) !== dimensions) throw new Error('Fact embedding column dimensions do not match the current model');
  const count = async () => Number((await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts WHERE ${ELIGIBLE}`, [opts.sourceId],
  ))[0]?.n ?? 0);
  const result: FactEmbeddingResult = { model, dimensions, source_id: opts.sourceId,
    status: opts.dryRun ? 'planned' : 'complete', selected: 0, embedded: 0,
    conflicted: 0, failed: 0, remaining: await count(), errors: [] };
  if (opts.dryRun) return result;
  const batchSize = opts.batchSize ?? 32;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('Fact embedding batch size must be an integer between 1 and 100');
  }
  let cursor = '0';
  while (!opts.signal?.aborted) {
    const rows = await engine.executeRaw<Candidate>(
      `SELECT id::text AS id,fact,(to_jsonb(facts)-'embedding')::text AS snapshot FROM facts
        WHERE ${ELIGIBLE} AND facts.id>$2 ORDER BY facts.id LIMIT $3`, [opts.sourceId, cursor, batchSize],
    );
    if (!rows.length) break;
    cursor = rows.at(-1)!.id;
    result.selected += rows.length;
    let committed = 0;
    try {
      if (getEmbeddingModel() !== model || getEmbeddingDimensions() !== dimensions
          || await bindings(engine) !== initialBindings) throw new Error('Embedding model changed during backfill');
      if (opts.localOnly) assertLocalFactEmbedding(model);
      const vectors = await embed(rows.map(r => r.fact), { embeddingModel: model, dimensions, abortSignal: opts.signal });
      if (vectors.length !== rows.length) throw new Error('Embedding provider returned an incomplete batch');
      for (const v of vectors) {
        if (v.length !== dimensions || !Array.from(v).every(Number.isFinite)
            || !Array.from(v).some(x => x !== 0)) throw new Error('Embedding provider returned an invalid vector');
      }
      // Migration takes this same source lock. No provider call is held under it.
      const lock = await tryAcquireDbLock(engine, embedBackfillLockId(opts.sourceId), EMBED_BACKFILL_LOCK_TTL_MIN);
      if (!lock) throw new Error('Embedding source is busy; retry remaining NULL facts');
      try {
        const updated = await engine.transaction(async tx => {
          if (getEmbeddingModel() !== model || getEmbeddingDimensions() !== dimensions
              || await bindings(tx, true) !== initialBindings) throw new Error('Embedding model changed before commit');
          const source = await tx.executeRaw('SELECT id FROM sources WHERE id=$1 AND NOT archived FOR SHARE', [opts.sourceId]);
          if (source.length !== 1) throw new Error('Fact embedding source was archived or removed');
          if (opts.signal?.aborted) throw new Error('Fact embedding cancelled before commit');
          let changed = 0;
          for (let i = 0; i < rows.length; i++) {
            const matched = await tx.executeRaw(
              `UPDATE facts SET embedding=$3::vector WHERE id=$2 AND ${ELIGIBLE}
                AND (to_jsonb(facts)-'embedding')=$4::text::jsonb RETURNING id`,
              [opts.sourceId, rows[i].id, `[${Array.from(vectors[i]).join(',')}]`, rows[i].snapshot],
            );
            changed += matched.length;
          }
          return changed;
        });
        committed = updated;
        result.embedded += updated;
        result.conflicted += rows.length - updated;
      } finally { await lock.release(); }
    } catch (err) {
      result.failed += rows.length - committed;
      if (result.errors.length < 5) result.errors.push(err instanceof Error ? err.message : 'Fact embedding failed');
    }
    result.remaining = await count();
    result.status = result.remaining || result.failed || result.conflicted || result.errors.length ? 'partial' : 'complete';
    // A killed job can have lagging progress. Its committed vectors remain the
    // authoritative cursor; a retry recounts NULLs rather than trusting progress.
    await opts.onProgress?.({ ...result, errors: [...result.errors] });
  }
  result.remaining = await count();
  result.status = result.remaining || result.failed || result.conflicted || result.errors.length || opts.signal?.aborted ? 'partial' : 'complete';
  return result;
}
