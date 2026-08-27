import { importFromContent } from '../import-file.ts';
import type { BrainEngine } from '../engine.ts';
import { writePageThrough } from '../write-through.ts';

const ARTIFACT_VERSION = 1;
const ARTIFACT_MARKER = 'gbrain:source-event-artifact';

export type SourceEventRevisionState = 'active' | 'superseded' | 'retracted';

export interface SourceEventRevisionRecord {
  revision_id: string;
  processor_version: string;
  content_hash: string;
  occurred_at: string;
  state: SourceEventRevisionState;
  targets: string[];
  fact_ids: number[];
  facts_stage: 'applied' | 'disabled' | 'unavailable' | 'skipped' | 'error';
  action_candidates: Array<Record<string, unknown>>;
  project_candidates: Array<Record<string, unknown>>;
  changed_at: string;
  reason?: string;
}

export interface SourceEventArtifact {
  version: number;
  event_id: string;
  state: 'active' | 'retracted';
  source: {
    source_id: string;
    kind: string;
    key: string;
    uri: string;
    slug: string;
  };
  active_revision_id: string | null;
  revisions: SourceEventRevisionRecord[];
}

export interface PersistSourceEventArtifactInput {
  sourceId: string;
  artifactSlug: string;
  artifact: SourceEventArtifact;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function wikiLink(slug: string): string {
  return `[[${slug}|${slug}]]`;
}

export function renderSourceEventArtifact(artifact: SourceEventArtifact): string {
  const active = artifact.state === 'active'
    ? artifact.revisions.find((revision) => revision.revision_id === artifact.active_revision_id && revision.state === 'active')
    : undefined;
  const relationships = active?.targets ?? [];
  const sourceLink = artifact.state === 'active' ? wikiLink(artifact.source.slug) : '`retracted`';
  const relationshipLines = relationships.length > 0
    ? relationships.map((slug) => `- ${wikiLink(slug)}`).join('\n')
    : '- None';
  const json = JSON.stringify(artifact, null, 2);
  return `---
type: note
title: ${yamlString(`Source event ${artifact.event_id.slice(0, 12)}`)}
visibility: private
source_event_artifact: true
source_event_id: ${yamlString(artifact.event_id)}
source_event_state: ${artifact.state}
source_event_revision: ${yamlString(artifact.active_revision_id ?? '')}
---

# Source event evidence

Private canonical projection receipt. Raw content is not copied here.

- Source: ${sourceLink}
- State: ${artifact.state}
- Occurred: ${active?.occurred_at ?? 'n/a'}
- Kind: ${artifact.source.kind}

## Active relationships

${relationshipLines}

<!-- ${ARTIFACT_MARKER}:begin -->

\`\`\`json
${json}
\`\`\`

<!-- ${ARTIFACT_MARKER}:end -->
`;
}

export function parseSourceEventArtifact(body: string): SourceEventArtifact | null {
  const begin = body.indexOf(`<!-- ${ARTIFACT_MARKER}:begin -->`);
  const end = body.indexOf(`<!-- ${ARTIFACT_MARKER}:end -->`, begin + 1);
  if (begin < 0 || end < 0) return null;
  const region = body.slice(begin, end);
  const match = /```json\s*([\s\S]*?)\s*```/.exec(region);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!) as SourceEventArtifact;
    if (parsed.version !== ARTIFACT_VERSION || !parsed.event_id || !Array.isArray(parsed.revisions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function loadSourceEventArtifact(
  engine: BrainEngine,
  sourceId: string,
  artifactSlug: string,
): Promise<SourceEventArtifact | null> {
  const page = await engine.getPage(artifactSlug, { sourceId });
  if (!page) return null;
  return parseSourceEventArtifact(page.compiled_truth);
}

/**
 * Persist the private event artifact through the normal import + write-through
 * path, then reconcile its explicit Markdown links immediately. The links
 * remain derived state: `sync && extract all` reconstructs them from this file.
 */
export async function persistSourceEventArtifact(
  engine: BrainEngine,
  input: PersistSourceEventArtifactInput,
): Promise<{ linksWritten: number; path: string }> {
  const markdown = renderSourceEventArtifact(input.artifact);
  await importFromContent(engine, input.artifactSlug, markdown, {
    noEmbed: true,
    sourceId: input.sourceId,
    sourcePath: `${input.artifactSlug}.md`,
    source_kind: 'source-event-projection',
    ingested_via: 'source-event-projection',
  });
  const written = await writePageThrough(engine, input.artifactSlug, { sourceId: input.sourceId });
  if (!written.written || !written.path) {
    throw new Error(
      `source-event: canonical artifact write required for '${input.artifactSlug}' ` +
      `(${written.skipped ?? written.error ?? 'unknown'})`,
    );
  }

  const active = input.artifact.state === 'active'
    ? input.artifact.revisions.find((revision) => revision.revision_id === input.artifact.active_revision_id && revision.state === 'active')
    : undefined;
  // Only entity relationships are projected into the derived graph. The raw
  // source pointer stays canonical Markdown inside this private artifact, but
  // upstream's FS link extractor intentionally does not rebuild raw-page
  // edges; inserting one here would create derived state that diverges after
  // `sync && extract all`.
  const targets = [...new Set(active?.targets ?? [])];
  let linksWritten = 0;
  await engine.transaction(async (tx) => {
    await tx.removeLinksByPagesAndSource(
      [{ slug: input.artifactSlug, source_id: input.sourceId }],
      { linkSource: 'markdown' },
    );
    const rows = targets.map((target) => ({
      from_slug: input.artifactSlug,
      to_slug: target,
      link_type: 'mentions',
      link_source: 'markdown',
      context: target,
      from_source_id: input.sourceId,
      to_source_id: input.sourceId,
      origin_slug: input.artifactSlug,
      origin_source_id: input.sourceId,
      origin_field: 'compiled_truth',
    }));
    if (rows.length > 0) {
      linksWritten = await tx.addLinksBatch(rows, { auditSite: 'addLinksBatch' });
    }
  });
  return { linksWritten, path: written.path };
}

export function newSourceEventArtifact(input: {
  eventId: string;
  sourceId: string;
  sourceKind: string;
  sourceKey: string;
  sourceUri: string;
  sourceSlug: string;
}): SourceEventArtifact {
  return {
    version: ARTIFACT_VERSION,
    event_id: input.eventId,
    state: 'active',
    source: {
      source_id: input.sourceId,
      kind: input.sourceKind,
      key: input.sourceKey,
      uri: input.sourceUri,
      slug: input.sourceSlug,
    },
    active_revision_id: null,
    revisions: [],
  };
}
