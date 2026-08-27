// Pack-driven entity mention linking.
//
// `linkable` is intentionally explicit instead of being inferred from the
// primitive. Primitive describes shape/defaults; linkability is a mutation
// policy with privacy and false-positive consequences.

import type { SchemaPackManifest } from './manifest-v1.ts';

/**
 * Pre-field compatibility only. Existing packs keep the exact v1 behavior
 * until their type records declare `linkable`; newly-authored types are not
 * silently opted in just because their primitive is `entity`.
 */
export const LEGACY_LINKABLE_ENTITY_TYPES = [
  'person',
  'company',
  'organization',
  'entity',
  'project',
  'deal',
  'goal',
] as const;

const LEGACY_LINKABLE = new Set<string>(LEGACY_LINKABLE_ENTITY_TYPES);

/** Resolve mention-link targets in manifest order. Explicit true/false wins. */
export function linkableTypesFromPack(
  pack: Pick<SchemaPackManifest, 'page_types'>,
): string[] {
  return pack.page_types
    .filter((pageType) => pageType.linkable ?? LEGACY_LINKABLE.has(pageType.name))
    .map((pageType) => pageType.name);
}
