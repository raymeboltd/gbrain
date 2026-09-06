import { tryAcquireDbLock } from '../../db-lock.ts';
import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext } from '../types.ts';
import { SOURCE_EVENT_PROCESSOR_VERSION, projectSourceEvent, retractSourceEvent } from '../../source-events/projector.ts';
import { parseSourceEventArtifact } from '../../source-events/artifact.ts';
import { assertSourceEventAdmission, readSourceEventPolicy } from '../../source-events/policy.ts';
import { fetchSource } from '../../sources-load.ts';
import type { TranscriptFormat } from '../../transcripts/types.ts';
import { parseConversation } from '../../conversation-parser/parse.ts';

const SUPPORTED_SOURCE_EVENT_TYPES = [
  'message',
  'email',
  'calendar-event',
  'meeting-note',
  'meeting',
  'imessage-daily',
  'slack',
  'event',
  'conversation',
] as const;

const LOCK_TTL_MIN = 20;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_SOURCE_EVENT_PART = 999_999_999;
const IMMUTABLE_IDENTITY_FIELDS = [
  'provider_item_id', 'message_id', 'event_id', 'note_id', 'session_id',
  'thread_id', 'capture_id', 'revision_id', 'conversation_id',
] as const;

export interface CandidateRow {
  slug: string;
  type: string;
  compiled_truth: string;
  timeline: string;
  projection_hash: string;
  updated_at: Date | string;
  effective_date: Date | string | null;
  effective_date_source: string | null;
  frontmatter: Record<string, unknown> | string;
}

export interface SourceEventConversationNormalization {
  content: string;
  method: 'not_conversation' | 'conversation_parser' | 'observer_primary_session' | 'conversation_parse_failed';
  parseDisposition: 'not_applicable' | 'parsed' | 'withheld';
}

interface RetractionCandidate {
  event_id: string;
  artifact_slug: string;
  source_slug?: string;
}

async function listCanonicalArtifacts(engine: BrainEngine, sourceId: string): Promise<RetractionCandidate[]> {
  const pages = await engine.executeRaw<{ slug: string; compiled_truth: string }>(
    `SELECT slug,COALESCE(compiled_truth,'') AS compiled_truth FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL
        AND COALESCE(frontmatter->>'source_event_artifact','')='true'`,
    [sourceId],
  );
  const artifacts: RetractionCandidate[] = [];
  for (const page of pages) {
    const artifact = parseSourceEventArtifact(page.compiled_truth);
    if (!artifact || artifact.source.source_id !== sourceId) continue;
    artifacts.push({
      event_id: artifact.event_id,
      artifact_slug: page.slug,
      source_slug: artifact.source.slug,
    });
  }
  return artifacts;
}

function uniqueRetractions(rows: RetractionCandidate[]): RetractionCandidate[] {
  const unique = new Map<string, RetractionCandidate>();
  for (const row of rows) unique.set(`${row.event_id}\0${row.artifact_slug}`, row);
  return [...unique.values()];
}

export function sourceEventProjectionLockId(sourceId: string): string {
  return `gbrain-source-event-projection:${sourceId}`;
}

function parseParams(data: Record<string, unknown>): { sourceId: string; limit: number } {
  const sourceId = typeof data.sourceId === 'string' ? data.sourceId.trim() : '';
  if (!sourceId) throw new Error('source-event-projection: sourceId is required');
  const rawLimit = typeof data.limit === 'number' ? Math.floor(data.limit) : DEFAULT_LIMIT;
  if (!Number.isFinite(rawLimit) || rawLimit < 1) {
    throw new Error('source-event-projection: limit must be a positive integer');
  }
  return { sourceId, limit: Math.min(rawLimit, MAX_LIMIT) };
}

