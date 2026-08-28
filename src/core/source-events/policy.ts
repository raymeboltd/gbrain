import type { BrainEngine } from '../engine.ts';
import { isSourceAutopilotSyncEnabled } from '../sources-load.ts';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export interface SourceEventPolicy {
  enabled: boolean;
  approvedSourceIds: ReadonlySet<string>;
}

export type SourceEventAdmissionReason =
  | 'disabled'
  | 'source_unconfigured'
  | 'source_not_approved'
  | 'source_autopilot_disabled';

export async function readSourceEventPolicy(engine: BrainEngine): Promise<SourceEventPolicy> {
  const enabledRaw = (await engine.getConfig('source_events.enabled'))?.trim().toLowerCase();
  const approvedRaw = (await engine.getConfig('source_events.source_ids'))?.trim();
  return {
    enabled: enabledRaw !== undefined && TRUE_VALUES.has(enabledRaw),
    approvedSourceIds: new Set((approvedRaw ?? '').split(',').map((id) => id.trim()).filter(Boolean)),
  };
}

export function sourceEventAdmissionReason(
  policy: SourceEventPolicy,
  source: { id: string; config: unknown },
): SourceEventAdmissionReason | null {
  if (!policy.enabled) return 'disabled';
  if (policy.approvedSourceIds.size === 0) return 'source_unconfigured';
  if (!policy.approvedSourceIds.has(source.id)) return 'source_not_approved';
  if (!isSourceAutopilotSyncEnabled(source.config)) return 'source_autopilot_disabled';
  return null;
}

export function assertSourceEventAdmission(
  policy: SourceEventPolicy,
  source: { id: string; config: unknown },
): void {
  const reason = sourceEventAdmissionReason(policy, source);
  if (!reason) return;
  throw new Error(`source-event-projection: source '${source.id}' denied by policy (${reason})`);
}
