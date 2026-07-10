import type { BrainEngine } from '../engine.ts';

export const DEFAULT_USER_HOLDER = 'garry';
export const USER_HOLDER_CONFIG_KEY = 'emotional_weight.user_holder';

/**
 * Resolve the brain owner's takes holder from the existing shared setting.
 * Explicit callers win; an unset setting preserves GBrain's legacy default.
 */
export async function resolveUserHolder(
  engine: BrainEngine,
  explicitHolder?: string,
): Promise<string> {
  const explicit = explicitHolder?.trim();
  if (explicit) return explicit;

  const configured = (await engine.getConfig(USER_HOLDER_CONFIG_KEY))?.trim();
  return configured || DEFAULT_USER_HOLDER;
}
