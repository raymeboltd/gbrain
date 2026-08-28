import { createHash, randomUUID } from 'node:crypto';
import { buildGazetteer, findMentionedEntities, resolveLinkableEntityTypes, tokenizeForScan, tokenizeTitle } from '../by-mention.ts';
import type { BrainEngine } from '../engine.ts';
import { runFactsBackstop } from '../facts/backstop.ts';
import { forgetFactInFence } from '../facts/forget.ts';
import { stripCodeBlocks } from '../link-extraction.ts';
import {
  loadSourceEventArtifact,
  newSourceEventArtifact,
  persistSourceEventArtifact,
  type SourceEventRevisionRecord,
} from './artifact.ts';
import { assertSourceEventAdmission, readSourceEventPolicy } from './policy.ts';
import { prepareSourceEventFactFence } from './fact-commit.ts';

export interface SourceEventProjectionInput {
  sourceId: string;
  sourceKind: string;
  sourceKey: string;
  sourceUri: string;
  sourceSlug: string;
  contentHash: string;
  processorVersion: string;
  occurredAt: string;
  content: string;
}

export interface SourceEventProjectionReceipt {
  sourceId: string;
  eventId: string;
  revisionId: string;
  eventKey: string;
  artifactSlug: string;
  status: 'applied' | 'partial' | 'skipped' | 'review' | 'error';
  candidates: number;
  resolved: number;
  linksWritten: number;
  timelineWritten: number;
  factsWritten: number;
  skipped: number;
  errors: Array<{ code: string; detail?: string }>;
  replayed: boolean;
}

export interface SourceEventFactsOutcome {
  inserted: number;
  duplicate: number;
  superseded: number;
  factIds: number[];
  stage: 'applied' | 'disabled' | 'unavailable' | 'skipped';
  detail?: string;
}

export interface SourceEventProjectorDeps {
  runFacts?: (
    engine: BrainEngine,
    input: SourceEventProjectionInput,
    targetSlugs: string[],
    run: { runId: string; factSessionId: string },
  ) => Promise<SourceEventFactsOutcome>;
  persistArtifact?: typeof persistSourceEventArtifact;
  finalizeReceipt?: typeof finalizeReceipt;
  afterCanonicalArtifactWrite?: () => void | Promise<void>;
  afterFactDbSwap?: () => void | Promise<void>;
}

export const SOURCE_EVENT_PROCESSOR_VERSION = 'source-event-v3';
export const MAX_SOURCE_EVENT_CONTENT_BYTES = 256 * 1024;
export const MAX_SOURCE_EVENT_TARGETS = 25;

interface ReceiptRow {
  source_id: string;
  event_id: string;
  revision_id: string;
  event_key: string;
  artifact_slug: string;
  status: SourceEventProjectionReceipt['status'] | 'processing';
  candidates_count: number;
  resolved_count: number;
  links_written: number;
  timeline_written: number;
  facts_written: number;
  skipped_count: number;
  errors: Array<{ code: string; detail?: string }> | string;
  source_kind: string;
  source_key: string;
  source_uri: string;
  source_slug: string;
  projection_state: 'preparing' | 'pending' | 'committing' | 'committed' | 'aborted';
  run_id: string | null;
}

function required(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`source-event: ${field} is required`);
  return trimmed;
}

