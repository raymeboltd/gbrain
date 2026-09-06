import { createHash } from 'node:crypto';
import type { ResolvedColumn } from '../types.ts';
import { assertTouchpoint, embeddingDimsForModel, resolveRecipe } from '../ai/model-resolver.ts';

export const LOCAL_TEXT_SPACE = 'local-bge-m3-1024-v1' as const;
export type ContentLane = 'chunks' | 'facts' | 'takes';
export type SpaceLane = ContentLane | 'cache';
export interface SpaceStorage {
  readonly table: string;
  readonly vector: Readonly<ResolvedColumn>;
  readonly embeddedAt: string;
  readonly inputHash: string;
  readonly signature: string;
}
export interface LocalTextSpace {
  readonly id: typeof LOCAL_TEXT_SPACE;
  readonly model: string;
  readonly dimensions: 1024;
  readonly spaceSignature: string;
  readonly endpoint: string;
  readonly transport: { readonly redirect: 'error'; readonly fallback: 'none'; readonly loopbackOnly: true };
  readonly storage: Readonly<Record<SpaceLane, SpaceStorage>>;
}
export interface LocalTextSpaceInput {
  spaceId: typeof LOCAL_TEXT_SPACE;
  model: string;
  dimensions: 1024;
  endpoint: string;
}

/** Pure validation only: the transport adapter must enforce this policy at dispatch. */
export function resolveLocalTextSpace(input: LocalTextSpaceInput): LocalTextSpace {
  if (!input || Object.keys(input).some(k => !['spaceId', 'model', 'dimensions', 'endpoint'].includes(k))) {
    throw new Error('Invalid local text-space descriptor fields');
  }
  if (input.spaceId !== LOCAL_TEXT_SPACE || input.dimensions !== 1024) throw new Error('Unsupported text space or dimensions');
  if (typeof input.model !== 'string' || !/^(ollama|llama-server|lmstudio):bge-m3$/.test(input.model)) {
    throw new Error('Local text space requires a supported native BGE-M3 model');
  }
  const { recipe, parsed } = resolveRecipe(input.model);
  assertTouchpoint(recipe, 'embedding', parsed.modelId);
  const knownWidth = embeddingDimsForModel(recipe, parsed.modelId);
  if (knownWidth !== 0 && knownWidth !== 1024) throw new Error('Native recipe dimensions conflict with text space');
  if (typeof input.endpoint !== 'string') throw new Error('Invalid local embedding endpoint');
  let url: URL;
  try { url = new URL(input.endpoint); } catch { throw new Error('Invalid local embedding endpoint'); }
  const paths = recipe.id === 'ollama' ? ['/', '/api', '/api/'] : ['/', '/v1', '/v1/'];
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !paths.includes(url.pathname)) {
    throw new Error('Embedding endpoint must be credential-free loopback without query or fragment');
  }
  const binding = (lane: SpaceLane): SpaceStorage => {
    const cache = lane === 'cache';
    return Object.freeze({
      table: cache ? 'query_cache_bge_m3_1024' : lane === 'chunks' ? 'content_chunks' : lane,
      vector: Object.freeze({ name: cache ? 'embedding' : 'embedding_bge_m3_1024', type: 'vector' as const,
        dimensions: 1024, embeddingModel: input.model }),
      embeddedAt: cache ? 'embedded_at' : 'embedding_bge_m3_1024_at',
      inputHash: cache ? 'input_hash' : 'embedding_bge_m3_1024_hash',
      signature: cache ? 'space_signature' : 'embedding_bge_m3_1024_signature',
    });
  };
  return Object.freeze({ id: LOCAL_TEXT_SPACE, model: input.model, dimensions: 1024,
    spaceSignature: createHash('sha256').update(JSON.stringify([LOCAL_TEXT_SPACE, input.model, 1024, url.href])).digest('hex'),
    endpoint: url.href, transport: Object.freeze({ redirect: 'error', fallback: 'none', loopbackOnly: true }),
    storage: Object.freeze({ chunks: binding('chunks'), facts: binding('facts'), takes: binding('takes'), cache: binding('cache') }),
  });
}
