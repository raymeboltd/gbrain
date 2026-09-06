import { describe, expect, test } from 'bun:test';
import { LOCAL_TEXT_SPACE, resolveLocalTextSpace, type LocalTextSpaceInput } from '../src/core/embedding-space/descriptor.ts';
import { resolveEmbeddingContext, admitsContent, assertScopeBinding, eligibilityPredicate, type ContentBinding, type ScopeInput } from '../src/core/embedding-space/eligibility.ts';
const hash = 'a'.repeat(64), otherHash = 'b'.repeat(64);
const space = (): LocalTextSpaceInput => ({ spaceId: LOCAL_TEXT_SPACE, model: 'llama-server:bge-m3', dimensions: 1024, endpoint: 'http://127.0.0.1:18084/v1' });
const fact = (): ContentBinding => ({ lane: 'facts', sourceId: 'source-a', recordId: '9007199254740993', pageId: '7', inputHash: hash, pageGeneration: '3', canonicalPageId: '7', entityPageId: '7' });
const scope = (): ScopeInput => ({ brainId: 'brain-a', revision: 'scope-1', manifestHash: hash, acceptanceReceiptHash: otherHash, grants: [fact()], deniedPages: [] });
const context = (s = scope()) => resolveEmbeddingContext({ strict: true, space: space(), scope: s })!;

describe('additive native space descriptor', () => {
  test('legacy absence is inert; strict context uses code-owned storage', () => {
    expect(resolveEmbeddingContext()).toBeNull();
    const c = context();
    expect(c.space.storage.chunks.vector.name).toBe('embedding_bge_m3_1024');
    expect(c.space.storage.cache.table).toBe('query_cache_bge_m3_1024');
    expect(c.space.storage.facts.embeddedAt).not.toBe('embedded_at');
    expect(c.space.storage.chunks.inputHash).not.toBe('embedded_text_hash');
    expect(c.space.transport).toEqual({ redirect: 'error', fallback: 'none', loopbackOnly: true });
  });
  test('native model families and loopback endpoint binding', () => {
    for (const model of ['llama-server:bge-m3', 'lmstudio:bge-m3', 'ollama:bge-m3']) {
      const d = resolveLocalTextSpace({ ...space(), model, endpoint: model.startsWith('ollama:') ? 'http://localhost:11434/api' : 'http://[::1]:18084/v1' });
      expect(d.storage.facts.vector.embeddingModel).toBe(model);
      expect(d.storage.takes.vector.dimensions).toBe(1024);
    }
  });
  test('wrong dimensions/model/space and arbitrary storage identifiers refuse', () => {
    for (const patch of [{ dimensions: 1536 }, { model: 'openai:text-embedding-3-large' }, { model: 'ollama:unreviewed-model' }, { spaceId: 'legacy' }, { column: 'embedding.other' }]) {
      expect(() => resolveLocalTextSpace({ ...space(), ...patch } as LocalTextSpaceInput)).toThrow();
    }
  });
  test('remote, credential, query, fragment and redirect-like endpoints refuse without secret echo', () => {
    for (const endpoint of ['http://example.invalid/v1', 'http://127.0.0.2/v1', 'file:///tmp/model', 'http://user:secret@localhost/v1', 'http://localhost/v1?token=secret', 'http://localhost/v1#secret', 'http://localhost/redirect']) {
      expect(() => resolveLocalTextSpace({ ...space(), endpoint })).toThrow();
      try { resolveLocalTextSpace({ ...space(), endpoint }); } catch (e) { expect(String(e)).not.toContain('secret'); }
    }
  });
  test('space signature is scope-independent; cache namespace is scope-specific', () => {
    const a = context(), b = context({ ...scope(), revision: 'scope-2' });
    expect(a.space.spaceSignature).toBe(b.space.spaceSignature);
    expect(a.cacheNamespace).not.toBe(b.cacheNamespace);
    expect(resolveLocalTextSpace({ ...space(), endpoint: 'http://127.0.0.1:18085/v1' }).spaceSignature).not.toBe(a.space.spaceSignature);
  });
});