function digest(parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

/** Stable provider-event identity. Slug, URI, kind and processor are provenance. */
export function sourceEventId(input: Pick<SourceEventProjectionInput, 'sourceId' | 'sourceKey'>): string {
  return digest([required(input.sourceId, 'sourceId'), required(input.sourceKey, 'sourceKey')]);
}

/** Content or timestamp correction creates a new immutable revision. */
export function sourceEventRevisionId(
  eventId: string,
  input: Pick<SourceEventProjectionInput, 'contentHash' | 'occurredAt'>,
): string {
  return digest([eventId, required(input.contentHash, 'contentHash'), required(input.occurredAt, 'occurredAt')]);
}

/** One processor run over one immutable source revision. */
export function sourceEventKey(input: SourceEventProjectionInput): string {
  const eventId = sourceEventId(input);
  return digest([eventId, sourceEventRevisionId(eventId, input), required(input.processorVersion, 'processorVersion')]);
}

function rowToReceipt(row: ReceiptRow, replayed: boolean): SourceEventProjectionReceipt {
  const errors = typeof row.errors === 'string' ? JSON.parse(row.errors) : row.errors;
  return {
    sourceId: row.source_id,
    eventId: row.event_id,
    revisionId: row.revision_id,
    eventKey: row.event_key,
    artifactSlug: row.artifact_slug,
    status: row.status === 'processing' ? 'error' : row.status,
    candidates: row.candidates_count,
    resolved: row.resolved_count,
    linksWritten: row.links_written,
    timelineWritten: row.timeline_written,
    factsWritten: row.facts_written,
    skipped: row.skipped_count,
    errors,
    replayed,
  };
}

function containsTokenSequence(contentTokens: string[], aliasTokens: string[]): boolean {
  if (aliasTokens.length === 0 || aliasTokens.length > contentTokens.length) return false;
  for (let start = 0; start <= contentTokens.length - aliasTokens.length; start++) {
    if (aliasTokens.every((token, index) => contentTokens[start + index] === token)) return true;
  }
  return false;
}

async function findAmbiguousIdentity(
  engine: BrainEngine,
  sourceId: string,
  content: string,
): Promise<Array<{ code: string; detail: string }>> {
  const linkableTypes = await resolveLinkableEntityTypes(engine);
  if (linkableTypes.length === 0) return [{ code: 'schema_pack_linkability_unavailable', detail: sourceId }];
  const aliasRows = await engine.executeRaw<{ identity_norm: string }>(
    `SELECT pa.alias_norm AS identity_norm
       FROM page_aliases pa JOIN pages p ON p.slug=pa.slug AND p.source_id=pa.source_id
      WHERE pa.source_id=$1 AND p.deleted_at IS NULL AND p.type = ANY($2::text[])
      GROUP BY pa.alias_norm HAVING COUNT(DISTINCT pa.slug)>1 ORDER BY pa.alias_norm`,
    [sourceId, linkableTypes],
  );
  const titleRows = await engine.executeRaw<{ identity_norm: string }>(
    `SELECT lower(trim(p.title)) AS identity_norm FROM pages p
      WHERE p.source_id=$1 AND p.deleted_at IS NULL AND p.type = ANY($2::text[])
      GROUP BY lower(trim(p.title)) HAVING COUNT(DISTINCT p.slug)>1 ORDER BY lower(trim(p.title))`,
    [sourceId, linkableTypes],
  );
  const tokens = tokenizeForScan(stripCodeBlocks(content)).map((token) => token.text);
  return [
    ...aliasRows.map((row) => row.identity_norm)
      .filter((identity) => containsTokenSequence(tokens, tokenizeTitle(identity)))
      .map((detail) => ({ code: 'ambiguous_entity_alias', detail })),
    ...titleRows.map((row) => row.identity_norm)
      .filter((identity) => containsTokenSequence(tokens, tokenizeTitle(identity)))
      .map((detail) => ({ code: 'ambiguous_entity_title', detail })),
  ];
}

async function defaultFactsRunner(
  engine: BrainEngine,
  input: SourceEventProjectionInput,
  targetSlugs: string[],
  factSessionId: string,
  runId: string,
): Promise<SourceEventFactsOutcome> {
  const result = await runFactsBackstop(
    { slug: input.sourceSlug, type: input.sourceKind, compiled_truth: input.content, frontmatter: {} },
    {
      engine,
      sourceId: input.sourceId,
      sessionId: factSessionId,
      source: 'source-event',
      mode: 'inline',
      entityHints: targetSlugs,
      allowedEntitySlugs: targetSlugs,
      visibility: 'private',
      pendingRunId: runId,
      validFrom: new Date(input.occurredAt),
      sourceSlug: input.sourceSlug,
    },
  );
  if (result.mode !== 'inline') throw new Error('source-event: facts runner returned non-inline result');
  const skipped = result.skipped ?? result.skipped_reason;
  let stage: SourceEventFactsOutcome['stage'] = 'applied';
  if (skipped === 'extraction_disabled') stage = 'disabled';
  else if (skipped === 'extraction_unavailable' || skipped === 'chat_unavailable') stage = 'unavailable';
  else if (skipped) stage = 'skipped';
  return {
    inserted: result.inserted,
    duplicate: result.duplicate,
    superseded: result.superseded,
    factIds: result.fact_ids,
    stage,
    ...(skipped ? { detail: skipped } : {}),
  };
}

async function buildReviewCandidates(engine: BrainEngine, sourceId: string, factIds: number[]) {
  if (factIds.length === 0) return { actions: [] as Array<Record<string, unknown>>, projects: [] as Array<Record<string, unknown>> };
  const rows = await engine.executeRaw<{
    id: number; fact: string; kind: string; entity_slug: string | null;
    valid_from: Date | string | null; page_type: string | null;
  }>(
    `SELECT f.id,f.fact,f.kind,f.entity_slug,f.valid_from,p.type AS page_type
       FROM facts f LEFT JOIN pages p ON p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NULL
      WHERE f.source_id=$1 AND f.id=ANY($2::bigint[])`,
    [sourceId, factIds],
  );
  return {
    actions: rows.filter((row) => row.kind === 'commitment').map((row) => ({
      kind: 'task_candidate', review_required: true, fact_id: Number(row.id),
      entity_slug: row.entity_slug, text: row.fact, due: row.valid_from,
    })),
    projects: rows.filter((row) => ['project', 'deal', 'goal'].includes(row.page_type ?? '')).map((row) => ({
      kind: 'project_update_candidate', review_required: true, fact_id: Number(row.id),
      entity_slug: row.entity_slug, text: row.fact,
    })),
  };
}

async function assertCanonicalFactOutcome(
  engine: BrainEngine,
  sourceId: string,
  targetSlugs: string[],
  factIds: number[],
): Promise<void> {
  if (factIds.length === 0) return;
  const rows = await engine.executeRaw<{
    id: number; entity_slug: string | null; visibility: string; expired_at: Date | string | null;
    row_num: number | null; source_markdown_slug: string | null;
  }>(
    `SELECT id,entity_slug,visibility,row_num,source_markdown_slug,expired_at FROM facts
      WHERE source_id=$1 AND id=ANY($2::bigint[])`,
    [sourceId, factIds],
  );
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const allowed = new Set(targetSlugs);
  const violations: string[] = [];
  for (const factId of factIds) {
    const row = byId.get(factId);
    if (!row) {
      violations.push(`fact ${factId} missing or outside source scope`);
      continue;
    }
    if (!row.entity_slug || !allowed.has(row.entity_slug)) {
      violations.push(`fact ${factId} escaped the resolved-target allowlist`);
    }
    if (row.visibility !== 'private') {
      violations.push(`fact ${factId} is not private`);
    }
    if (row.row_num === null || row.source_markdown_slug === null) {
      violations.push(`fact ${factId} is not filesystem-canonical`);
    }
    if (row.expired_at === null) {
      violations.push(`fact ${factId} became visible before source-event commit`);
    }
  }
  if (violations.length === 0) return;
  for (const row of rows) {
    await forgetFactInFence(engine, Number(row.id), {
      sourceId,
      reason: 'source-event fact postcondition failed',
    });
  }
  throw new Error(`source-event: ${violations.join('; ')}`);
}

async function retractPriorFacts(
  engine: BrainEngine,
  sourceId: string,
  eventId: string,
  factIds: number[],
  reason = `source event ${eventId.slice(0, 12)} corrected`,
): Promise<void> {
  for (const factId of factIds) {
    await forgetFactInFence(engine, factId, {
      sourceId,
      reason,
    });
  }
  if (factIds.length === 0) return;
  const active = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND expired_at IS NULL`,
    [sourceId, factIds],
  );
  if (active.length > 0) {
    throw new Error(`source-event: ${active.length} prior fact(s) remained active after correction`);
  }
}

async function factsForSession(
  engine: BrainEngine,
  sourceId: string,
  sourceSession: string,
): Promise<number[]> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM facts WHERE source_id=$1 AND source_session=$2 ORDER BY id`,
    [sourceId, sourceSession],
  );
  return rows.map((row) => Number(row.id));
}