async function listCandidates(engine: BrainEngine, sourceId: string, limit: number): Promise<CandidateRow[]> {
  return engine.executeRaw<CandidateRow>(
    `SELECT p.slug, p.type, COALESCE(p.compiled_truth, '') AS compiled_truth,
            COALESCE(p.timeline, '') AS timeline,
            md5(COALESCE(p.compiled_truth, '') || E'\n' || COALESCE(p.timeline, '')) AS projection_hash,
            p.updated_at, p.effective_date, p.effective_date_source, p.frontmatter
       FROM pages p
      WHERE p.source_id=$1
        AND p.deleted_at IS NULL
        AND (p.type = ANY($2::text[]) OR COALESCE(p.frontmatter->>'source_event', '') = 'true')
        AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
        AND COALESCE(p.frontmatter->>'source_event_artifact', '') <> 'true'
        AND NOT EXISTS (
          SELECT 1 FROM source_event_receipts r
           WHERE r.source_id=p.source_id
             AND r.source_slug=p.slug
             AND r.content_hash=md5(COALESCE(p.compiled_truth, '') || E'\n' || COALESCE(p.timeline, ''))
             AND r.processor_version=$4
             AND r.status IN ('applied','partial','skipped')
             AND NOT (r.errors @> '[{"code":"source_retracted"}]'::jsonb)
        )
        AND NOT EXISTS (
          SELECT 1 FROM source_event_receipts retry_receipt
           WHERE retry_receipt.source_id=p.source_id
             AND retry_receipt.source_slug=p.slug
             AND retry_receipt.content_hash=md5(COALESCE(p.compiled_truth, '') || E'\n' || COALESCE(p.timeline, ''))
             AND retry_receipt.processor_version=$4
             AND retry_receipt.status IN ('review','error')
             AND retry_receipt.updated_at > now() - INTERVAL '24 hours'
        )
      ORDER BY CASE WHEN EXISTS (
        SELECT 1 FROM source_event_receipts pending_retry
         WHERE pending_retry.source_id=p.source_id
           AND pending_retry.source_slug=p.slug
           AND pending_retry.content_hash=md5(COALESCE(p.compiled_truth, '') || E'\n' || COALESCE(p.timeline, ''))
           AND pending_retry.processor_version=$4
           AND pending_retry.status IN ('review','error')
      ) THEN 1 ELSE 0 END,
      CASE WHEN
        (
          jsonb_typeof(p.frontmatter#>'{transcript_import,session_id}') = 'string'
          AND jsonb_typeof(p.frontmatter#>'{transcript_import,harness}') = 'string'
          AND NULLIF(BTRIM(COALESCE(p.frontmatter#>>'{transcript_import,session_id}', '')), '') IS NOT NULL
          AND NULLIF(BTRIM(COALESCE(p.frontmatter#>>'{transcript_import,harness}', '')), '') IS NOT NULL
          AND (
            (
              jsonb_typeof(p.frontmatter#>'{transcript_import,part}') = 'string'
              AND COALESCE(p.frontmatter#>>'{transcript_import,part}', '') ~ '^[1-9][0-9]{0,8}$'
            )
            OR (
              jsonb_typeof(p.frontmatter#>'{transcript_import,part}') = 'number'
              AND (p.frontmatter#>>'{transcript_import,part}')::numeric BETWEEN 1 AND 999999999
              AND (p.frontmatter#>>'{transcript_import,part}')::numeric =
                  TRUNC((p.frontmatter#>>'{transcript_import,part}')::numeric)
            )
          )
        )
        OR (
          EXISTS (
            SELECT 1 FROM jsonb_each_text(COALESCE(p.frontmatter, '{}'::jsonb)) provider_meta
             WHERE provider_meta.key = ANY(ARRAY['provider','source_tool','network']::text[])
               AND jsonb_typeof(p.frontmatter->provider_meta.key) = 'string'
               AND NULLIF(BTRIM(provider_meta.value), '') IS NOT NULL
          )
          AND EXISTS (
            SELECT 1 FROM jsonb_each_text(COALESCE(p.frontmatter, '{}'::jsonb)) identity_meta
             WHERE identity_meta.key = ANY($5::text[])
               AND jsonb_typeof(p.frontmatter->identity_meta.key) = 'string'
               AND NULLIF(BTRIM(identity_meta.value), '') IS NOT NULL
          )
        )
        OR (
          jsonb_typeof(p.frontmatter->'native_container_id') = 'string'
          AND NULLIF(BTRIM(COALESCE(p.frontmatter->>'native_container_id', '')), '') IS NOT NULL
          AND (
            (
              jsonb_typeof(p.frontmatter->'part_index') = 'string'
              AND COALESCE(p.frontmatter->>'part_index', '') ~ '^[1-9][0-9]{0,8}$'
            )
            OR (
              jsonb_typeof(p.frontmatter->'part_index') = 'number'
              AND (p.frontmatter->>'part_index')::numeric BETWEEN 1 AND 999999999
              AND (p.frontmatter->>'part_index')::numeric = TRUNC((p.frontmatter->>'part_index')::numeric)
            )
          )
          AND EXISTS (
            SELECT 1 FROM jsonb_each_text(COALESCE(p.frontmatter, '{}'::jsonb)) provider_meta
             WHERE provider_meta.key = ANY(ARRAY['provider','source_tool','network']::text[])
               AND jsonb_typeof(p.frontmatter->provider_meta.key) = 'string'
               AND NULLIF(BTRIM(provider_meta.value), '') IS NOT NULL
          )
          AND EXISTS (
            SELECT 1 FROM jsonb_each_text(COALESCE(p.frontmatter, '{}'::jsonb)) owner_meta
             WHERE owner_meta.key = ANY(ARRAY['account_id','source_id']::text[])
               AND jsonb_typeof(p.frontmatter->owner_meta.key) = 'string'
               AND NULLIF(BTRIM(owner_meta.value), '') IS NOT NULL
          )
        )
        THEN 0 ELSE 1 END,
        p.updated_at, p.slug
      LIMIT $3`,
    [sourceId, [...SUPPORTED_SOURCE_EVENT_TYPES], limit, SOURCE_EVENT_PROCESSOR_VERSION,
     [...IMMUTABLE_IDENTITY_FIELDS]],
  );
}