describe('metadata admission and SQL seam', () => {
  test('exact identity only; source/hash/generation/owner drift deny', () => {
    const c = context(); expect(admitsContent(c, 'brain-a', fact())).toBeTrue();
    for (const patch of [{ sourceId: 'source-b' }, { recordId: '8' }, { pageId: '8' }, { inputHash: otherHash }, { pageGeneration: '4' }, { entityPageId: '8' }]) {
      expect(admitsContent(c, 'brain-a', { ...fact(), ...patch })).toBeFalse();
    }
    expect(() => admitsContent(c, 'brain-b', fact())).toThrow();
  });
  test('ambiguous fact owner, duplicate ID and conflicting page revision invalidate scope', () => {
    for (const grants of [
      [{ ...fact(), entityPageId: undefined }], [{ ...fact(), canonicalPageId: '8' }],
      [fact(), { ...fact(), inputHash: otherHash }], [fact(), { ...fact(), sourceId: 'source-b' }],
      [fact(), { ...fact(), recordId: '2', pageGeneration: '4' }],
    ]) expect(() => context({ ...scope(), grants })).toThrow();
  });
  test('denied page cannot be admitted; empty scope is FALSE', () => {
    expect(() => context({ ...scope(), deniedPages: [{ sourceId: 'source-a', pageId: '7' }] })).toThrow();
    const c = context({ ...scope(), grants: [], deniedPages: [{ sourceId: 'source-a', pageId: '7' }] });
    expect(admitsContent(c, 'brain-a', fact())).toBeFalse();
    expect(eligibilityPredicate(c, 'brain-a', 'facts')).toEqual({ text: 'FALSE', params: [] });
  });
  test('unsafe bigint IDs and malformed acceptance hashes refuse', () => {
    for (const recordId of ['0', '-1', '01', '9223372036854775808', 9007199254740992]) {
      expect(() => context({ ...scope(), grants: [{ ...fact(), recordId } as ContentBinding] })).toThrow();
    }
    expect(() => context({ ...scope(), acceptanceReceiptHash: '' })).toThrow();
    expect(() => context({ ...scope(), manifestHash: 'unknown' })).toThrow();
  });
  test('SQL has only fixed identifiers and bound values; bigint stays lossless', () => {
    const p = eligibilityPredicate(context(), 'brain-a', 'facts', 7);
    expect(p.params).toEqual(['source-a', '9007199254740993', '7', hash, '3']);
    expect(p.text).toContain('$7::text'); expect(p.text).toContain('$11::bigint');
    expect(p.text).not.toContain('source-a'); expect(p.text).not.toContain(hash);
    expect(p.text).toContain('candidate.canonical_page_id=candidate.page_id');
    expect(p.text).toContain('candidate.entity_page_id=candidate.page_id');
    expect(() => eligibilityPredicate(context(), 'brain-a', 'facts', 65534)).toThrow();
    expect(() => eligibilityPredicate(context(), 'brain-a', 'facts.invalid' as 'facts')).toThrow();
  });
  test('chunk/take bindings do not invent fact-owner fields', () => {
    for (const lane of ['chunks', 'takes'] as const) {
      const g = { lane, sourceId: 'source-a', recordId: '4', pageId: '7', inputHash: hash, pageGeneration: '3' };
      const c = context({ ...scope(), grants: [g] });
      expect(admitsContent(c, 'brain-a', g)).toBeTrue();
      expect(eligibilityPredicate(c, 'brain-a', lane).text).not.toContain('entity_page_id');
    }
  });
  test('context is deeply immutable, cannot be forged, and scope refresh is explicit', () => {
    const input = scope(), c = context(input);
    (input.grants as ContentBinding[]).push({ ...fact(), recordId: '2' });
    expect(c.scope.grants).toHaveLength(1);
    expect(Object.isFrozen(c.space.storage.facts.vector)).toBeTrue();
    expect(Object.isFrozen(c.scope.grants[0])).toBeTrue();
    expect(() => eligibilityPredicate({ ...c }, 'brain-a', 'facts')).toThrow();
    expect(() => assertScopeBinding(c, { brainId: 'brain-a', revision: 'scope-2', manifestHash: hash })).toThrow();
    expect(() => assertScopeBinding(c, { brainId: 'brain-a', revision: 'scope-1', manifestHash: otherHash })).toThrow();
    expect(() => assertScopeBinding(c, { brainId: 'brain-a', revision: 'scope-1', manifestHash: hash })).not.toThrow();
  });
});

test('nonprimitive hashes/endpoints refuse and input ordering does not change the namespace', () => {
  expect(() => context({ ...scope(), manifestHash: new String(hash) as unknown as string })).toThrow();
  expect(() => context({ ...scope(), grants: [{ ...fact(), inputHash: new String(hash) as unknown as string }] })).toThrow();
  expect(() => resolveLocalTextSpace({ ...space(), endpoint: new URL(space().endpoint) as unknown as string })).toThrow();
  const sibling: ContentBinding = { lane: 'takes', sourceId: 'source-a', pageId: '7', recordId: '5', inputHash: otherHash, pageGeneration: '3' };
  expect(context({ ...scope(), grants: [fact(), sibling] }).cacheNamespace).toBe(context({ ...scope(), grants: [sibling, fact()] }).cacheNamespace);
});
