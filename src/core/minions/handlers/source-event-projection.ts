import { tryAcquireDbLock } from '../../db-lock.ts';
import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext } from '../types.ts';
import { SOURCE_EVENT_PROCESSOR_VERSION, projectSourceEvent, retractSourceEvent } from '../../source-events/projector.ts';
import { parseSourceEventArtifact } from '../../source-events/artifact.ts';
import { assertSourceEventAdmission, readSourceEventPolicy } from '../../source-events/policy.ts';
import { fetchSource } from '../../sources-load.ts';

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

interface CandidateRow {
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

function timestamp(row: CandidateRow): { occurredAt: string; attested: boolean } {
  const raw = row.effective_date ?? row.updated_at;
  const value = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(value.getTime())) throw new Error(`source-event-projection: invalid timestamp for ${row.slug}`);
  return {
    occurredAt: value.toISOString(),
    // Filename dates are useful ordering hints, not provider/source
    // attestations. Only an explicit dated frontmatter source can authorize
    // compiled-truth or task application.
    attested: row.effective_date !== null
      && ['event_date', 'date', 'published'].includes(row.effective_date_source ?? ''),
  };
}

export function makeSourceEventProjectionHandler(engine: BrainEngine) {
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
          const sourceTime = timestamp(row);
          const receipt = await projectSourceEvent(engine, {
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