function factSwapSets(pendingFactIds: number[], priorFactIds: number[]) {
  const pending = [...new Set(pendingFactIds.map(Number))];
  const keep = new Set(pending);
  const prior = [...new Set(priorFactIds.map(Number).filter((id) => !keep.has(id)))];
  return { pending, prior };
}

async function prepareFactSwapFences(
  engine: BrainEngine,
  input: {
    sourceId: string;
    eventId: string;
    eventKey: string;
    runId: string;
    pendingFactIds: number[];
    priorFactIds: number[];
  },
): Promise<void> {
  const { pending, prior } = factSwapSets(input.pendingFactIds, input.priorFactIds);
  const reason = `source event ${input.eventId.slice(0, 12)} corrected`;
  for (const factId of pending) {
    await prepareSourceEventFactFence(engine, {
      sourceId: input.sourceId, factId, action: 'activate_pending', runId: input.runId, reason,
    });
  }
  for (const factId of prior) {
    await prepareSourceEventFactFence(engine, {
      sourceId: input.sourceId, factId, action: 'expire_prior', runId: input.runId, reason,
    });
  }
}

async function markFactSwapFencesPending(
  engine: BrainEngine,
  input: {
    sourceId: string;
    runId: string;
    pendingFactIds: number[];
    priorFactIds: number[];
  },
): Promise<void> {
  const { pending, prior } = factSwapSets(input.pendingFactIds, input.priorFactIds);
  for (const factId of [...pending, ...prior]) {
    await prepareSourceEventFactFence(engine, {
      sourceId: input.sourceId,
      factId,
      action: 'mark_pending',
      runId: input.runId,
      reason: 'source event fact commit pending',
    });
  }
}

