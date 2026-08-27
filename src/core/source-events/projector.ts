import { createHash } from 'node:crypto';
import {
  LINKABLE_ENTITY_TYPES,
  buildGazetteer,
  findMentionedEntities,
  tokenizeForScan,
  tokenizeTitle,
} from '../by-mention.ts';
import type { BrainEngine } from '../engine.ts';
import { stripCodeBlocks } from '../link-extraction.ts';
import { writeTimelineEntryThrough } from '../timeline-write-through.ts';
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
  eventKey: string;
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

// v2 changes event identity and replaces derived-only projection with
// filesystem-canonical timeline write-through. The feature remained unarmed
// during v1, so there is no production v1 receipt migration path.
export const SOURCE_EVENT_PROCESSOR_VERSION = 'source-event-v2';
export const MAX_SOURCE_EVENT_CONTENT_BYTES = 256 * 1024;
export const MAX_SOURCE_EVENT_TARGETS = 25;

interface ReceiptRow {
  source_id: string;
  event_key: string;
  status: SourceEventProjectionReceipt['status'];
  candidates_count: number;
  resolved_count: number;
  links_written: number;
  timeline_written: number;
  facts_written: number;
  skipped_count: number;
  errors: Array<{ code: string; detail?: string }> | string;
}

function required(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`source-event: ${field} is required`);
  return trimmed;
}

export function sourceEventKey(input: SourceEventProjectionInput): string {
  return createHash('sha256')
    .update(required(input.sourceId, 'sourceId'))
    .update('\0')
    .update(required(input.sourceKind, 'sourceKind'))
    .update('\0')
    .update(required(input.sourceKey, 'sourceKey'))
    .update('\0')
    .update(required(input.sourceUri, 'sourceUri'))
    .update('\0')
    .update(required(input.sourceSlug, 'sourceSlug'))
    .update('\0')
    .update(required(input.contentHash, 'contentHash'))
    .update('\0')
    .update(required(input.processorVersion, 'processorVersion'))
    .digest('hex');
}

