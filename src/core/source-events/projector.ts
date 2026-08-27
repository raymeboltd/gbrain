import { createHash } from 'node:crypto';
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
  ) => Promise<SourceEventFactsOutcome>;
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
): Promise<SourceEventFactsOutcome> {
  const result = await runFactsBackstop(
    { slug: input.sourceSlug, type: input.sourceKind, compiled_truth: input.content, frontmatter: {} },
    {
      engine,
      sourceId: input.sourceId,
      sessionId: input.sourceKey,
      source: 'source-event',
      mode: 'inline',
      entityHints: targetSlugs,
      allowedEntitySlugs: targetSlugs,
      visibility: 'private',
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
    id: number; entity_slug: string | null; visibility: string;
    row_num: number | null; source_markdown_slug: string | null;
  }>(
    `SELECT id,entity_slug,visibility,row_num,source_markdown_slug FROM facts
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

async function receiptByKey(engine: BrainEngine, sourceId: string, eventKey: string): Promise<ReceiptRow | null> {
  const rows = await engine.executeRaw<ReceiptRow>(
    `SELECT source_id,event_id,revision_id,event_key,artifact_slug,status,candidates_count,
            resolved_count,links_written,timeline_written,facts_written,skipped_count,errors,
            source_kind,source_key,source_uri,source_slug
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
    `UPDATE source_event_receipts SET status=$3,target_results=$4::text::jsonb,
       candidates_count=$5,resolved_count=$6,links_written=$7,timeline_written=0,
       facts_written=$8,skipped_count=$9,error_count=$10,errors=$11::text::jsonb,updated_at=now()
     WHERE source_id=$1 AND event_key=$2
     RETURNING source_id,event_id,revision_id,event_key,artifact_slug,status,candidates_count,
       resolved_count,links_written,timeline_written,facts_written,skipped_count,errors,
       source_kind,source_key,source_uri,source_slug`,
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
  if (existing && sameProvenance && !wasRetracted && ['applied', 'partial', 'skipped'].includes(existing.status)) {
    return rowToReceipt(existing, true);
  }
  if (!existing) {
    const claimed = await engine.executeRaw<{ id: number }>(
      `INSERT INTO source_event_receipts
        (source_id,event_id,revision_id,event_key,artifact_slug,source_kind,source_key,source_uri,
         source_slug,content_hash,processor_version,observed_at,event_date,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'processing')
       ON CONFLICT (source_id,event_key) DO NOTHING RETURNING id`,
      [sourceId,eventId,revisionId,eventKey,artifactSlug,sourceKind,sourceKey,sourceUri,sourceSlug,
       contentHash,processorVersion,occurredAt,occurredAt.slice(0, 10)],
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
       source_uri=$5,source_slug=$6,attempts=attempts+1,updated_at=now()
       WHERE source_id=$1 AND event_key=$2`,
      [sourceId,eventKey,sourceKind,sourceKey,sourceUri,sourceSlug],
    );
  }

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
    let artifact = await loadSourceEventArtifact(engine, sourceId, artifactSlug);
    if (artifact && artifact.event_id !== eventId) throw new Error(`source-event: artifact identity mismatch for '${artifactSlug}'`);
    artifact ??= newSourceEventArtifact({ eventId, sourceId, sourceKind, sourceKey, sourceUri, sourceSlug });
    artifact.source = { source_id: sourceId, kind: sourceKind, key: sourceKey, uri: sourceUri, slug: sourceSlug };
    const priorActive = artifact.revisions.find((revision) => revision.state === 'active');
    const processorOnlyUpgrade = priorActive?.revision_id === revisionId;
    for (const old of artifact.revisions) {
      if (old.state === 'active') {
        old.state = 'superseded';
        old.reason = processorOnlyUpgrade ? 'processor_upgrade' : 'source_correction';
      }
    }
    const revision: SourceEventRevisionRecord = {
      revision_id: revisionId,
      processor_version: processorVersion,
      content_hash: contentHash,
      occurred_at: occurredAt,
      state: 'active',
      targets,
      fact_ids: processorOnlyUpgrade ? [...(priorActive?.fact_ids ?? [])] : [],
      facts_stage: processorOnlyUpgrade ? (priorActive?.facts_stage ?? 'skipped') : 'skipped',
      action_candidates: processorOnlyUpgrade ? [...(priorActive?.action_candidates ?? [])] : [],
      project_candidates: processorOnlyUpgrade ? [...(priorActive?.project_candidates ?? [])] : [],
      changed_at: new Date().toISOString(),
    };
    artifact.revisions.push(revision);
    artifact.state = 'active';
    artifact.active_revision_id = revisionId;
    await persistSourceEventArtifact(engine, { sourceId, artifactSlug, artifact });

    if (!processorOnlyUpgrade && priorActive) {
      await retractPriorFacts(engine, sourceId, eventId, priorActive.fact_ids);
    }
    let facts: SourceEventFactsOutcome = {
      inserted: 0, duplicate: 0, superseded: 0, factIds: revision.fact_ids,
      stage: revision.facts_stage === 'applied' ? 'applied' : 'skipped',
    };
    if (!processorOnlyUpgrade && targets.length > 0) {
      facts = await (deps.runFacts ?? defaultFactsRunner)(engine, normalized, targets);
      revision.fact_ids = [...new Set(facts.factIds.map(Number))];
      await assertCanonicalFactOutcome(engine, sourceId, targets, revision.fact_ids);
      revision.facts_stage = facts.stage;
      const candidates = await buildReviewCandidates(engine, sourceId, revision.fact_ids);
      revision.action_candidates = candidates.actions;
      revision.project_candidates = candidates.projects;
    }
    const persisted = await persistSourceEventArtifact(engine, { sourceId, artifactSlug, artifact });
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
    return finalizeReceipt(engine, sourceId, eventKey, {
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
    const detail = error instanceof Error ? error.message : String(error);
    await engine.executeRaw(
      `UPDATE source_event_receipts SET status='error',error_count=1,errors=$3::text::jsonb,
       updated_at=now() WHERE source_id=$1 AND event_key=$2`,
      [sourceId,eventKey,JSON.stringify([{ code: 'projection_failed', detail }])],
    ).catch(() => {});
    throw error;
  }
}

export async function retractSourceEvent(
  engine: BrainEngine,
  input: { sourceId: string; eventId: string; artifactSlug: string; reason: string },
): Promise<void> {
  const artifact = await loadSourceEventArtifact(engine, input.sourceId, input.artifactSlug);
  if (!artifact || artifact.event_id !== input.eventId) return;
  const active = artifact.revisions.find((revision) => revision.state === 'active');
  if (active) {
    await retractPriorFacts(engine, input.sourceId, input.eventId, active.fact_ids, input.reason);
    active.state = 'retracted';
    active.reason = input.reason;
    active.changed_at = new Date().toISOString();
  }
  artifact.state = 'retracted';
  artifact.active_revision_id = null;
  await persistSourceEventArtifact(engine, { sourceId: input.sourceId, artifactSlug: input.artifactSlug, artifact });
  await engine.executeRaw(
    `UPDATE source_event_receipts SET status='skipped',errors=$3::text::jsonb,error_count=0,
     updated_at=now() WHERE source_id=$1 AND event_id=$2`,
    [input.sourceId,input.eventId,JSON.stringify([{ code: 'source_retracted', detail: input.reason }])],
  );
}