async function clearFactSwapFenceMarkers(
  engine: BrainEngine,
  input: { sourceId: string; runId: string; factIds: number[] },
): Promise<string[]> {
  const errors: string[] = [];
  for (const factId of [...new Set(input.factIds.map(Number))]) {
    try {
      await prepareSourceEventFactFence(engine, {
        sourceId: input.sourceId,
        factId,
        action: 'clear_pending',
        runId: input.runId,
        reason: 'source event projection aborted',
      });
    } catch (error) {
      errors.push(`fact ${factId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

async function cleanupAbandonedPendingRevision(
  engine: BrainEngine,
  input: {
    sourceId: string;
    eventId: string;
    revision: SourceEventRevisionRecord;
    priorFactIds: number[];
  },
): Promise<void> {
  const abandonedRunId = input.revision.projection_run_id;
  if (!abandonedRunId) return;
  const sessionFactIds = await factsForSession(
    engine, input.sourceId, `source-event:${abandonedRunId}`,
  );
  const prior = new Set(input.priorFactIds.map(Number));
  const abandonedFactIds = [...new Set([
    ...input.revision.fact_ids.map(Number),
    ...sessionFactIds,
  ])].filter((factId) => !prior.has(factId));
  await retractPriorFacts(
    engine,
    input.sourceId,
    input.eventId,
    abandonedFactIds,
    'source event pending revision abandoned during recovery',
  );
  const markerErrors = await clearFactSwapFenceMarkers(engine, {
    sourceId: input.sourceId,
    runId: abandonedRunId,
    factIds: [...abandonedFactIds, ...input.priorFactIds],
  });
  if (markerErrors.length > 0) {
    throw new Error(`source-event: abandoned marker cleanup failed: ${markerErrors.join('; ')}`);
  }
}

async function commitFactSwapDb(
  engine: BrainEngine,
  input: {
    sourceId: string;
    eventKey: string;
    pendingFactIds: number[];
    priorFactIds: number[];
  },
): Promise<void> {
  const { pending, prior } = factSwapSets(input.pendingFactIds, input.priorFactIds);
  await engine.transaction(async (tx) => {
    if (pending.length > 0) {
      await tx.executeRaw(
        `UPDATE facts SET expired_at=NULL,valid_until=NULL
          WHERE source_id=$1 AND id=ANY($2::bigint[])`,
        [input.sourceId, pending],
      );
    }
    if (prior.length > 0) {
      await tx.executeRaw(
        `UPDATE facts SET expired_at=COALESCE(expired_at,now()),valid_until=COALESCE(valid_until,current_date)
          WHERE source_id=$1 AND id=ANY($2::bigint[])`,
        [input.sourceId, prior],
      );
    }
    await tx.executeRaw(
      `UPDATE source_event_receipts SET projection_state='committed',updated_at=now()
        WHERE source_id=$1 AND event_key=$2`,
      [input.sourceId, input.eventKey],
    );
  });
  const visible = await engine.executeRaw<{ id: number; expired_at: Date | string | null }>(
    `SELECT id,expired_at FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[])`,
    [input.sourceId, [...pending, ...prior]],
  );
  const byId = new Map(visible.map((row) => [Number(row.id), row.expired_at]));
  if (pending.some((id) => byId.get(id) !== null) || prior.some((id) => byId.get(id) === null)) {
    throw new Error('source-event: atomic fact swap postcondition failed');
  }
}

async function receiptByKey(engine: BrainEngine, sourceId: string, eventKey: string): Promise<ReceiptRow | null> {
  const rows = await engine.executeRaw<ReceiptRow>(
    `SELECT source_id,event_id,revision_id,event_key,artifact_slug,status,candidates_count,
            resolved_count,links_written,timeline_written,facts_written,skipped_count,errors,
            source_kind,source_key,source_uri,source_slug,projection_state,run_id
       FROM source_event_receipts WHERE source_id=$1 AND event_key=$2`,
    [sourceId, eventKey],
  );
  return rows[0] ?? null;
}

async function finalizeReceipt(
  engine: BrainEngine,
  sourceId: string,
  eventKey: string,
  values: {
    status: SourceEventProjectionReceipt['status'];
    targetResults: Array<Record<string, unknown>>;
    candidates: number; resolved: number; links: number; facts: number; skipped: number;
    errors: Array<{ code: string; detail?: string }>;
  },
): Promise<SourceEventProjectionReceipt> {
  const rows = await engine.executeRaw<ReceiptRow>(
    `UPDATE source_event_receipts SET status=$3,projection_state='committed',pending_revision_id=NULL,
       pending_fact_ids='[]'::jsonb,target_results=$4::text::jsonb,
       candidates_count=$5,resolved_count=$6,links_written=$7,timeline_written=0,
       facts_written=$8,skipped_count=$9,error_count=$10,errors=$11::text::jsonb,updated_at=now()
     WHERE source_id=$1 AND event_key=$2
     RETURNING source_id,event_id,revision_id,event_key,artifact_slug,status,candidates_count,
       resolved_count,links_written,timeline_written,facts_written,skipped_count,errors,
       source_kind,source_key,source_uri,source_slug,projection_state,run_id`,
    [sourceId,eventKey,values.status,JSON.stringify(values.targetResults),values.candidates,
     values.resolved,values.links,values.facts,values.skipped,values.errors.length,JSON.stringify(values.errors)],
  );
  if (!rows[0]) throw new Error('source-event: failed to finalize receipt');
  return rowToReceipt(rows[0], false);
}

export async function projectSourceEvent(
  engine: BrainEngine,
  raw: SourceEventProjectionInput,
  deps: SourceEventProjectorDeps = {},
): Promise<SourceEventProjectionReceipt> {
  const sourceId = required(raw.sourceId, 'sourceId');
  const sourceKind = required(raw.sourceKind, 'sourceKind');
  const sourceKey = required(raw.sourceKey, 'sourceKey');
  if (sourceKey.startsWith('page:')) throw new Error('source-event: immutable provider sourceKey is required; page-slug fallback is not accepted');
  const sourceUri = required(raw.sourceUri, 'sourceUri');
  const sourceSlug = required(raw.sourceSlug, 'sourceSlug');
  const contentHash = required(raw.contentHash, 'contentHash');
  const processorVersion = required(raw.processorVersion, 'processorVersion');
  const content = raw.content.trim();
  const observedAt = new Date(raw.occurredAt);
  if (Number.isNaN(observedAt.getTime())) throw new Error('source-event: occurredAt must be an ISO timestamp');
  const occurredAt = observedAt.toISOString();
  const normalized = { ...raw, sourceId, sourceKind, sourceKey, sourceUri, sourceSlug, contentHash, processorVersion, occurredAt };
  const eventId = sourceEventId(normalized);
  const revisionId = sourceEventRevisionId(eventId, normalized);
  const eventKey = sourceEventKey(normalized);
  const artifactSlug = `source-events/${eventId}`;

  const source = (await engine.listAllSources({ includeArchived: false })).find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error(`source-event: sourceId '${sourceId}' is not a registered source`);
  assertSourceEventAdmission(await readSourceEventPolicy(engine), source);
  if (contentHash !== createHash('md5').update(raw.content).digest('hex')) {
    throw new Error('source-event: contentHash does not match scanned content');
  }
  const sourcePage = await engine.getPage(sourceSlug, { sourceId });
  if (!sourcePage) {
    throw new Error(`source-event: source page '${sourceSlug}' does not exist in source '${sourceId}'`);
  }
  const currentSourceText = `${sourcePage.compiled_truth}${sourcePage.timeline ? `\n${sourcePage.timeline}` : ''}`.trim();
  if (content !== currentSourceText) {
    throw new Error('source-event: scanned content does not match the current source page');
  }

  const existing = await receiptByKey(engine, sourceId, eventKey);
  const sameProvenance = existing && existing.source_kind === sourceKind && existing.source_key === sourceKey
    && existing.source_uri === sourceUri && existing.source_slug === sourceSlug;
  const wasRetracted = existing && (typeof existing.errors === 'string'
    ? existing.errors.includes('source_retracted')
    : existing.errors.some((error) => error.code === 'source_retracted'));
  if (existing && sameProvenance && !wasRetracted && existing.projection_state === 'committed'
      && ['applied', 'partial', 'skipped'].includes(existing.status)) {
    return rowToReceipt(existing, true);
  }
  const runId = existing?.run_id ?? randomUUID();
  const factSessionId = `source-event:${runId}`;
  const persistProjectionArtifact = (artifact: Parameters<typeof persistSourceEventArtifact>[1]['artifact']) =>
    (deps.persistArtifact ?? persistSourceEventArtifact)(engine, {
      sourceId, artifactSlug, artifact, afterCanonicalWrite: deps.afterCanonicalArtifactWrite,
    });
  if (!existing) {
    const claimed = await engine.executeRaw<{ id: number }>(
      `INSERT INTO source_event_receipts
        (source_id,event_id,revision_id,event_key,artifact_slug,source_kind,source_key,source_uri,
         source_slug,content_hash,processor_version,observed_at,event_date,status,projection_state,run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'processing','preparing',$14)
       ON CONFLICT (source_id,event_key) DO NOTHING RETURNING id`,
      [sourceId,eventId,revisionId,eventKey,artifactSlug,sourceKind,sourceKey,sourceUri,sourceSlug,
       contentHash,processorVersion,occurredAt,occurredAt.slice(0, 10),runId],
    );
    if (!claimed[0]) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const raced = await receiptByKey(engine, sourceId, eventKey);
        if (raced && raced.status !== 'processing') {
          if (raced.status === 'error') throw new Error('source-event: concurrent projection failed');
          return rowToReceipt(raced, true);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('source-event: concurrent projection did not reach a terminal receipt');
    }
  } else {
    await engine.executeRaw(
      `UPDATE source_event_receipts SET status='processing',source_kind=$3,source_key=$4,
       source_uri=$5,source_slug=$6,run_id=COALESCE(run_id,$7),attempts=attempts+1,updated_at=now()
       WHERE source_id=$1 AND event_key=$2`,
      [sourceId,eventKey,sourceKind,sourceKey,sourceUri,sourceSlug,runId],
    );
  }

  let artifactCommitted = false;
  let factDbCommitted = false;
  let precommitFactIds: number[] = [];
  let protectedFactIds = new Set<number>();
  try {
    if (!content) return finalizeReceipt(engine, sourceId, eventKey, {
      status: 'skipped', targetResults: [], candidates: 0, resolved: 0, links: 0, facts: 0,
      skipped: 1, errors: [{ code: 'empty_content' }],
    });
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SOURCE_EVENT_CONTENT_BYTES) return finalizeReceipt(engine, sourceId, eventKey, {
      status: 'review', targetResults: [], candidates: 0, resolved: 0, links: 0, facts: 0,
      skipped: 1, errors: [{ code: 'content_too_large', detail: String(bytes) }],
    });
    const ambiguity = await findAmbiguousIdentity(engine, sourceId, content);
    if (ambiguity.length > 0) return finalizeReceipt(engine, sourceId, eventKey, {
      status: 'review', targetResults: [], candidates: ambiguity.length, resolved: 0, links: 0, facts: 0,
      skipped: ambiguity.length, errors: ambiguity,
    });

    const mentions = findMentionedEntities(content, await buildGazetteer(engine), {
      fromSlug: sourceSlug,
      fromSourceId: sourceId,
    });
    if (mentions.length > MAX_SOURCE_EVENT_TARGETS) return finalizeReceipt(engine, sourceId, eventKey, {
      status: 'review', targetResults: [], candidates: mentions.length, resolved: 0, links: 0, facts: 0,
      skipped: mentions.length, errors: [{ code: 'too_many_entity_mentions', detail: String(mentions.length) }],
    });
    const targets = mentions.map((mention) => mention.slug);
    let artifact = await loadSourceEventArtifact(engine, sourceId, artifactSlug, { includeUncommitted: true });
    if (artifact && artifact.event_id !== eventId) throw new Error(`source-event: artifact identity mismatch for '${artifactSlug}'`);
    artifact ??= newSourceEventArtifact({ eventId, sourceId, sourceKind, sourceKey, sourceUri, sourceSlug });
    artifact.source = { source_id: sourceId, kind: sourceKind, key: sourceKey, uri: sourceUri, slug: sourceSlug };
    const priorActive = artifact.revisions.find((revision) => revision.state === 'active');
    protectedFactIds = new Set(priorActive?.fact_ids ?? []);
    const processorOnlyUpgrade = priorActive?.revision_id === revisionId;
    const exactCommittedRevision = processorOnlyUpgrade && priorActive?.processor_version === processorVersion;

    if (exactCommittedRevision) {
      // Receipt loss or a crash after the artifact commit resumes here. Never
      // append the same immutable revision twice; finish any stale-fact cleanup
      // and reconcile the artifact-derived links before closing the receipt.
      const priorFactIds = artifact.revisions
        .filter((candidate) => candidate.state === 'superseded')
        .flatMap((candidate) => candidate.fact_ids);
      const fenceRunId = priorActive?.projection_run_id ?? runId;
      await markFactSwapFencesPending(engine, {
        sourceId, runId: fenceRunId, pendingFactIds: priorActive?.fact_ids ?? [], priorFactIds,
      });
      const persisted = await persistProjectionArtifact(artifact);
      artifactCommitted = true;
      await commitFactSwapDb(engine, {
        sourceId, eventKey, pendingFactIds: priorActive?.fact_ids ?? [], priorFactIds,
      });
      factDbCommitted = true;
      await deps.afterFactDbSwap?.();
      await prepareFactSwapFences(engine, {
        sourceId, eventId, eventKey, runId: fenceRunId,
        pendingFactIds: priorActive?.fact_ids ?? [], priorFactIds,
      });
      const factsStage = priorActive?.facts_stage ?? 'skipped';
      const errors: Array<{ code: string; detail?: string }> = [];
      if ((priorActive?.targets.length ?? 0) === 0) errors.push({ code: 'no_known_entity_mentions' });
      if (factsStage !== 'applied' && (priorActive?.targets.length ?? 0) > 0) errors.push({ code: `facts_${factsStage}` });
      const targetResults = (priorActive?.targets ?? []).map((slug) => ({
        slug,
        relationship: 'canonical_private_artifact',
        facts: (priorActive?.fact_ids.length ?? 0) > 0 ? 'applied' : factsStage,
        project_candidate: priorActive?.project_candidates.some((candidate) => candidate.entity_slug === slug) ? 'review' : 'none',
      }));
      return (deps.finalizeReceipt ?? finalizeReceipt)(engine, sourceId, eventKey, {
        status: (priorActive?.targets.length ?? 0) === 0 ? 'skipped' : factsStage === 'applied' ? 'applied' : 'partial',
        targetResults, candidates: priorActive?.targets.length ?? 0, resolved: priorActive?.targets.length ?? 0,
        links: persisted.linksWritten, facts: 0, skipped: (priorActive?.targets.length ?? 0) === 0 ? 1 : 0, errors,
      });
    }

    if (processorOnlyUpgrade && priorActive) {
      // A processor upgrade re-evaluates relationships but does not create a
      // second record with the same immutable source revision id.
      priorActive.processor_version = processorVersion;
      priorActive.targets = targets;
      priorActive.changed_at = new Date().toISOString();
      artifact.state = 'active';
      artifact.active_revision_id = revisionId;
      artifact.pending_revision_id = null;
      const persisted = await persistProjectionArtifact(artifact);
      artifactCommitted = true;
      const errors: Array<{ code: string; detail?: string }> = [];
      if (targets.length === 0) errors.push({ code: 'no_known_entity_mentions' });
      if (priorActive.facts_stage !== 'applied' && targets.length > 0) errors.push({ code: `facts_${priorActive.facts_stage}` });
      return (deps.finalizeReceipt ?? finalizeReceipt)(engine, sourceId, eventKey, {
        status: targets.length === 0 ? 'skipped' : priorActive.facts_stage === 'applied' ? 'applied' : 'partial',
        targetResults: targets.map((slug) => ({
          slug, relationship: 'canonical_private_artifact',
          facts: priorActive.fact_ids.length > 0 ? 'applied' : priorActive.facts_stage,
          project_candidate: priorActive.project_candidates.some((candidate) => candidate.entity_slug === slug) ? 'review' : 'none',
        })),
        candidates: mentions.length, resolved: mentions.length, links: persisted.linksWritten,
        facts: 0, skipped: targets.length === 0 ? 1 : 0, errors,
      });
    }

    let revision = artifact.revisions.find((candidate) => candidate.revision_id === revisionId);
    const appendRevision = !revision;
    if (revision?.state === 'pending') {
      await cleanupAbandonedPendingRevision(engine, {
        sourceId,
        eventId,
        revision,
        priorFactIds: priorActive?.fact_ids ?? [],
      });
    }
    revision ??= {
      revision_id: revisionId,
      projection_run_id: runId,
      processor_version: processorVersion,
      content_hash: contentHash,
      occurred_at: occurredAt,
      state: 'pending',
      targets,
      fact_ids: [],
      facts_stage: 'skipped',
      action_candidates: [],
      project_candidates: [],
      changed_at: new Date().toISOString(),
    };
    if (!appendRevision) {
      // Restoring a deleted source page reuses its immutable source revision
      // instead of appending a duplicate id to the audit artifact.
      revision.processor_version = processorVersion;
      revision.projection_run_id = runId;
      revision.content_hash = contentHash;
      revision.occurred_at = occurredAt;
      revision.state = 'pending';
      revision.targets = targets;
      revision.fact_ids = [];
      revision.facts_stage = 'skipped';
      revision.action_candidates = [];
      revision.project_candidates = [];
      revision.changed_at = new Date().toISOString();
      delete revision.reason;
    }
    if (appendRevision) artifact.revisions.push(revision);
    artifact.state = 'active';
    artifact.pending_revision_id = revisionId;
    await persistProjectionArtifact(artifact);
    await engine.executeRaw(
      `UPDATE source_event_receipts SET projection_state='pending',prior_revision_id=$3,
       pending_revision_id=$4,pending_fact_ids='[]'::jsonb,artifact_hash=$5,updated_at=now()
       WHERE source_id=$1 AND event_key=$2`,
      [sourceId,eventKey,priorActive?.revision_id ?? null,revisionId,digest([JSON.stringify(artifact)])],
    );

    let facts: SourceEventFactsOutcome = {
      inserted: 0, duplicate: 0, superseded: 0, factIds: revision.fact_ids,
      stage: revision.facts_stage === 'applied' ? 'applied' : 'skipped',
    };
    if (targets.length > 0) {
      facts = deps.runFacts
        ? await deps.runFacts(engine, normalized, targets, { runId, factSessionId })
        : await defaultFactsRunner(engine, normalized, targets, factSessionId, runId);
      revision.fact_ids = [...new Set(facts.factIds.map(Number))];
      precommitFactIds = revision.fact_ids.filter((factId) => !protectedFactIds.has(factId));
      await assertCanonicalFactOutcome(engine, sourceId, targets, revision.fact_ids);
      revision.facts_stage = facts.stage;
      const candidates = await buildReviewCandidates(engine, sourceId, revision.fact_ids);
      revision.action_candidates = candidates.actions;
      revision.project_candidates = candidates.projects;
    }
    await persistProjectionArtifact(artifact);
    await engine.executeRaw(
      `UPDATE source_event_receipts SET pending_fact_ids=$3::text::jsonb,artifact_hash=$4,updated_at=now()
       WHERE source_id=$1 AND event_key=$2`,
      [sourceId,eventKey,JSON.stringify(revision.fact_ids),digest([JSON.stringify(artifact)])],
    );

    const priorFactIds = priorActive?.fact_ids ?? [];
    await markFactSwapFencesPending(engine, {
      sourceId, runId, pendingFactIds: revision.fact_ids, priorFactIds,
    });
    for (const old of artifact.revisions) {
      if (old !== revision && old.state === 'active') {
        old.state = 'superseded';
        old.reason = 'source_correction';
      }
    }
    revision.state = 'active';
    artifact.state = 'active';
    artifact.active_revision_id = revisionId;
    artifact.pending_revision_id = null;
    const persisted = await persistProjectionArtifact(artifact);
    artifactCommitted = true;
    await engine.executeRaw(
      `UPDATE source_event_receipts SET projection_state='committing',artifact_hash=$3,updated_at=now()
       WHERE source_id=$1 AND event_key=$2`,
      [sourceId,eventKey,digest([JSON.stringify(artifact)])],
    );
    await commitFactSwapDb(engine, {
      sourceId, eventKey, pendingFactIds: revision.fact_ids, priorFactIds,
    });
    factDbCommitted = true;
    await deps.afterFactDbSwap?.();
    await prepareFactSwapFences(engine, {
      sourceId, eventId, eventKey, runId, pendingFactIds: revision.fact_ids, priorFactIds,
    });
    const errors: Array<{ code: string; detail?: string }> = [];
    if (targets.length === 0) errors.push({ code: 'no_known_entity_mentions' });
    if (facts.stage !== 'applied' && targets.length > 0) {
      errors.push({ code: `facts_${facts.stage}`, ...(facts.detail ? { detail: facts.detail } : {}) });
    }
    const targetResults = targets.map((slug) => ({
      slug,
      relationship: 'canonical_private_artifact',
      facts: revision.fact_ids.length > 0 ? 'applied' : revision.facts_stage,
      project_candidate: revision.project_candidates.some((candidate) => candidate.entity_slug === slug) ? 'review' : 'none',
    }));
    return (deps.finalizeReceipt ?? finalizeReceipt)(engine, sourceId, eventKey, {
      status: targets.length === 0 ? 'skipped' : facts.stage === 'applied' ? 'applied' : 'partial',
      targetResults,
      candidates: mentions.length,
      resolved: mentions.length,
      links: persisted.linksWritten,
      facts: facts.inserted,
      skipped: targets.length === 0 ? 1 : 0,
      errors,
    });
  } catch (error) {
    let detail = error instanceof Error ? error.message : String(error);
    const onDisk = await loadSourceEventArtifact(
      engine, sourceId, artifactSlug, { includeUncommitted: true },
    ).catch(() => null);
    if (!artifactCommitted) {
      // write-through commits the canonical file before derived-link
      // reconciliation. Detect that durable roll-forward point explicitly.
      artifactCommitted = onDisk?.active_revision_id === revisionId
        && onDisk.revisions.some((revision) =>
          revision.revision_id === revisionId
          && revision.processor_version === processorVersion
          && revision.state === 'active',
        );
    }
    if (!artifactCommitted) {
      try {
        const sessionFactIds = await factsForSession(engine, sourceId, factSessionId);
        const cleanupIds = [...new Set([...precommitFactIds, ...sessionFactIds])]
          .filter((factId) => !protectedFactIds.has(factId));
        await retractPriorFacts(engine, sourceId, eventId, cleanupIds, 'source event projection aborted before pending facts were hidden');
        const markerErrors = await clearFactSwapFenceMarkers(engine, {
          sourceId,
          runId,
          factIds: [...cleanupIds, ...protectedFactIds],
        });
        if (markerErrors.length > 0) detail += `; marker cleanup failed: ${markerErrors.join('; ')}`;
      } catch (cleanupError) {
        detail += `; rollback failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
      }
    }
    await engine.executeRaw(
      `UPDATE source_event_receipts SET status='error',projection_state=$3,error_count=1,errors=$4::text::jsonb,
       updated_at=now() WHERE source_id=$1 AND event_key=$2`,
      [sourceId,eventKey,factDbCommitted ? 'committed' : artifactCommitted ? 'committing' : onDisk?.pending_revision_id === revisionId ? 'pending' : 'aborted',
       JSON.stringify([{ code: 'projection_failed', detail }])],
    ).catch(() => {});
    throw error;
  }
}