function rowToReceipt(row: ReceiptRow, replayed: boolean): SourceEventProjectionReceipt {
  const errors = typeof row.errors === 'string' ? JSON.parse(row.errors) : row.errors;
  return {
    sourceId: row.source_id,
    eventKey: row.event_key,
    status: row.status,
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

function evidenceSummary(kind: string, target: string): string {
  return `${kind} evidence mentions ${target}.`;
}

function containsTokenSequence(contentTokens: string[], aliasTokens: string[]): boolean {
  if (aliasTokens.length === 0 || aliasTokens.length > contentTokens.length) return false;
  for (let start = 0; start <= contentTokens.length - aliasTokens.length; start++) {
    let matches = true;
    for (let index = 0; index < aliasTokens.length; index++) {
      if (contentTokens[start + index] !== aliasTokens[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

async function findAmbiguousIdentity(
  engine: BrainEngine,
  sourceId: string,
  content: string,
): Promise<Array<{ code: string; detail: string }>> {
  const typeList = LINKABLE_ENTITY_TYPES.map((type) => `'${type}'`).join(', ');
  const aliasRows = await engine.executeRaw<{ identity_norm: string }>(
    `SELECT pa.alias_norm AS identity_norm
       FROM page_aliases pa
       JOIN pages p ON p.slug=pa.slug AND p.source_id=pa.source_id
      WHERE pa.source_id=$1 AND p.deleted_at IS NULL AND p.type IN (${typeList})
      GROUP BY pa.alias_norm
     HAVING COUNT(DISTINCT pa.slug) > 1
      ORDER BY pa.alias_norm`,
    [sourceId],
  );
  const titleRows = await engine.executeRaw<{ identity_norm: string }>(
    `SELECT lower(trim(p.title)) AS identity_norm
       FROM pages p
      WHERE p.source_id=$1 AND p.deleted_at IS NULL AND p.type IN (${typeList})
      GROUP BY lower(trim(p.title))
     HAVING COUNT(DISTINCT p.slug) > 1
      ORDER BY lower(trim(p.title))`,
    [sourceId],
  );
  const contentTokens = tokenizeForScan(stripCodeBlocks(content)).map((token) => token.text);
  const aliasErrors = aliasRows
    .map((row) => row.identity_norm)
    .filter((identity) => containsTokenSequence(contentTokens, tokenizeTitle(identity)))
    .map((detail) => ({ code: 'ambiguous_entity_alias', detail }));
  const titleErrors = titleRows
    .map((row) => row.identity_norm)
    .filter((identity) => containsTokenSequence(contentTokens, tokenizeTitle(identity)))
    .map((detail) => ({ code: 'ambiguous_entity_title', detail }));
  return [...aliasErrors, ...titleErrors];
}

export async function projectSourceEvent(
  engine: BrainEngine,
  raw: SourceEventProjectionInput,
): Promise<SourceEventProjectionReceipt> {
  const sourceId = required(raw.sourceId, 'sourceId');
  const sourceKind = required(raw.sourceKind, 'sourceKind');
  const sourceKey = required(raw.sourceKey, 'sourceKey');
  const sourceUri = required(raw.sourceUri, 'sourceUri');
  const sourceSlug = required(raw.sourceSlug, 'sourceSlug');
  const contentHash = required(raw.contentHash, 'contentHash');
  const processorVersion = required(raw.processorVersion, 'processorVersion');
  const content = raw.content.trim();
  const observedAt = new Date(raw.occurredAt);
  if (Number.isNaN(observedAt.getTime())) throw new Error('source-event: occurredAt must be an ISO timestamp');
  const eventDate = observedAt.toISOString().slice(0, 10);
  const eventKey = sourceEventKey({ ...raw, sourceId, sourceKind, sourceKey, sourceUri, contentHash, processorVersion });

  const sources = await engine.listAllSources({ includeArchived: false });
  const source = sources.find((candidate) => candidate.id === sourceId);
  if (!source) {
    throw new Error(`source-event: sourceId '${sourceId}' is not a registered source`);
  }
  assertSourceEventAdmission(await readSourceEventPolicy(engine), source);
  const actualContentHash = createHash('md5').update(raw.content).digest('hex');
  if (contentHash !== actualContentHash) {
    throw new Error('source-event: contentHash does not match scanned content');
  }

  return engine.transaction(async (tx) => {
    const existing = await tx.executeRaw<ReceiptRow>(
      `SELECT source_id, event_key, status, candidates_count, resolved_count,
              links_written, timeline_written, facts_written, skipped_count, errors
         FROM source_event_receipts WHERE source_id=$1 AND event_key=$2`,
      [sourceId, eventKey],
    );
    if (existing[0]) return rowToReceipt(existing[0], true);

    const page = await tx.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
        WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`,
      [sourceId, sourceSlug],
    );
    if (!page[0]) throw new Error(`source-event: source page '${sourceSlug}' does not exist in source '${sourceId}'`);

    const claimed = await tx.executeRaw<{ id: number }>(
      `INSERT INTO source_event_receipts
         (source_id,event_key,source_kind,source_key,source_uri,source_slug,content_hash,processor_version,observed_at,event_date,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'processing')
       ON CONFLICT (source_id,event_key) DO NOTHING
       RETURNING id`,
      [sourceId, eventKey, sourceKind, sourceKey, sourceUri, sourceSlug, contentHash, processorVersion, observedAt.toISOString(), eventDate],
    );
    if (!claimed[0]) {
      const raced = await tx.executeRaw<ReceiptRow>(
        `SELECT source_id, event_key, status, candidates_count, resolved_count,
                links_written, timeline_written, facts_written, skipped_count, errors
           FROM source_event_receipts WHERE source_id=$1 AND event_key=$2`,
        [sourceId, eventKey],
      );
      if (!raced[0]) throw new Error('source-event: replay receipt disappeared during claim');
      return rowToReceipt(raced[0], true);
    }

    if (!content) {
      const emptyErrors = [{ code: 'empty_content' }];
      const rows = await tx.executeRaw<ReceiptRow>(
        `UPDATE source_event_receipts SET
           status='skipped', skipped_count=1, error_count=1,
           errors=$3::text::jsonb, updated_at=now()
         WHERE source_id=$1 AND event_key=$2
         RETURNING source_id, event_key, status, candidates_count, resolved_count,
                   links_written, timeline_written, facts_written, skipped_count, errors`,
        [sourceId, eventKey, JSON.stringify(emptyErrors)],
      );
      if (!rows[0]) throw new Error('source-event: failed to finalize empty-content receipt');
      return rowToReceipt(rows[0], false);
    }

    const finalizeReview = async (
      reviewErrors: Array<{ code: string; detail?: string }>,
      candidatesCount = reviewErrors.length,
    ): Promise<SourceEventProjectionReceipt> => {
      const rows = await tx.executeRaw<ReceiptRow>(
        `UPDATE source_event_receipts SET
           status='review', candidates_count=$3, skipped_count=$3,
           error_count=$4, errors=$5::text::jsonb, updated_at=now()
         WHERE source_id=$1 AND event_key=$2
         RETURNING source_id, event_key, status, candidates_count, resolved_count,
                   links_written, timeline_written, facts_written, skipped_count, errors`,
        [sourceId, eventKey, candidatesCount, reviewErrors.length, JSON.stringify(reviewErrors)],
      );
      if (!rows[0]) throw new Error('source-event: failed to finalize review receipt');
      return rowToReceipt(rows[0], false);
    };

    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > MAX_SOURCE_EVENT_CONTENT_BYTES) {
      return finalizeReview([{ code: 'content_too_large', detail: String(contentBytes) }], 0);
    }

    const reviewErrors = await findAmbiguousIdentity(tx, sourceId, content);
    if (reviewErrors.length > 0) {
      return finalizeReview(reviewErrors);
    }

    const gazetteer = await buildGazetteer(tx);
    const mentions = findMentionedEntities(content, gazetteer, {
      fromSlug: sourceSlug,
      fromSourceId: sourceId,
    });
    if (mentions.length > MAX_SOURCE_EVENT_TARGETS) {
      return finalizeReview(
        [{ code: 'too_many_entity_mentions', detail: String(mentions.length) }],
        mentions.length,
      );
    }
    const errors: Array<{ code: string; detail?: string }> = mentions.length === 0
      ? [{ code: 'no_known_entity_mentions' }]
      : [];
    const targetResults: Array<Record<string, string>> = [];
    let timelineWritten = 0;
    for (const mention of mentions) {
      const timeline = await writeTimelineEntryThrough(tx, mention.slug, sourceId, {
        date: eventDate,
        source: `source-event:${eventKey}`,
        summary: evidenceSummary(sourceKind, mention.name),
        detail: `Evidence receipt: ${eventKey}`,
      });
      if (!timeline.handled) {
        // Roll the receipt transaction back. The handler contains this item
        // failure and leaves the page eligible for the next Autopilot pass;
        // committing a partial receipt here would strand it forever because
        // receipt identity is this processor version's replay boundary.
        throw new Error(
          `source-event: canonical timeline write required for '${mention.slug}' ` +
          `(${timeline.skipped ?? timeline.error ?? 'unknown'})`,
        );
      }
      timelineWritten++;
      targetResults.push({
        slug: mention.slug,
        source_id: mention.source_id,
        // Body-text mention links are reconstructible through upstream's
        // `extract links --by-mention --source db` pass. Do not write a
        // parallel DB-only edge here; the receipt stays partial until that
        // reconciliation stage is wired and proven.
        link: 'deferred_to_by_mention',
        timeline: 'applied',
        facts: 'deferred',
      });
    }
    const linksWritten = 0;

    // v2 deliberately stops before LLM fact extraction. Mark the journey
    // partial so an evidence-only projection can never masquerade as full
    // distillation; a later processor version can resume the same event.
    const status: SourceEventProjectionReceipt['status'] = mentions.length > 0 ? 'partial' : 'skipped';
    const rows = await tx.executeRaw<ReceiptRow>(
      `UPDATE source_event_receipts SET
         status=$3, target_results=$4::text::jsonb, candidates_count=$5,
         resolved_count=$6, links_written=$7, timeline_written=$8,
         skipped_count=$9, error_count=$10, errors=$11::text::jsonb, updated_at=now()
       WHERE source_id=$1 AND event_key=$2
       RETURNING source_id, event_key, status, candidates_count, resolved_count,
                 links_written, timeline_written, facts_written, skipped_count, errors`,
      [sourceId, eventKey, status, JSON.stringify(targetResults), mentions.length,
       mentions.length, linksWritten, timelineWritten, mentions.length === 0 ? 1 : 0,
       errors.length, JSON.stringify(errors)],
    );
    if (!rows[0]) throw new Error('source-event: failed to finalize receipt');
    return rowToReceipt(rows[0], false);
  });
}
