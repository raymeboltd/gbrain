/**
 * Review-first compiled-truth projection for source events.
 *
 * The private source-event artifact is the decision/application ledger. Only
 * an active revision whose candidate was explicitly approved can contribute
 * to an entity page. Entity pages receive one deterministic machine-owned
 * block; human prose, frontmatter, timeline text and the Facts fence remain
 * byte/row equivalent. Corrections and retractions rebuild that block from
 * active approvals, so stale generated text disappears without touching
 * human-authored material.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import { atomicWriteFileSync } from '../atomic-write.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { frontmatterBodyOffset, parseMarkdown } from '../markdown.ts';
import { withPageLock } from '../page-lock.ts';
import { resolveLinkableEntityTypes } from '../by-mention.ts';
import { resolvePageWriteTarget } from '../write-through.ts';
import { fetchSource } from '../sources-load.ts';
import { tryAcquireDbLock } from '../db-lock.ts';
import { assertSourceEventAdmission, readSourceEventPolicy } from './policy.ts';
import { importFromContent } from '../import-file.ts';
import { loadActivePackForLocalEngine } from '../schema-pack/best-effort.ts';
import {
  SOURCE_EVENT_UPDATES_BEGIN as BLOCK_BEGIN,
  SOURCE_EVENT_UPDATES_END as BLOCK_END,
} from './private-compiled-block.ts';
import {
  loadSourceEventArtifact,
  parseSourceEventArtifact,
  persistSourceEventArtifact,
  type SourceEventArtifact,
  type SourceEventRevisionRecord,
} from './artifact.ts';

const CANDIDATE_MARKER = 'gbrain:source-event-candidate';

type ReviewState = 'pending' | 'approved_pending' | 'approved' | 'rejected_pending' | 'rejected';

export interface CompiledTruthCandidate {
  candidate_id: string;
  event_id: string;
  revision_id: string;
  target_slug: string;
  target_type: string;
  text: string;
  source_date: string;
  source_date_attested: boolean;
  confidence: number | null;
  fact_id: number;
  processor_version: string;
  content_hash: string;
  evidence_artifact_slug: string;
  review_state: ReviewState;
  reviewed_at?: string;
  reviewer?: string;
  target_hash?: string;
}

export interface ReviewCompiledTruthInput {
  sourceId: string;
  eventId: string;
  revisionId: string;
  candidateId: string;
  decision: 'approve' | 'reject';
  reviewer: string;
  /** SHA-256 of the current canonical target file. Required for approval. */
  expectedTargetHash?: string;
}

export interface ReviewCompiledTruthResult {
  status: 'applied' | 'rejected' | 'already_applied' | 'already_rejected';
  candidate_id: string;
  target_slug: string;
  target_hash: string;
}

export interface SourceEventTaskCandidate {
  candidate_id: string;
  event_id: string;
  revision_id: string;
  entity_slug: string;
  text: string;
  due: string | null;
  source_date: string;
  source_date_attested: boolean;
  fact_id: number;
  evidence_artifact_slug: string;
  review_state: 'pending' | 'applied' | 'retirement_pending' | 'retired';
  required_action: 'create' | 'update' | 'retire' | 'review_correction';
  prior_application?: Record<string, unknown>;
  correction_ambiguous?: boolean;
}

