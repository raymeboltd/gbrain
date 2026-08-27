import { tryAcquireDbLock } from '../../db-lock.ts';
import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext } from '../types.ts';
import { SOURCE_EVENT_PROCESSOR_VERSION, projectSourceEvent, retractSourceEvent } from '../../source-events/projector.ts';
import { assertSourceEventAdmission, readSourceEventPolicy } from '../../source-events/policy.ts';

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

interface CandidateRow {
  slug: string;
  type: string;
  compiled_truth: string;
  timeline: string;
  projection_hash: string;
  updated_at: Date | string;
  effective_date: Date | string | null;
  frontmatter: Record<string, unknown> | string;
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
            p.updated_at, p.effective_date, p.frontmatter
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
      ORDER BY p.updated_at, p.slug
      LIMIT $3`,
    [sourceId, [...SUPPORTED_SOURCE_EVENT_TYPES], limit, SOURCE_EVENT_PROCESSOR_VERSION],
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

function sourceIdentity(row: CandidateRow): { sourceKey: string; sourceUri: string } {
  const meta = metadata(row);
  const transcript = meta.transcript_import && typeof meta.transcript_import === 'object'
    ? meta.transcript_import as Record<string, unknown>
    : null;
  const transcriptSession = transcript?.session_id;
  const transcriptHarness = transcript?.harness;
  const transcriptPart = transcript?.part;
  if (typeof transcriptSession === 'string' && transcriptSession.trim()) {
    const harness = typeof transcriptHarness === 'string' && transcriptHarness.trim()
      ? transcriptHarness.trim()
      : 'unknown';
    const part = typeof transcriptPart === 'number' && Number.isInteger(transcriptPart)
      ? String(transcriptPart)
      : '1';
    return {
      sourceKey: `conversation:${harness}:session_id:${transcriptSession.trim()}:part:${part}`,
      sourceUri: typeof meta.source_uri === 'string' && meta.source_uri.trim()
        ? meta.source_uri.trim()
        : `gbrain://${encodeURIComponent(row.slug)}`,
    };
  }
  const keyFields = [
    'provider_item_id', 'message_id', 'event_id', 'note_id', 'session_id',
    'thread_id', 'capture_id', 'revision_id', 'conversation_id', 'id',
  ];
  const matched = keyFields
    .map((field) => ({ field, value: meta[field] }))
    .find(({ value }) => typeof value === 'string' && value.trim());
  const providerFields = ['provider', 'source_tool', 'network'];
  const provider = providerFields
    .map((field) => meta[field])
    .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  const namespace = provider ? `${provider.trim()}:` : '';
  const uri = meta.source_uri;
  return {
    sourceKey: matched
      ? `${namespace}${matched.field}:${String(matched.value).trim()}`
      : `page:${row.slug}`,
    sourceUri: typeof uri === 'string' && uri.trim()
      ? uri.trim()
      : `gbrain://${encodeURIComponent(row.slug)}`,
  };
}

function timestamp(row: CandidateRow): string {
  const raw = row.effective_date ?? row.updated_at;
  const value = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(value.getTime())) throw new Error(`source-event-projection: invalid timestamp for ${row.slug}`);
  return value.toISOString();
}

export function makeSourceEventProjectionHandler(engine: BrainEngine) {
  return async function sourceEventProjectionHandler(job: MinionJobContext): Promise<unknown> {
    const { sourceId, limit } = parseParams(job.data);
    const sources = await engine.listAllSources({ includeArchived: false });
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) {
      throw new Error(`source-event-projection: sourceId '${sourceId}' is not a registered source`);
    }
    assertSourceEventAdmission(await readSourceEventPolicy(engine), source);
    const lock = await tryAcquireDbLock(engine, sourceEventProjectionLockId(sourceId), LOCK_TTL_MIN);
    if (!lock) return { status: 'already_in_progress', sourceId };

    try {
      const retractions = await engine.executeRaw<{ event_id: string; artifact_slug: string }>(
        `SELECT DISTINCT ON (r.event_id) r.event_id,r.artifact_slug
           FROM source_event_receipts r
           JOIN pages p ON p.source_id=r.source_id AND p.slug=r.source_slug
          WHERE r.source_id=$1 AND p.deleted_at IS NOT NULL
            AND NOT (r.errors @> '[{"code":"source_retracted"}]'::jsonb)
          ORDER BY r.event_id,r.observed_at DESC,r.id DESC`,
        [sourceId],
      );
      for (const row of retractions) {
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
      for (let index = 0; index < candidates.length; index++) {
        if (job.signal.aborted) throw job.signal.reason ?? new Error('source-event-projection aborted');
        const row = candidates[index]!;
        // Keep byte shape aligned with the SQL projection_hash expression.
        // The projector verifies this digest before accepting the event.
        const content = `${row.compiled_truth}\n${row.timeline}`;
        const identity = sourceIdentity(row);
        try {
          const receipt = await projectSourceEvent(engine, {
            sourceId,
            sourceKind: row.type,
            sourceKey: identity.sourceKey,
            sourceUri: identity.sourceUri,
            sourceSlug: row.slug,
            contentHash: row.projection_hash,
            processorVersion: SOURCE_EVENT_PROCESSOR_VERSION,
            occurredAt: timestamp(row),
            content,
          });
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
      return { status, sourceId, scanned: candidates.length, applied, partial, skipped, reviews, failed, errors, retracted: retractions.length, silent_skips: silentSkips };
    } finally {
      await lock.release();
    }
  };
}
