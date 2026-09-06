import { createHash } from 'node:crypto';
import { resolveLocalTextSpace, type LocalTextSpaceInput, type LocalTextSpace, type ContentLane } from './descriptor.ts';

export interface ContentBinding {
  readonly lane: ContentLane;
  readonly sourceId: string;
  /** Decimal strings avoid bigint precision loss in JSON and SQL parameters. */
  readonly recordId: string;
  readonly pageId: string;
  readonly inputHash: string;
  readonly pageGeneration: string;
  /** Required for facts; both owners must resolve to the admitted page. */
  readonly canonicalPageId?: string;
  readonly entityPageId?: string;
}
export interface ScopeInput {
  readonly brainId: string;
  readonly revision: string;
  readonly manifestHash: string;
  readonly acceptanceReceiptHash: string;
  readonly grants: readonly ContentBinding[];
  readonly deniedPages: readonly { readonly sourceId: string; readonly pageId: string }[];
}
export interface EmbeddingContext {
  readonly space: LocalTextSpace;
  readonly scope: ScopeInput;
  readonly cacheNamespace: string;
}
const minted = new WeakSet<object>();
const SHA256 = /^[0-9a-f]{64}$/;
const isHash = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value);
const ID = /^[1-9][0-9]*$/;
const MAX_ID = 9223372036854775807n;
const lanes: readonly ContentLane[] = ['chunks', 'facts', 'takes'];
function fail(): never { throw new Error('Invalid or conflicting embedding eligibility metadata'); }
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) fail();
}
function decimal(value: unknown, zero = false): asserts value is string {
  if (typeof value !== 'string' || !(zero && value === '0') && !ID.test(value)) fail();
  if (BigInt(value) > MAX_ID) fail();
}
function binding(input: ContentBinding): ContentBinding {
  if (!input || !lanes.includes(input.lane)) fail();
  identifier(input.sourceId); decimal(input.recordId); decimal(input.pageId); decimal(input.pageGeneration, true);
  if (!isHash(input.inputHash)) fail();
  if (input.lane === 'facts') {
    if (input.canonicalPageId !== input.pageId || input.entityPageId !== input.pageId) fail();
  } else if (input.canonicalPageId !== undefined || input.entityPageId !== undefined) fail();
  return Object.freeze({ lane: input.lane, sourceId: input.sourceId, recordId: input.recordId,
    pageId: input.pageId, inputHash: input.inputHash, pageGeneration: input.pageGeneration,
    ...(input.lane === 'facts' ? { canonicalPageId: input.canonicalPageId, entityPageId: input.entityPageId } : {}),
  });
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const pageKey = (x: { sourceId: string; pageId: string }) => JSON.stringify([x.sourceId, x.pageId]);
const recordKey = (x: ContentBinding) => JSON.stringify([x.lane, x.sourceId, x.recordId]);
function checkContext(context: EmbeddingContext, brainId: string): void {
  if (!minted.has(context) || context.scope.brainId !== brainId) throw new Error('Embedding context or brain binding mismatch');
}

/** Absence is a no-op for legacy callers. This constructor does not authenticate grants. */
export function resolveEmbeddingContext(input?: { strict: true; space: LocalTextSpaceInput; scope: ScopeInput }): EmbeddingContext | null {
  if (input === undefined) return null;
  if (input.strict !== true || !input.scope) fail();
  const space = resolveLocalTextSpace(input.space), scope = input.scope;
  identifier(scope.brainId); identifier(scope.revision);
  if (!isHash(scope.manifestHash) || !isHash(scope.acceptanceReceiptHash)
      || !Array.isArray(scope.grants) || !Array.isArray(scope.deniedPages) || scope.grants.length > 10000 || scope.deniedPages.length > 10000) fail();
  const denied = scope.deniedPages.map(p => {
    identifier(p.sourceId); decimal(p.pageId);
    return Object.freeze({ sourceId: p.sourceId, pageId: p.pageId });
  });
  const deniedKeys = new Set(denied.map(pageKey)), seen = new Set<string>();
  const pageSources = new Map<string, string>(), generations = new Map<string, string>();
  for (const row of denied) {
    if (pageSources.has(row.pageId) && pageSources.get(row.pageId) !== row.sourceId) fail();
    pageSources.set(row.pageId, row.sourceId);
  }
  const grants = scope.grants.map(g => {
    const row = binding(g), key = JSON.stringify([row.lane, row.recordId]);
    if (pageSources.has(row.pageId) && pageSources.get(row.pageId) !== row.sourceId) fail();
    if (generations.has(row.pageId) && generations.get(row.pageId) !== row.pageGeneration) fail();
    pageSources.set(row.pageId, row.sourceId); generations.set(row.pageId, row.pageGeneration);
    // Duplicate identities, including conflicting hash/owner grants, invalidate the scope.
    if (seen.has(key) || deniedKeys.has(pageKey(row))) fail();
    seen.add(key); return row;
  }).sort((a, b) => compare(recordKey(a), recordKey(b)));
  const frozenScope = Object.freeze({ brainId: scope.brainId, revision: scope.revision,
    manifestHash: scope.manifestHash, acceptanceReceiptHash: scope.acceptanceReceiptHash,
    grants: Object.freeze(grants), deniedPages: Object.freeze(denied.sort((a, b) => compare(pageKey(a), pageKey(b)))),
  });
  // Include exact membership as well as the asserted external manifest identity.
  const cacheNamespace = createHash('sha256').update(JSON.stringify({ space, scope: frozenScope })).digest('hex');
  const context = Object.freeze({ space, scope: frozenScope, cacheNamespace });
  minted.add(context); return context;
}

export function assertScopeBinding(context: EmbeddingContext, observed: { brainId: string; revision: string; manifestHash: string }): void {
  checkContext(context, observed.brainId);
  if (context.scope.revision !== observed.revision || context.scope.manifestHash !== observed.manifestHash) {
    throw new Error('Embedding scope changed; stop before content selection or dispatch');
  }
}

/** Metadata only. Adapters must also apply native active/pending/visibility predicates. */
export function admitsContent(context: EmbeddingContext, brainId: string, candidate: ContentBinding): boolean {
  checkContext(context, brainId);
  let row: ContentBinding;
  try { row = binding(candidate); } catch { return false; }
  return context.scope.grants.some(g => recordKey(g) === recordKey(row) && pageKey(g) === pageKey(row)
    && g.inputHash === row.inputHash && g.pageGeneration === row.pageGeneration);
}

export interface EligibilityPredicate { readonly text: string; readonly params: readonly string[]; }
/**
 * Parameterized predicate for a code-owned metadata relation named `candidate`.
 * No table/body access occurs here. Stage-2 adapters must construct that relation
 * and AND native lifecycle filters BEFORE projecting any body/claim/vector.
 */
export function eligibilityPredicate(context: EmbeddingContext, brainId: string, lane: ContentLane, firstParameter = 1): EligibilityPredicate {
  checkContext(context, brainId);
  if (!lanes.includes(lane) || !Number.isSafeInteger(firstParameter) || firstParameter < 1) fail();
  const grants = context.scope.grants.filter(g => g.lane === lane);
  if (!grants.length) return Object.freeze({ text: 'FALSE', params: Object.freeze([]) });
  if (firstParameter + grants.length * 5 - 1 > 65535) fail();
  const params: string[] = [];
  const tuples = grants.map(g => {
    const n = firstParameter + params.length;
    params.push(g.sourceId, g.recordId, g.pageId, g.inputHash, g.pageGeneration);
    return `($${n}::text,$${n + 1}::bigint,$${n + 2}::bigint,$${n + 3}::text,$${n + 4}::bigint)`;
  });
  const owner = lane === 'facts' ? ' AND candidate.canonical_page_id=candidate.page_id AND candidate.entity_page_id=candidate.page_id' : '';
  return Object.freeze({ text: `((candidate.source_id,candidate.record_id,candidate.page_id,candidate.input_hash,candidate.page_generation) IN (${tuples.join(',')})${owner})`,
    params: Object.freeze(params) });
}