function hashText(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function withSourceProjectionLock<T>(
  engine: BrainEngine,
  sourceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockId = `gbrain-source-event-projection:${sourceId}`;
  let lock = await tryAcquireDbLock(engine, lockId, 20);
  for (let attempt = 0; !lock && attempt < 200; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    lock = await tryAcquireDbLock(engine, lockId, 20);
  }
  if (!lock) throw new Error(`source-event: source projection lock unavailable for '${sourceId}'`);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export function candidateIdentity(input: {
  eventId: string;
  revisionId: string;
  factId: number;
  kind: string;
  targetSlug: string;
}): string {
  return hashText([
    input.eventId, input.revisionId, String(input.factId), input.kind, input.targetSlug,
  ].join('\0'));
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asCandidate(
  artifact: SourceEventArtifact,
  revision: SourceEventRevisionRecord,
  raw: Record<string, unknown>,
): CompiledTruthCandidate | null {
  const targetSlug = asString(raw.entity_slug);
  const targetType = asString(raw.entity_type);
  const text = asString(raw.text);
  const factId = Number(raw.fact_id);
  if (!targetSlug || !targetType || !text || !Number.isSafeInteger(factId) || factId < 1) return null;
  const candidateId = asString(raw.candidate_id) || candidateIdentity({
    eventId: artifact.event_id,
    revisionId: revision.revision_id,
    factId,
    kind: 'compiled_truth_candidate',
    targetSlug,
  });
  const state = asString(raw.review_state);
  const reviewState: ReviewState = ['approved_pending', 'approved', 'rejected_pending', 'rejected'].includes(state)
    ? state as ReviewState
    : 'pending';
  return {
    candidate_id: candidateId,
    event_id: artifact.event_id,
    revision_id: revision.revision_id,
    target_slug: targetSlug,
    target_type: targetType,
    text,
    source_date: asString(raw.source_date) || revision.occurred_at.slice(0, 10),
    source_date_attested: raw.source_date_attested === true,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
    fact_id: factId,
    processor_version: asString(raw.processor_version) || revision.processor_version,
    content_hash: asString(raw.content_hash) || revision.content_hash,
    evidence_artifact_slug: asString(raw.evidence_artifact_slug) || `source-events/${artifact.event_id}`,
    review_state: reviewState,
    ...(asString(raw.reviewed_at) ? { reviewed_at: asString(raw.reviewed_at) } : {}),
    ...(asString(raw.reviewer) ? { reviewer: asString(raw.reviewer) } : {}),
  };
}

function asTaskCandidate(
  artifact: SourceEventArtifact,
  revision: SourceEventRevisionRecord,
  raw: Record<string, unknown>,
): SourceEventTaskCandidate | null {
  const entitySlug = asString(raw.entity_slug);
  const text = asString(raw.text);
  const factId = Number(raw.fact_id);
  if (!entitySlug || !text || !Number.isSafeInteger(factId) || factId < 1) return null;
  const candidateId = asString(raw.candidate_id) || candidateIdentity({
    eventId: artifact.event_id, revisionId: revision.revision_id, factId,
    kind: 'task_candidate', targetSlug: entitySlug,
  });
  const applied = ['applied', 'retired'].includes(asString(raw.review_state)) && raw.application
    && typeof raw.application === 'object';
  const priorByTask = new Map<string, Record<string, unknown>>();
  for (const priorRevision of artifact.revisions.filter((row) => row.state === 'superseded')) {
    for (const priorCandidate of priorRevision.action_candidates ?? []) {
      if (asString(priorCandidate.entity_slug) !== entitySlug
          || priorCandidate.review_state !== 'applied'
          || !priorCandidate.application
          || typeof priorCandidate.application !== 'object') continue;
      const application = priorCandidate.application as Record<string, unknown>;
      // Repeated corrections leave historical receipts for the same task.
      // Count distinct canonical task IDs, not receipt count, so a second
      // correction updates the task again instead of becoming falsely
      // ambiguous. Two genuinely different task IDs still require review.
      priorByTask.set(
        asString(application.task_id) || asString(priorCandidate.candidate_id),
        application,
      );
    }
  }
  const prior = [...priorByTask.values()];
  return {
    candidate_id: candidateId,
    event_id: artifact.event_id,
    revision_id: revision.revision_id,
    entity_slug: entitySlug,
    text,
    due: typeof raw.due === 'string' && raw.due.trim() ? raw.due.trim() : null,
    source_date: asString(raw.source_date) || revision.occurred_at.slice(0, 10),
    source_date_attested: raw.source_date_attested === true,
    fact_id: factId,
    evidence_artifact_slug: asString(raw.evidence_artifact_slug) || `source-events/${artifact.event_id}`,
    review_state: raw.review_state === 'retired' ? 'retired' : applied ? 'applied' : 'pending',
    required_action: prior.length > 1 ? 'review_correction' : prior.length === 1 ? 'update' : 'create',
    ...(prior.length === 1 ? { prior_application: prior[0] } : {}),
    ...(prior.length > 1 ? { correction_ambiguous: true } : {}),
  };
}

async function artifactPages(engine: BrainEngine, sourceId: string): Promise<Array<{
  slug: string;
  artifact: SourceEventArtifact;
}>> {
  const rows = await engine.executeRaw<{ slug: string; compiled_truth: string }>(
    `SELECT slug,COALESCE(compiled_truth,'') AS compiled_truth
       FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL
        AND COALESCE(frontmatter->>'source_event_artifact','')='true'`,
    [sourceId],
  );
  return rows.flatMap((row) => {
    const artifact = parseSourceEventArtifact(row.compiled_truth);
    return artifact && artifact.source.source_id === sourceId ? [{ slug: row.slug, artifact }] : [];
  });
}

async function targetHash(engine: BrainEngine, sourceId: string, slug: string): Promise<string | undefined> {
  const target = await resolvePageWriteTarget(engine, slug, sourceId);
  if (!target.ok || !existsSync(target.filePath)) return undefined;
  return hashText(readFileSync(target.filePath));
}

export async function listCompiledTruthCandidates(
  engine: BrainEngine,
  input: { sourceId: string; includeDecided?: boolean; limit?: number },
): Promise<CompiledTruthCandidate[]> {
  const source = await fetchSource(engine, input.sourceId);
  if (!source) throw new Error(`source-event compiled truth: source '${input.sourceId}' is not registered`);
  assertSourceEventAdmission(await readSourceEventPolicy(engine), source);
  const results: CompiledTruthCandidate[] = [];
  for (const { artifact } of await artifactPages(engine, input.sourceId)) {
    if (artifact.state === 'retracted') continue;
    if (!artifact.active_revision_id) continue;
    const revision = artifact.revisions.find((row) =>
      row.revision_id === artifact.active_revision_id && row.state === 'active');
    if (!revision) continue;
    for (const raw of revision.compiled_truth_candidates ?? []) {
      const candidate = asCandidate(artifact, revision, raw);
      if (!candidate) continue;
      if (!input.includeDecided && !['pending', 'approved_pending', 'rejected_pending'].includes(candidate.review_state)) continue;
      results.push(candidate);
    }
  }
  results.sort((a, b) =>
    b.source_date.localeCompare(a.source_date)
      || a.target_slug.localeCompare(b.target_slug)
      || a.candidate_id.localeCompare(b.candidate_id));
  const limited = results.slice(0, Math.max(1, Math.min(input.limit ?? 100, 1000)));
  await Promise.all(limited.map(async (candidate) => {
    candidate.target_hash = await targetHash(engine, input.sourceId, candidate.target_slug);
  }));
  return limited;
}

export async function listSourceEventTaskCandidates(
  engine: BrainEngine,
  input: { sourceId: string; includeApplied?: boolean; limit?: number },
): Promise<SourceEventTaskCandidate[]> {
  const source = await fetchSource(engine, input.sourceId);
  if (!source) throw new Error(`source-event task: source '${input.sourceId}' is not registered`);
  assertSourceEventAdmission(await readSourceEventPolicy(engine), source);
  const results: SourceEventTaskCandidate[] = [];
  for (const { artifact } of await artifactPages(engine, input.sourceId)) {
    if (artifact.state === 'retracted') {
      // A correction updates the same canonical task but leaves the older
      // revision's application receipt as audit evidence. Retire only the
      // latest application for each task_id; surfacing every historical
      // receipt would first offer a stale task hash and then duplicate the
      // retirement request.
      const latestByTask = new Map<string, {
        revision: SourceEventRevisionRecord;
        raw: Record<string, unknown>;
      }>();
      for (const revision of artifact.revisions) {
        for (const raw of revision.action_candidates ?? []) {
          const candidate = asTaskCandidate(artifact, revision, raw);
          if (!candidate || !['applied', 'retired'].includes(candidate.review_state)) continue;
          const application = raw.application as Record<string, unknown>;
          latestByTask.set(asString(application.task_id) || candidate.candidate_id, { revision, raw });
        }
      }
      for (const { revision, raw } of latestByTask.values()) {
        const candidate = asTaskCandidate(artifact, revision, raw);
        if (!candidate || candidate.review_state !== 'applied') continue;
        results.push({
          ...candidate,
          review_state: 'retirement_pending',
          required_action: 'retire',
          prior_application: raw.application as Record<string, unknown>,
        });
      }
      continue;
    }
    if (artifact.state !== 'active' || !artifact.active_revision_id) continue;
    const revision = artifact.revisions.find((row) =>
      row.revision_id === artifact.active_revision_id && row.state === 'active');
    if (!revision) continue;
    for (const raw of revision.action_candidates ?? []) {
      const candidate = asTaskCandidate(artifact, revision, raw);
      if (!candidate || (!input.includeApplied && candidate.review_state === 'applied')) continue;
      results.push(candidate);
    }
  }
  results.sort((a, b) => b.source_date.localeCompare(a.source_date) || a.candidate_id.localeCompare(b.candidate_id));
  return results.slice(0, Math.max(1, Math.min(input.limit ?? 100, 1000)));
}

export async function recordSourceEventTaskApplication(
  engine: BrainEngine,
  input: {
    sourceId: string;
    eventId: string;
    revisionId: string;
    candidateId: string;
    reviewer: string;
    application: { receipt_id: string; task_id: string; task_path: string; task_hash: string; operation: string };
    disposition?: 'applied' | 'retired';
  },
  deps: { verifyApplication?: (application: typeof input.application) => Promise<void> } = {},
): Promise<{ status: 'recorded' | 'already_recorded'; candidate_id: string }> {
  const source = await fetchSource(engine, input.sourceId);
  if (!source) throw new Error(`source-event task: source '${input.sourceId}' is not registered`);
  assertSourceEventAdmission(await readSourceEventPolicy(engine), source);
  for (const value of [input.reviewer, input.application.receipt_id, input.application.task_id,
    input.application.task_path, input.application.task_hash, input.application.operation]) {
    if (!value.trim()) throw new Error('source-event task: complete application receipt is required');
  }
  if (!/^[0-9a-f]{64}$/.test(input.application.task_hash)) {
    throw new Error('source-event task: task_hash must be SHA-256');
  }
  await (deps.verifyApplication ?? verifyTaskApplicationReceipt)(input.application);
  const artifactSlug = `source-events/${input.eventId}`;
  return withSourceProjectionLock(engine, input.sourceId, () => withPageLock(artifactSlug, async () => {
    const artifact = await loadSourceEventArtifact(engine, input.sourceId, artifactSlug, { includeUncommitted: true });
    if (!artifact) throw new Error('source-event task: artifact not found');
    const disposition = input.disposition ?? 'applied';
    if (disposition === 'applied'
        && (artifact.state !== 'active' || artifact.active_revision_id !== input.revisionId)) {
      throw new Error('source-event task: active artifact revision not found');
    }
    const revision = artifact.revisions.find((row) => row.revision_id === input.revisionId
      && (disposition === 'retired' || row.state === 'active'));
    const raw = revision?.action_candidates.find((candidate) => asString(candidate.candidate_id) === input.candidateId);
    if (!revision || !raw) throw new Error('source-event task: candidate not found');
    const candidate = asTaskCandidate(artifact, revision, raw);
    if (!candidate?.source_date_attested) throw new Error('source-event task: attested source date is required');
    const applicationField = disposition === 'retired' ? 'retirement_application' : 'application';
    const terminalState = disposition === 'retired' ? 'retired' : 'applied';
    if (raw.review_state === terminalState) {
      if (JSON.stringify(raw[applicationField]) !== JSON.stringify(input.application)) {
        throw new Error('source-event task: candidate already recorded with another application');
      }
      return { status: 'already_recorded', candidate_id: input.candidateId };
    }
    if (disposition === 'retired' && raw.review_state !== 'applied') {
      throw new Error('source-event task: only an applied task can be retired');
    }
    raw.review_state = terminalState;
    raw.reviewed_at = new Date().toISOString();
    raw.reviewer = input.reviewer.trim();
    raw[applicationField] = input.application;
    await persistSourceEventArtifact(engine, { sourceId: input.sourceId, artifactSlug, artifact });
    return { status: 'recorded', candidate_id: input.candidateId };
  }, { timeoutMs: 5_000 }));
}

async function verifyTaskApplicationReceipt(application: {
  receipt_id: string; task_id: string; task_path: string; task_hash: string; operation: string;
}): Promise<void> {
  const stateRoot = resolve(process.env.VAULT_PERSONAL_OS_STATE_DIR
    ?? '/srv/gbrain-clean/state/vault-personal-os');
  const vaultRoot = resolve(process.env.VAULT_BRAIN_ROOT ?? '/srv/vault-brain');
  const receiptPath = join(stateRoot, 'receipts', `${hashText(application.receipt_id)}.json`);
  if (!existsSync(receiptPath)) throw new Error('source-event task: kernel receipt is unavailable');
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('source-event task: kernel receipt is invalid');
  }
  const adapter = receipt.adapter && typeof receipt.adapter === 'object'
    ? receipt.adapter as Record<string, unknown>
    : {};
  if (receipt.state !== 'applied'
      || receipt.idempotency_key !== application.receipt_id
      || receipt.path !== application.task_path
      || receipt.source_hash !== application.task_hash
      || adapter.task_id !== application.task_id
      || adapter.operation !== application.operation) {
    throw new Error('source-event task: kernel receipt does not match the application');
  }
  const taskRoot = resolve(vaultRoot, 'ops', 'tasks');
  const taskPath = resolve(vaultRoot, application.task_path);
  if (!(taskPath === taskRoot || taskPath.startsWith(`${taskRoot}${sep}`)) || !existsSync(taskPath)) {
    throw new Error('source-event task: canonical task record is unavailable');
  }
  if (hashText(readFileSync(taskPath)) !== application.task_hash) {
    throw new Error('source-event task: canonical task hash does not match the kernel receipt');
  }
}

function sanitizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 1200)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function renderBlock(candidates: CompiledTruthCandidate[]): string {
  const lines = candidates
    .sort((a, b) => b.source_date.localeCompare(a.source_date) || a.candidate_id.localeCompare(b.candidate_id))
    .map((candidate) =>
      `- ${candidate.source_date} - ${sanitizeLine(candidate.text)} ` +
      `<!-- ${CANDIDATE_MARKER}:${candidate.candidate_id} -->`);
  return `${BLOCK_BEGIN}\n\n## Sourced updates\n\n${lines.join('\n')}\n\n${BLOCK_END}`;
}

function markerCount(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/** Pure, byte-local splice used by the public application seam and tests. */
export function replaceCompiledTruthBlock(fileText: string, candidates: CompiledTruthCandidate[]): string {
  const begins = markerCount(fileText, BLOCK_BEGIN);
  const ends = markerCount(fileText, BLOCK_END);
  if (begins !== ends || begins > 1) {
    throw new Error('source-event compiled truth: malformed owned block');
  }
  let base = fileText;
  if (begins === 1) {
    const start = base.indexOf(BLOCK_BEGIN);
    const end = base.indexOf(BLOCK_END, start) + BLOCK_END.length;
    if (candidates.length > 0 && base.slice(start, end) === renderBlock(candidates)) {
      return fileText;
    }
    base = base.slice(0, start) + base.slice(end);
  }
  if (candidates.length === 0) return base;

  const block = renderBlock(candidates);
  const factsMarker = base.indexOf('<!--- gbrain:facts:begin -->');
  let insertAt = factsMarker;
  if (factsMarker >= 0) {
    const heading = base.lastIndexOf('\n## Facts', factsMarker);
    if (heading >= 0) insertAt = heading + 1;
  }
  if (insertAt < 0) {
    const timeline = base.indexOf('<!-- timeline -->');
    insertAt = timeline >= 0 ? timeline : base.length;
  }
  const before = base.slice(0, insertAt).replace(/\s+$/, '');
  const after = base.slice(insertAt).replace(/^\s+/, '');
  return `${before}\n\n${block}${after ? `\n\n${after}` : '\n'}`;
}

async function activeApprovedForTarget(
  engine: BrainEngine,
  sourceId: string,
  targetSlug: string,
): Promise<CompiledTruthCandidate[]> {
  const approved: CompiledTruthCandidate[] = [];
  for (const { artifact } of await artifactPages(engine, sourceId)) {
    if (artifact.state !== 'active' || !artifact.active_revision_id) continue;
    const revision = artifact.revisions.find((row) =>
      row.revision_id === artifact.active_revision_id && row.state === 'active');
    if (!revision) continue;
    for (const raw of revision.compiled_truth_candidates ?? []) {
      const candidate = asCandidate(artifact, revision, raw);
      if (!candidate || candidate.target_slug !== targetSlug) continue;
      if (candidate.review_state === 'approved' || candidate.review_state === 'approved_pending') {
        approved.push(candidate);
      }
    }
  }
  return approved;
}

async function reconcileOneLocked(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  expectedHash?: string,
): Promise<string> {
  const page = await engine.getPage(slug, { sourceId });
  if (!page) throw new Error(`source-event compiled truth: target '${slug}' is missing`);
  const linkable = new Set(await resolveLinkableEntityTypes(engine));
  if (linkable.size === 0) throw new Error('source-event compiled truth: active schema pack unavailable or has no linkable types');
  if (!linkable.has(page.type)) {
    throw new Error(`source-event compiled truth: target type '${page.type}' is not linkable in the active schema pack`);
  }
  const target = await resolvePageWriteTarget(engine, slug, sourceId);
  if (!target.ok || !existsSync(target.filePath)) {
    throw new Error(`source-event compiled truth: canonical target unavailable for '${slug}'`);
  }
  const before = readFileSync(target.filePath, 'utf8');
  const beforeHash = hashText(before);
  if (expectedHash && expectedHash !== beforeHash) {
    throw new Error(`source-event compiled truth: target changed (expected ${expectedHash}, found ${beforeHash})`);
  }
  const beforeFacts = parseFactsFence(before);
  if (beforeFacts.warnings.length > 0) {
    throw new Error(`source-event compiled truth: malformed Facts fence (${beforeFacts.warnings.join('; ')})`);
  }
  const frontmatterEnd = frontmatterBodyOffset(before);
  const frontmatter = before.slice(0, frontmatterEnd);
  const activePack = await loadActivePackForLocalEngine(engine);
  if (!activePack) {
    throw new Error('source-event compiled truth: active schema pack is unavailable');
  }
  const packShape = { page_types: activePack.manifest.page_types };
  const candidates = await activeApprovedForTarget(engine, sourceId, slug);
  const after = replaceCompiledTruthBlock(before, candidates);
  if (after !== before) {
    const afterFacts = parseFactsFence(after);
    if (afterFacts.warnings.length > 0 || JSON.stringify(afterFacts.facts) !== JSON.stringify(beforeFacts.facts)) {
      throw new Error('source-event compiled truth: Facts fence changed during projection');
    }
    if (after.slice(0, frontmatterEnd) !== frontmatter) {
      throw new Error('source-event compiled truth: frontmatter changed during projection');
    }
    const parsed = parseMarkdown(after, `${slug}.md`, {
      validate: true, expectedSlug: slug, activePack: packShape,
    });
    if ((parsed.errors ?? []).length > 0) {
      throw new Error(`source-event compiled truth: projected markdown is invalid (${parsed.errors!.map((e) => e.code).join(',')})`);
    }
    atomicWriteFileSync(target.filePath, after, {
      verify: (written) => {
        if (written !== after) throw new Error('source-event compiled truth: atomic verify failed');
      },
    });
    // Re-enter upstream's canonical import seam after the filesystem write.
    // This refreshes content_hash, versions and keyword chunks together.
    // Embeddings are deliberately deferred: chunks land stale and the
    // existing Autopilot embed phase remains the single backfill owner.
    const imported = await importFromContent(engine, slug, after, {
      sourceId,
      sourcePath: target.sourcePathToBind,
      activePack: packShape,
      noEmbed: true,
    });
    if (imported.status === 'error' || imported.status === 'skipped' && imported.error) {
      throw new Error(
        `source-event compiled truth: canonical reindex failed for '${slug}' (${imported.error ?? imported.status})`,
      );
    }
    const readBack = await engine.getPage(slug, { sourceId });
    if (!readBack || readBack.compiled_truth !== parsed.compiled_truth) {
      throw new Error(`source-event compiled truth: target '${slug}' failed indexed readback`);
    }
  }
  return hashText(after);
}

export async function reconcileCompiledTruthForTargets(
  engine: BrainEngine,
  sourceId: string,
  targetSlugs: string[],
): Promise<void> {
  for (const slug of [...new Set(targetSlugs)].sort()) {
    // Ordinary projection targets have no owned block until a reviewer
    // approves a candidate. Do not turn safe relationship/fact projection
    // into a filesystem requirement for DB-only pages.
    const approved = await activeApprovedForTarget(engine, sourceId, slug);
    const target = await resolvePageWriteTarget(engine, slug, sourceId);
    const hasOwnedBlock = target.ok && existsSync(target.filePath)
      && readFileSync(target.filePath, 'utf8').includes(BLOCK_BEGIN);
    if (approved.length === 0 && !hasOwnedBlock) continue;
    await withPageLock(slug, () => reconcileOneLocked(engine, sourceId, slug), { timeoutMs: 5_000 });
  }
}

function rawCandidate(revision: SourceEventRevisionRecord, candidateId: string): Record<string, unknown> | undefined {
  return (revision.compiled_truth_candidates ?? []).find((candidate) =>
    asString(candidate.candidate_id) === candidateId);
}

export async function reviewCompiledTruthCandidate(
  engine: BrainEngine,
  input: ReviewCompiledTruthInput,
): Promise<ReviewCompiledTruthResult> {
  if (!input.reviewer.trim()) throw new Error('source-event compiled truth: reviewer is required');
  const source = await fetchSource(engine, input.sourceId);
  if (!source) throw new Error(`source-event compiled truth: source '${input.sourceId}' is not registered`);
  assertSourceEventAdmission(await readSourceEventPolicy(engine), source);
  const artifactSlug = `source-events/${input.eventId}`;
  return withSourceProjectionLock(engine, input.sourceId, () => withPageLock(artifactSlug, async () => {
    const artifact = await loadSourceEventArtifact(engine, input.sourceId, artifactSlug);
    if (!artifact || artifact.event_id !== input.eventId || artifact.state !== 'active') {
      throw new Error('source-event compiled truth: active artifact not found');
    }
    if (artifact.active_revision_id !== input.revisionId) {
      throw new Error('source-event compiled truth: candidate revision is not active');
    }
    const revision = artifact.revisions.find((row) =>
      row.revision_id === input.revisionId && row.state === 'active');
    if (!revision) throw new Error('source-event compiled truth: active revision not found');
    const raw = rawCandidate(revision, input.candidateId);
    if (!raw) throw new Error('source-event compiled truth: candidate not found');
    const candidate = asCandidate(artifact, revision, raw);
    if (!candidate) throw new Error('source-event compiled truth: malformed candidate');
    if (!candidate.source_date_attested && input.decision === 'approve') {
      throw new Error('source-event compiled truth: approval requires an attested source date');
    }
    if (input.decision === 'approve' && !/^[0-9a-f]{64}$/.test(input.expectedTargetHash ?? '')) {
      throw new Error('source-event compiled truth: approval requires the current target SHA-256');
    }

    const prior = candidate.review_state;
    if (input.decision === 'reject' && prior === 'rejected') {
      const hash = await targetHash(engine, input.sourceId, candidate.target_slug);
      if (!hash) throw new Error('source-event compiled truth: canonical target unavailable');
      return { status: 'already_rejected', candidate_id: candidate.candidate_id, target_slug: candidate.target_slug, target_hash: hash };
    }

    return withPageLock(candidate.target_slug, async () => {
      const canonical = await resolvePageWriteTarget(engine, candidate.target_slug, input.sourceId);
      if (!canonical.ok || !existsSync(canonical.filePath)) {
        throw new Error('source-event compiled truth: canonical target unavailable');
      }
      const currentHash = hashText(readFileSync(canonical.filePath));
      if (input.decision === 'approve' && input.expectedTargetHash !== currentHash) {
        throw new Error(`source-event compiled truth: target changed (expected ${input.expectedTargetHash}, found ${currentHash})`);
      }

      raw.review_state = input.decision === 'approve' ? 'approved_pending' : 'rejected_pending';
      raw.reviewed_at = new Date().toISOString();
      raw.reviewer = input.reviewer.trim();
      await persistSourceEventArtifact(engine, { sourceId: input.sourceId, artifactSlug, artifact });
      const appliedHash = await reconcileOneLocked(engine, input.sourceId, candidate.target_slug, currentHash);
      raw.review_state = input.decision === 'approve' ? 'approved' : 'rejected';
      if (input.decision === 'approve') raw.applied_target_hash = appliedHash;
      await persistSourceEventArtifact(engine, { sourceId: input.sourceId, artifactSlug, artifact });
      return {
        status: input.decision === 'reject'
          ? 'rejected'
          : prior === 'approved' ? 'already_applied' : 'applied',
        candidate_id: candidate.candidate_id,
        target_slug: candidate.target_slug,
        target_hash: appliedHash,
      };
    }, { timeoutMs: 5_000 });
  }, { timeoutMs: 5_000 }));
}