function metadata(row: CandidateRow): Record<string, unknown> {
  if (typeof row.frontmatter !== 'string') return row.frontmatter ?? {};
  try {
    const parsed = JSON.parse(row.frontmatter);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function positivePart(value: unknown): string | null {
  const normalized = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(normalized) && normalized >= 1 && normalized <= MAX_SOURCE_EVENT_PART
    ? String(normalized)
    : null;
}

function sourceIdentity(row: CandidateRow): { sourceKey: string; sourceUri: string } | null {
  const meta = metadata(row);
  const transcript = meta.transcript_import && typeof meta.transcript_import === 'object'
    ? meta.transcript_import as Record<string, unknown>
    : null;
  const transcriptSession = transcript?.session_id;
  const transcriptHarness = transcript?.harness;
  const transcriptPart = transcript?.part;
  const transcriptPartValue = positivePart(transcriptPart);
  if (typeof transcriptSession === 'string' && transcriptSession.trim()
      && typeof transcriptHarness === 'string' && transcriptHarness.trim() && transcriptPartValue) {
    const harness = transcriptHarness.trim();
    return {
      sourceKey: `conversation:${harness}:session_id:${transcriptSession.trim()}:part:${transcriptPartValue}`,
      sourceUri: typeof meta.source_uri === 'string' && meta.source_uri.trim()
        ? meta.source_uri.trim()
        : `gbrain://${encodeURIComponent(row.slug)}`,
    };
  }
  // Vault OS K1 retrieval documents intentionally separate stable container
  // identity from revision identity. document_id/input_manifest_sha256 change
  // when raw inputs change, so they must never become the source event id.
  // provider + account/source namespace + native container + part remains
  // stable across those revisions and across page renames.
  const nativeContainer = typeof meta.native_container_id === 'string'
    ? meta.native_container_id.trim()
    : '';
  const part = positivePart(meta.part_index);
  const ownerNamespace = [meta.account_id, meta.source_id]
    .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  const retrievalProvider = [meta.provider, meta.source_tool, meta.network]
    .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  if (nativeContainer && part && ownerNamespace && retrievalProvider) {
    const encode = (value: string) => encodeURIComponent(value.trim());
    return {
      sourceKey: `retrieval-document:${encode(retrievalProvider)}` +
        `:owner:${encode(ownerNamespace)}:native_container_id:${encode(nativeContainer)}:part:${part}`,
      sourceUri: typeof meta.source_uri === 'string' && meta.source_uri.trim()
        ? meta.source_uri.trim()
        : `gbrain://${encodeURIComponent(row.slug)}`,
    };
  }
  const matched = IMMUTABLE_IDENTITY_FIELDS
    .map((field) => ({ field, value: meta[field] }))
    .find(({ value }) => typeof value === 'string' && value.trim());
  const providerFields = ['provider', 'source_tool', 'network'];
  const provider = providerFields
    .map((field) => meta[field])
    .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  // Always namespace provider ids. When producer metadata omits an explicit
  // provider, the closed source-event type is the deterministic fallback;
  // bare `id:123` values from email/message/calendar lanes must not collide.
  if (!provider) return null;
  const namespace = `${provider.trim()}:`;
  const uri = meta.source_uri;
  if (!matched) return null;
  return {
    sourceKey: `${namespace}${matched.field}:${String(matched.value).trim()}`,
    sourceUri: typeof uri === 'string' && uri.trim()
      ? uri.trim()
      : `gbrain://${encodeURIComponent(row.slug)}`,
  };
}

// The native transcript adapters define the supported source-time contract.
// Record exhaustiveness makes newly supported formats an explicit review here.
const CONVERSATION_TIME_PROVIDERS: Record<TranscriptFormat, true> = {
  'claude-code': true, codex: true, openclaw: true, hermes: true,
  grok: true, chatgpt: true, 'claude-export': true,
};

function recognizedConversationProvider(meta: Record<string, unknown>): boolean {
  const transcript = meta.transcript_import;
  const harness = transcript && typeof transcript === 'object' ? (transcript as Record<string, unknown>).harness : undefined;
  const provider = [harness, meta.provider, meta.source_tool, meta.network]
    .find((value) => typeof value === 'string' && value.trim());
  return typeof provider === 'string' && Object.hasOwn(CONVERSATION_TIME_PROVIDERS, provider.trim());
}

function strictIsoTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth
      || hour > 23 || minute > 59 || second > 59) return null;
  if (match[7] !== 'Z') {
    const [offsetHour, offsetMinute] = match[7].slice(1).split(':').map(Number);
    if (offsetHour! > 23 || offsetMinute! > 59) return null;
  }
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function sourceEventTimestamp(
  row: CandidateRow,
  hasStableProviderIdentity = sourceIdentity(row) !== null,
): { occurredAt: string; attested: boolean; source: 'started_at' | 'effective_date' | 'updated_at' } {
  const meta = metadata(row);
  const explicitEffectiveDate = row.effective_date !== null
    && ['event_date', 'date', 'published'].includes(row.effective_date_source ?? '');
  const startedAt = row.type === 'conversation' && hasStableProviderIdentity && recognizedConversationProvider(meta) && !explicitEffectiveDate
    ? strictIsoTimestamp(meta.started_at)
    : null;
  if (startedAt) {
    return { occurredAt: startedAt.toISOString(), attested: true, source: 'started_at' };
  }
  const raw = row.effective_date ?? row.updated_at;
  const value = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(value.getTime())) throw new Error(`source-event-projection: invalid timestamp for ${row.slug}`);
  return {
    occurredAt: value.toISOString(),
    // Filename dates are useful ordering hints, not provider/source
    // attestations. Only an explicit dated frontmatter source can authorize
    // compiled-truth or task application.
    attested: explicitEffectiveDate,
    source: row.effective_date !== null ? 'effective_date' : 'updated_at',
  };
}

