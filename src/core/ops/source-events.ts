/** Trusted-local review surface for source-event compiled-truth candidates. */

import type { Operation } from './contract.ts';
import { OperationError } from './contract.ts';
import {
  listCompiledTruthCandidates,
  listSourceEventTaskCandidates,
  recordSourceEventTaskApplication,
  reviewCompiledTruthCandidate,
} from '../source-events/compiled-projection.ts';

function localOnly(remote: boolean | undefined): void {
  if (remote !== false) {
    throw new OperationError(
      'permission_denied',
      'Source-event review is local-only. Run it on the brain host with the gbrain CLI.',
    );
  }
}

const source_event_compiled_candidates: Operation = {
  name: 'source_event_compiled_candidates',
  description: 'List private, review-first source-event candidates that can update existing entity/project compiled truth.',
  params: {
    source_id: { type: 'string', required: true, description: 'Registered source ID.' },
    include_decided: { type: 'boolean', description: 'Include approved/rejected candidates. Default false.' },
    limit: { type: 'number', description: 'Maximum candidates (1-1000). Default 100.' },
  },
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    localOnly(ctx.remote);
    return listCompiledTruthCandidates(ctx.engine, {
      sourceId: p.source_id as string,
      includeDecided: p.include_decided === true,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
    });
  },
  cliHints: { name: 'source-event-candidates' },
};

const review_source_event_compiled_candidate: Operation = {
  name: 'review_source_event_compiled_candidate',
  description: 'Approve or reject one active source-event compiled-truth candidate. Approval is page-hash guarded and preserves human prose, frontmatter and Facts.',
  params: {
    source_id: { type: 'string', required: true, description: 'Registered source ID.' },
    event_id: { type: 'string', required: true, description: 'Stable source event ID.' },
    revision_id: { type: 'string', required: true, description: 'Active immutable revision ID.' },
    candidate_id: { type: 'string', required: true, description: 'Candidate ID from source-event-candidates.' },
    decision: { type: 'string', required: true, enum: ['approve', 'reject'], description: 'Human review decision.' },
    reviewer: { type: 'string', required: true, description: 'Auditable reviewer identity.' },
    expected_target_hash: { type: 'string', description: 'Current target file SHA-256; required for approval.' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    localOnly(ctx.remote);
    if (ctx.dryRun) {
      return { status: 'planned', candidate_id: p.candidate_id, decision: p.decision };
    }
    return reviewCompiledTruthCandidate(ctx.engine, {
      sourceId: p.source_id as string,
      eventId: p.event_id as string,
      revisionId: p.revision_id as string,
      candidateId: p.candidate_id as string,
      decision: p.decision as 'approve' | 'reject',
      reviewer: p.reviewer as string,
      expectedTargetHash: p.expected_target_hash as string | undefined,
    });
  },
  cliHints: { name: 'source-event-review' },
};

const source_event_task_candidates: Operation = {
  name: 'source_event_task_candidates',
  description: 'List private review-first task candidates emitted by committed source-event revisions.',
  params: {
    source_id: { type: 'string', required: true, description: 'Registered source ID.' },
    include_applied: { type: 'boolean', description: 'Include already-applied candidates.' },
    limit: { type: 'number', description: 'Maximum candidates (1-1000).' },
  },
  scope: 'admin', localOnly: true,
  handler: async (ctx, p) => {
    localOnly(ctx.remote);
    return listSourceEventTaskCandidates(ctx.engine, {
      sourceId: p.source_id as string,
      includeApplied: p.include_applied === true,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
    });
  },
  cliHints: { name: 'source-event-task-candidates' },
};

const record_source_event_task_application: Operation = {
  name: 'record_source_event_task_application',
  description: 'Record a completed Vault Personal OS task-kernel receipt on one active source-event task candidate.',
  params: {
    source_id: { type: 'string', required: true }, event_id: { type: 'string', required: true },
    revision_id: { type: 'string', required: true }, candidate_id: { type: 'string', required: true },
    reviewer: { type: 'string', required: true }, receipt_id: { type: 'string', required: true },
    task_id: { type: 'string', required: true }, task_path: { type: 'string', required: true },
    task_hash: { type: 'string', required: true }, operation: { type: 'string', required: true },
    disposition: { type: 'string', enum: ['applied', 'retired'] },
  },
  mutating: true, scope: 'admin', localOnly: true,
  handler: async (ctx, p) => {
    localOnly(ctx.remote);
    if (ctx.dryRun) return { status: 'planned', candidate_id: p.candidate_id };
    return recordSourceEventTaskApplication(ctx.engine, {
      sourceId: p.source_id as string, eventId: p.event_id as string,
      revisionId: p.revision_id as string, candidateId: p.candidate_id as string,
      reviewer: p.reviewer as string,
      application: {
        receipt_id: p.receipt_id as string, task_id: p.task_id as string,
        task_path: p.task_path as string, task_hash: p.task_hash as string,
        operation: p.operation as string,
      },
      disposition: p.disposition === 'retired' ? 'retired' : 'applied',
    });
  },
  cliHints: { name: 'source-event-task-record' },
};

export const sourceEventOperations: Operation[] = [
  source_event_compiled_candidates,
  review_source_event_compiled_candidate,
  source_event_task_candidates,
  record_source_event_task_application,
];
