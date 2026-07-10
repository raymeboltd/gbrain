// Bun only includes non-code assets in compiled binaries when they are
// referenced through an ESM `type: file` import. Keep this registry as the
// single source of truth for every bundled schema-pack consumer.

// @ts-ignore -- Bun ESM asset import; resolves to a runtime-readable path.
import gbrainBase from './gbrain-base.yaml' with { type: 'file' };
// @ts-ignore -- Bun ESM asset import; resolves to a runtime-readable path.
import gbrainRecommended from './gbrain-recommended.yaml' with { type: 'file' };
// @ts-ignore -- Bun ESM asset import; resolves to a runtime-readable path.
import gbrainCreator from './gbrain-creator.yaml' with { type: 'file' };
// @ts-ignore -- Bun ESM asset import; resolves to a runtime-readable path.
import gbrainInvestor from './gbrain-investor.yaml' with { type: 'file' };
// @ts-ignore -- Bun ESM asset import; resolves to a runtime-readable path.
import gbrainEngineer from './gbrain-engineer.yaml' with { type: 'file' };
// @ts-ignore -- Bun ESM asset import; resolves to a runtime-readable path.
import gbrainEverything from './gbrain-everything.yaml' with { type: 'file' };
// @ts-ignore -- Bun ESM asset import; resolves to a runtime-readable path.
import gbrainBaseV2 from './gbrain-base-v2.yaml' with { type: 'file' };

export const BUNDLED_SCHEMA_PACK_PATHS: Readonly<Record<string, string>> = Object.freeze({
  'gbrain-base': gbrainBase as unknown as string,
  'gbrain-recommended': gbrainRecommended as unknown as string,
  'gbrain-creator': gbrainCreator as unknown as string,
  'gbrain-investor': gbrainInvestor as unknown as string,
  'gbrain-engineer': gbrainEngineer as unknown as string,
  'gbrain-everything': gbrainEverything as unknown as string,
  'gbrain-base-v2': gbrainBaseV2 as unknown as string,
});

export const BUNDLED_SCHEMA_PACK_NAMES = Object.freeze(
  Object.keys(BUNDLED_SCHEMA_PACK_PATHS),
);

export function bundledSchemaPackPath(name: string): string | null {
  return BUNDLED_SCHEMA_PACK_PATHS[name] ?? null;
}