// The parser is deliberately permissive. Shield literal Markdown before parsing
// so examples cannot become speaker boundaries; restore bytes only after roles
// have been assigned. Tokens cannot collide with source-authored text.
function protectLiteralLines(body: string): { content: string; restore: (value: string) => string } {
  let prefix = 'GBRAIN_LITERAL_';
  while (body.includes(prefix)) prefix += '_';
  const literals: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  const content = body.split('\n').map((line) => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const protectedLine = fence !== null || match !== null || /^\s*>/.test(line)
      || /^(?: {4}|\t)/.test(line);
    if (match) {
      if (fence === null) fence = { marker: match[1]![0]!, length: match[1]!.length };
      else if (match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim()) fence = null;
    }
    if (!protectedLine) return line;
    const token = `${prefix}${literals.length}_END`;
    literals.push(line);
    return token;
  }).join('\n');
  return { content, restore: (value) => value.replace(
    new RegExp(`${prefix}(\\d+)_END`, 'g'), (_, index) => literals[Number(index)]!,
  ) };
}

function tagged(role: string, speaker: string, text: string): string {
  return `<source-message role=${JSON.stringify(role)} speaker=${JSON.stringify(speaker)}>` +
    `\n${text.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n</source-message>`;
}

function extractTag(body: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...body.matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'gi'))]
    .map((match) => match[1]!.trim()).filter(Boolean);
}