export async function retractSourceEvent(
  engine: BrainEngine,
  input: { sourceId: string; eventId: string; artifactSlug: string; reason: string },
): Promise<void> {
  // Retraction is a recovery mutation, not an ordinary read. It must still
  // work when the DB-only receipt was lost or projection crashed mid-commit.
  const artifact = await loadSourceEventArtifact(
    engine, input.sourceId, input.artifactSlug, { includeUncommitted: true },
  );
  if (!artifact || artifact.event_id !== input.eventId) return;
  const retractable = artifact.revisions.filter(
    (revision) => revision.state === 'active' || revision.state === 'pending',
  );
  const markerRunIds = [...new Set(artifact.revisions
    .map((revision) => revision.projection_run_id)
    .filter((runId): runId is string => Boolean(runId)))];
  const sessionFactIds: number[] = [];
  for (const runId of markerRunIds) {
    sessionFactIds.push(...await factsForSession(
      engine, input.sourceId, `source-event:${runId}`,
    ));
  }
  const retractableFactIds = [...new Set([
    ...retractable.flatMap((revision) => revision.fact_ids),
    ...sessionFactIds,
  ])];
  await retractPriorFacts(
    engine, input.sourceId, input.eventId, retractableFactIds, input.reason,
  );
  const allFactIds = [...new Set([
    ...artifact.revisions.flatMap((revision) => revision.fact_ids),
    ...sessionFactIds,
  ])];
  const markerErrors: string[] = [];
  for (const runId of markerRunIds) {
    markerErrors.push(...await clearFactSwapFenceMarkers(engine, {
      sourceId: input.sourceId, runId, factIds: allFactIds,
    }));
  }
  if (markerErrors.length > 0) {
    throw new Error(`source-event: retraction marker cleanup failed: ${markerErrors.join('; ')}`);
  }
  for (const revision of retractable) {
    revision.state = 'retracted';
    revision.reason = input.reason;
    revision.changed_at = new Date().toISOString();
  }
  artifact.state = 'retracted';
  artifact.active_revision_id = null;
  artifact.pending_revision_id = null;
  await persistSourceEventArtifact(engine, { sourceId: input.sourceId, artifactSlug: input.artifactSlug, artifact });
  await engine.executeRaw(
    `UPDATE source_event_receipts SET status='skipped',errors=$3::text::jsonb,error_count=0,
     updated_at=now() WHERE source_id=$1 AND event_id=$2`,
    [input.sourceId,input.eventId,JSON.stringify([{ code: 'source_retracted', detail: input.reason }])],
  );
}
