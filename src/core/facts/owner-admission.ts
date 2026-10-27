import type { BrainEngine } from '../engine.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { stableJson } from '../persistence/digest.ts';

/** Per-source protection for automatic extraction; explicit fact writes bypass it. */
export async function ownerSlugForFacts(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [sourceId]);
  const slug = parseSourceConfig(rows[0]?.config).facts_owner_slug;
  return typeof slug === 'string' ? slug.trim().replace(/\.md$/i, '').toLowerCase() || null : null;
}

export function ownerFactAdmitted(ownerSlug: string | null, entitySlug: string | null, notability: string | undefined): boolean {
  return !ownerSlug || entitySlug?.toLowerCase() !== ownerSlug || notability === 'high';
}

/** Count-only diagnostics never disclose the extracted claims. */
export function reportOwnerAdmission(filtered: number, duplicate: number): void {
  if (filtered || duplicate) process.stderr.write(`[facts] owner admission: filtered=${filtered} batch_duplicates=${duplicate}\n`);
}

/** Shared automatic admission before managed and ordinary publication diverge. */
export async function admitAutomaticOwnerFacts<T extends { entity_slug?: string | null; notability?: string }>(
  engine: BrainEngine, sourceId: string, source: string, facts: T[],
  resolve: (engine: BrainEngine, sourceId: string, slug: string) => Promise<{ source: string; slug: string } | null>,
): Promise<T[]> {
  const owner = source === 'mcp:extract_facts' ? null : await ownerSlugForFacts(engine, sourceId);
  if (!owner) return facts;
  const accepted: T[] = [];
  for (const fact of facts) {
    const resolved = fact.entity_slug ? await resolve(engine, sourceId, fact.entity_slug) : null;
    const slug = resolved?.source === 'fallback_slugify' ? null : resolved?.slug ?? null;
    if (ownerFactAdmitted(owner, slug, fact.notability)) accepted.push(fact);
  }
  reportOwnerAdmission(facts.length - accepted.length, 0);
  return accepted;
}

/**
 * Conversation subjects are already canonical. Collapse repeated claims within
 * this page's batch, retaining rows on every other evidence page. Read-side
 * collapseHotFacts supplies cross-page dedupe without destroying provenance.
 */
export async function admitConversationOwnerFacts<T extends { entity_slug?: string | null; notability?: string; fact: string }>(
  engine: BrainEngine, sourceId: string, _pageSlug: string, _visibility: 'private' | 'world', facts: T[],
): Promise<T[]> {
  const owner = await ownerSlugForFacts(engine, sourceId);
  if (!owner) return facts;
  const accepted: T[] = [];
  const ownerClaims = new Set<string>();
  let filtered = 0;
  let duplicate = 0;
  for (const fact of facts) {
    if (!ownerFactAdmitted(owner, fact.entity_slug ?? null, fact.notability)) { filtered++; continue; }
    if (fact.entity_slug?.toLowerCase() === owner) {
      const [row] = await engine.executeRaw<{ fingerprint: string }>(
        'SELECT gbrain_fact_fingerprint($1::text) AS fingerprint', [fact.fact]);
      // Equal words with different time, context, attribution or provider
      // pointers are distinct evidence. Embeddings do not define evidence.
      const key = stableJson({ ...fact, fact: row.fingerprint, entity_slug: owner, embedding: undefined, embedding_model: undefined });
      if (ownerClaims.has(key)) { duplicate++; continue; }
      ownerClaims.add(key);
    }
    accepted.push(fact);
  }
  reportOwnerAdmission(filtered, duplicate);
  return accepted;
}