function splitExplicitToolEvidence(body: string): { conversation: string; tools: string[] } {
  const lines = body.split('\n');
  const conversation: string[] = [];
  const tools: string[] = [];
  let tool: string[] | null = null;
  let fenced = false;
  const toolHeading = /^(?:\*\*(tool(?:[- ]result)?):\*\*|#{2,3}\s+(tool(?:[- ]result)?)\s*:?)\s*(.*)$/i;
  const roleHeading = /^(?:\*\*(?:You|ChatGPT|User|Assistant|Human|System):\*\*|#{2,3}\s+(?:User|Assistant|Human|System)\s*:?)\s*/i;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = !fenced ? toolHeading.exec(line) : null;
    if (match) {
      if (tool) tools.push(tool.join('\n').trim());
      tool = [`kind: ${(match[1] ?? match[2])!.toLowerCase().replace(' ', '-')}`, match[3] ?? ''];
      continue;
    }
    if (tool && !fenced && roleHeading.test(line)) {
      tools.push(tool.join('\n').trim());
      tool = null;
    }
    if (tool) tool.push(line);
    else conversation.push(line);
  }
  if (tool) tools.push(tool.join('\n').trim());
  return { conversation: conversation.join('\n'), tools: tools.filter(Boolean) };
}

function isObserverConversation(meta: Record<string, unknown>): boolean {
  const workspace = typeof meta.workspace === 'string' ? meta.workspace : '';
  const sourcePath = typeof meta.source_path === 'string' ? meta.source_path : '';
  return /(?:^|\/)claude\/mem\/observer(?:\/|$)/i.test(`${workspace}/${sourcePath}`);
}

/** Deterministic, provider-scoped fact-extraction view. The raw page is never changed. */
export function normalizeSourceEventConversation(
  row: CandidateRow,
  rawContent: string,
  hasStableProviderIdentity = sourceIdentity(row) !== null,
): SourceEventConversationNormalization {
  if (row.type !== 'conversation' || !hasStableProviderIdentity) {
    return { content: rawContent, method: 'not_conversation', parseDisposition: 'not_applicable' };
  }
  const meta = metadata(row);
  const protectedText = protectLiteralLines(rawContent);
  const parsed = parseConversation(protectedText.content, {
    fallbackDate: sourceEventTimestamp(row, true).occurredAt,
    noPolish: true,
    noFallback: true,
  });
  if (parsed.phase === 'no_match' || parsed.messages.length === 0) {
    return {
      content: '[source-event normalization=conversation_parse_failed disposition=withheld]\n' +
        'Raw conversation remains in its source page; it was withheld from fact extraction.',
      method: 'conversation_parse_failed',
      parseDisposition: 'withheld',
    };
  }

  if (isObserverConversation(meta)) {
    const evidence: string[] = [];
    for (const message of parsed.messages.filter((item) => /^(?:user|human|you)$/i.test(item.speaker))) {
      for (const observed of extractTag(message.text, 'observed_from_primary_session')) {
        for (const request of extractTag(observed, 'user_request')) {
          evidence.push(tagged('primary-user', 'observed-primary-user', protectedText.restore(request)));
        }
        for (const tag of ['what_happened', 'parameters', 'outcome'] as const) {
          for (const value of extractTag(observed, tag)) {
            evidence.push(tagged('tool-evidence', tag, protectedText.restore(value)));
          }
        }
      }
    }
    if (evidence.length === 0) {
      return {
        content: '[source-event normalization=observer_primary_session disposition=withheld]\n' +
          'No primary-session evidence was found; observer text was withheld from fact extraction.',
        method: 'observer_primary_session', parseDisposition: 'withheld',
      };
    }
    return {
      content: '[source-event normalization=observer_primary_session disposition=parsed]\n' + evidence.join('\n\n'),
      method: 'observer_primary_session', parseDisposition: 'parsed',
    };
  }

  const split = splitExplicitToolEvidence(protectedText.content);
  const messages = parseConversation(split.conversation, {
    fallbackDate: sourceEventTimestamp(row, true).occurredAt,
    noPolish: true,
    noFallback: true,
  }).messages;
  const rendered = messages.map((message) => tagged(
    /^(?:user|human|you)$/i.test(message.speaker) ? 'user' : 'assistant-context',
    message.speaker,
    protectedText.restore(message.text),
  ));
  rendered.push(...split.tools.map((tool) => tagged('tool-evidence', 'tool', protectedText.restore(tool))));
  return {
    content: '[source-event normalization=conversation_parser disposition=parsed]\n' + rendered.join('\n\n'),
    method: 'conversation_parser', parseDisposition: 'parsed',
  };
}

export function makeSourceEventProjectionHandler(
  engine: BrainEngine,
  deps: { project?: typeof projectSourceEvent } = {},
) {
  return async function sourceEventProjectionHandler(job: MinionJobContext): Promise<unknown> {
    const { sourceId, limit } = parseParams(job.data);
    const source = await fetchSource(engine, sourceId);
    if (!source) {
      throw new Error(`source-event-projection: sourceId '${sourceId}' is not a registered source`);
    }
    const lock = await tryAcquireDbLock(engine, sourceEventProjectionLockId(sourceId), LOCK_TTL_MIN);
    if (!lock) return { status: 'already_in_progress', sourceId };

    try {
      if (source.archived === true) {
        const archivedReceipts = await engine.executeRaw<{ event_id: string; artifact_slug: string }>(
          `SELECT DISTINCT ON (event_id) event_id,artifact_slug
             FROM source_event_receipts
            WHERE source_id=$1
              AND NOT (errors @> '[{"code":"source_retracted"}]'::jsonb)
            ORDER BY event_id,observed_at DESC,id DESC`,
          [sourceId],
        );
        const archivedRetractions = uniqueRetractions([
          ...archivedReceipts,
          ...await listCanonicalArtifacts(engine, sourceId),
        ]);
        for (const row of archivedRetractions) {
          await retractSourceEvent(engine, {
            sourceId,
            eventId: row.event_id,
            artifactSlug: row.artifact_slug,
            reason: 'source archived',
          });
        }
        return {
          status: 'completed', sourceId, scanned: 0, applied: 0, partial: 0,
          skipped: 0, reviews: 0, failed: 0, errors: 0,
          retracted: archivedRetractions.length, identity_rejected: 0, silent_skips: 0,
        };
      }
      assertSourceEventAdmission(await readSourceEventPolicy(engine), source);
      const retractions = await engine.executeRaw<{ event_id: string; artifact_slug: string }>(
        `SELECT DISTINCT ON (r.event_id) r.event_id,r.artifact_slug
           FROM source_event_receipts r
           JOIN pages p ON p.source_id=r.source_id AND p.slug=r.source_slug
          WHERE r.source_id=$1 AND p.deleted_at IS NOT NULL
            AND NOT (r.errors @> '[{"code":"source_retracted"}]'::jsonb)
          ORDER BY r.event_id,r.observed_at DESC,r.id DESC`,
        [sourceId],
      );
      const deletedRows = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NOT NULL`,
        [sourceId],
      );
      const deletedSlugs = new Set(deletedRows.map((row) => row.slug));
      const canonicalRetractions = (await listCanonicalArtifacts(engine, sourceId))
        .filter((artifact) => artifact.source_slug && deletedSlugs.has(artifact.source_slug));
      const allRetractions = uniqueRetractions([...retractions, ...canonicalRetractions]);
      for (const row of allRetractions) {
        await retractSourceEvent(engine, {
          sourceId,
          eventId: row.event_id,
          artifactSlug: row.artifact_slug,
          reason: 'source page deleted',
        });
      }
      const candidates = await listCandidates(engine, sourceId, limit);
      let applied = 0;
      let partial = 0;
      let skipped = 0;
      let reviews = 0;
      let failed = 0;
      let errors = 0;
      let identityRejected = 0;
      for (let index = 0; index < candidates.length; index++) {
        if (job.signal.aborted) throw job.signal.reason ?? new Error('source-event-projection aborted');
        const row = candidates[index]!;
        // Keep byte shape aligned with the SQL projection_hash expression.
        // The projector verifies this digest before accepting the event.
        const content = `${row.compiled_truth}\n${row.timeline}`;
        const identity = sourceIdentity(row);
        if (!identity) {
          identityRejected++;
          errors++;
          await job.log(`source-event-projection: immutable provider identity missing for ${row.slug}`);
          await job.updateProgress({
            phase: 'source-event-projection', scanned: index + 1, total: candidates.length,
            applied, partial, skipped, reviews, failed, errors, identity_rejected: identityRejected,
          });
          continue;
        }
        try {
          const sourceTime = sourceEventTimestamp(row, true);
          const normalized = normalizeSourceEventConversation(row, content, true);
          const receipt = await (deps.project ?? projectSourceEvent)(engine, {
            sourceId,
            sourceKind: row.type,
            sourceKey: identity.sourceKey,
            sourceUri: identity.sourceUri,
            sourceSlug: row.slug,
            contentHash: row.projection_hash,
            processorVersion: SOURCE_EVENT_PROCESSOR_VERSION,
            occurredAt: sourceTime.occurredAt,
            occurredAtAttested: sourceTime.attested,
            content,
            factsContent: normalized.content,
            normalization: {
              method: normalized.method,
              parseDisposition: normalized.parseDisposition,
            },
          }, { sourceLockHeld: true });
          if (receipt.status === 'applied') applied++;
          else if (receipt.status === 'partial') partial++;
          else if (receipt.status === 'review') reviews++;
          else skipped++;
          errors += receipt.errors.length;
        } catch (error) {
          failed++;
          errors++;
          await job.log(error instanceof Error ? error.message : String(error));
        }
        await job.updateProgress({
          phase: 'source-event-projection',
          scanned: index + 1,
          total: candidates.length,
          applied,
          partial,
          skipped,
          reviews,
          failed,
          errors,
        });
      }
      if (failed > 0) {
        throw new Error(
          `source-event-projection: ${failed} item(s) failed canonical projection ` +
          `(scanned=${candidates.length}, applied=${applied}, partial=${partial}, skipped=${skipped}, review=${reviews})`,
        );
      }
      const silentRows = await engine.executeRaw<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM source_event_receipts
          WHERE source_id=$1 AND processor_version=$2
            AND status IN ('partial','skipped','review','error')
            AND jsonb_array_length(errors)=0`,
        [sourceId, SOURCE_EVENT_PROCESSOR_VERSION],
      );
      const silentSkips = Number(silentRows[0]?.count ?? 0);
      if (silentSkips > 0) {
        throw new Error(`source-event-projection: ${silentSkips} non-applied receipt(s) have no explicit cause`);
      }
      const status = partial > 0 || skipped > 0 || reviews > 0 || failed > 0 || errors > 0 ? 'partial' : 'completed';
      return { status, sourceId, scanned: candidates.length, applied, partial, skipped, reviews, failed, errors, retracted: allRetractions.length, identity_rejected: identityRejected, silent_skips: silentSkips };
    } finally {
      await lock.release();
    }
  };
}
