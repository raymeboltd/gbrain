import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { writePageThrough, _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import {
  makeSourceEventProjectionHandler,
  sourceEventProjectionLockId,
} from '../src/core/minions/handlers/source-event-projection.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import {
  SOURCE_EVENT_PROCESSOR_VERSION,
  projectSourceEvent,
  sourceEventId,
} from '../src/core/source-events/projector.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM source_event_receipts');
  await engine.executeRaw('DELETE FROM timeline_entries');
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("UPDATE sources SET config='{}'::jsonb,local_path=NULL WHERE id='default'");
  await engine.setConfig('source_events.enabled', 'true');
  await engine.setConfig('source_events.source_ids', 'default');
  _resetWriteThroughCacheForTest();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-source-event-handler-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
  await engine.setConfig('sync.write_through', 'true');
});

afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function fakeJob(data: Record<string, unknown>, progress: unknown[] = []): MinionJobContext {
  return {
    id: 42,
    name: 'source-event-projection',
    data,
    attempts_made: 0,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    deadlineAtMs: null,
    updateProgress: async (value: unknown) => { progress.push(value); },
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  } as unknown as MinionJobContext;
}

async function seedCanonicalTarget(slug: string, type: string, title: string): Promise<void> {
  await importFromContent(engine, slug, `---\ntitle: ${title}\ntype: ${type}\n---\n\n# ${title}\n\nKnown ${type}.\n`, {
    noEmbed: true,
    sourceId: 'default',
    sourcePath: `${slug}.md`,
  });
  const written = await writePageThrough(engine, slug, { sourceId: 'default' });
  if (!written.written) throw new Error(`failed to seed canonical target ${slug}`);
}

async function seedLane(slug: string, type: string, date: string, extraFrontmatter: Record<string, unknown> = {}): Promise<void> {
  await engine.putPage(slug, {
    type,
    title: `${type} fixture`,
    compiled_truth: `Victor Example appears in this ${type} fixture.`,
    content_hash: `hash-${type}`,
    effective_date: new Date(`${date}T00:00:00.000Z`),
    effective_date_source: 'date',
    frontmatter: { date, provider_item_id: `id-${type}-${slug}`, ...extraFrontmatter },
  });
}

describe('source-event projection handler', () => {
  test('requires explicit sourceId', async () => {
    const handler = makeSourceEventProjectionHandler(engine);
    await expect(handler(fakeJob({}))).rejects.toThrow(/sourceId is required/);
    await expect(handler(fakeJob({ sourceId: 'missing' }))).rejects.toThrow(/registered source/);
  });

  test('rejects pages without immutable producer identity before receipt claim', async () => {
    await seedCanonicalTarget('people/victor-example', 'person', 'Victor Example');
    await engine.putPage('raw/gmail/no-provider-id', {
      type: 'email', title: 'Missing identity', compiled_truth: 'Victor Example replied.',
      content_hash: 'missing-id', frontmatter: {},
    });
    const result = await makeSourceEventProjectionHandler(engine)(fakeJob({ sourceId: 'default' })) as {
      status: string; identity_rejected: number; errors: number;
    };
    expect(result).toMatchObject({ status: 'partial', identity_rejected: 1, errors: 1 });
    expect(await engine.executeRaw('SELECT 1 FROM source_event_receipts')).toHaveLength(0);
  });

  test('enforces enablement and approved-source admission inside the handler', async () => {
    const handler = makeSourceEventProjectionHandler(engine);
    await engine.setConfig('source_events.enabled', 'false');
    await expect(handler(fakeJob({ sourceId: 'default' }))).rejects.toThrow(/denied by policy \(disabled\)/);
    await engine.setConfig('source_events.enabled', 'true');
    await engine.setConfig('source_events.source_ids', 'other');
    await expect(handler(fakeJob({ sourceId: 'default' }))).rejects.toThrow(/denied by policy \(source_not_approved\)/);
    await engine.setConfig('source_events.source_ids', 'default');
    await engine.executeRaw(
      `UPDATE sources SET config='{"autopilot_sync":false}'::jsonb WHERE id='default'`,
    );
    await expect(handler(fakeJob({ sourceId: 'default' }))).rejects.toThrow(/denied by policy \(source_autopilot_disabled\)/);
  });

  test('aggregates review and skipped causes instead of reporting a clean run', async () => {
    await engine.putPage('people/alex-one', {
      type: 'person', title: 'Alex Example', compiled_truth: 'Known one.',
    });
    await engine.putPage('people/alex-two', {
      type: 'person', title: 'Alex Example', compiled_truth: 'Known two.',
    });
    await engine.putPage('raw/gmail/review-1', {
      type: 'email', title: 'Review', compiled_truth: 'Alex Example replied.',
      content_hash: 'review-hash', frontmatter: { message_id: 'review-1' },
    });
    await engine.putPage('raw/gmail/unknown-1', {
      type: 'email', title: 'Unknown', compiled_truth: 'Nobody Known replied.',
      content_hash: 'unknown-hash', frontmatter: { message_id: 'unknown-1' },
    });
    const result = await makeSourceEventProjectionHandler(engine)(fakeJob({ sourceId: 'default' })) as {
      status: string; scanned: number; applied: number; partial: number; skipped: number; reviews: number; errors: number;
    };
    expect(result).toMatchObject({ status: 'partial', scanned: 2, applied: 0, partial: 0, skipped: 1, reviews: 1, errors: 2 });
  });

  test('normalizes every material ingestion shape and excludes derived Dream/artifact pages', async () => {
    await seedCanonicalTarget('people/victor-example', 'person', 'Victor Example');
    await seedLane('raw/messages/beeper-1', 'message', '2026-08-21', { provider_item_id: undefined, message_id: 'beeper-msg-1', network: 'whatsapp' });
    await seedLane('raw/gmail/mail-1', 'email', '2026-08-22', { provider_item_id: undefined, message_id: 'gmail-msg-1', thread_id: 'gmail-thread-1' });
    await seedLane('raw/calendar/event-1', 'calendar-event', '2026-08-23', { provider_item_id: undefined, event_id: 'calendar-event-1' });
    await seedLane('raw/meetings/note-1', 'meeting-note', '2026-08-24', { provider_item_id: undefined, note_id: 'granola-note-1' });
    await seedLane('events/event-1', 'event', '2026-08-25');
    await seedLane('raw/sessions/session-1', 'conversation', '2026-08-26', { provider_item_id: undefined, thread_id: 'codex-thread-1', source_tool: 'codex' });
    await seedLane('raw/meetings/native-1', 'meeting', '2026-08-26');
    await seedLane('raw/imessage/day-1', 'imessage-daily', '2026-08-26');
    await seedLane('raw/slack/thread-1', 'slack', '2026-08-26');
    await seedLane('raw/connectors/chatgpt-1', 'conversation', '2026-08-26', {
      provider_item_id: undefined,
      id: 'chatgpt-session-1-p1',
      transcript_import: { harness: 'chatgpt', session_id: 'chatgpt-session-1', part: 1, of: 1 },
    });
    await seedLane('signals/vault-authoring-1', 'note', '2026-08-26', { provider_item_id: undefined, capture_id: 'vault-capture-1', source_event: true });
    await engine.putPage('dreams/conversation-1', {
      type: 'conversation', title: 'Derived Dream', compiled_truth: 'Victor Example appears in a derived page.',
      content_hash: 'dream-hash', frontmatter: { dream_generated: true, provider_item_id: 'dream-1' },
    });

    const progress: unknown[] = [];
    const result = await makeSourceEventProjectionHandler(engine)(fakeJob({ sourceId: 'default', limit: 20 }, progress)) as {
      status: string; sourceId: string; scanned: number; applied: number; partial: number; skipped: number; reviews: number; failed: number; errors: number; retracted: number; identity_rejected: number; silent_skips: number;
    };
    expect(result).toEqual({ status: 'partial', sourceId: 'default', scanned: 11, applied: 0, partial: 11, skipped: 0, reviews: 0, failed: 0, errors: 11, retracted: 0, identity_rejected: 0, silent_skips: 0 });
    expect(progress.length).toBeGreaterThan(0);

    const receipts = await engine.executeRaw<{ source_kind: string; source_key: string }>(
      'SELECT source_kind,source_key FROM source_event_receipts ORDER BY source_kind,source_key',
    );
    expect(receipts.map((row) => row.source_kind)).toEqual([
      'calendar-event', 'conversation', 'conversation', 'email', 'event', 'imessage-daily',
      'meeting', 'meeting-note', 'message', 'note', 'slack',
    ]);
    expect(receipts.map((row) => row.source_key)).toContain('meeting-note:note_id:granola-note-1');
    expect(receipts.map((row) => row.source_key)).toContain('conversation:chatgpt:session_id:chatgpt-session-1:part:1');
    expect(receipts.map((row) => row.source_key)).toContain('codex:thread_id:codex-thread-1');

    const replay = await makeSourceEventProjectionHandler(engine)(fakeJob({ sourceId: 'default', limit: 10 })) as { scanned: number };
    expect(replay.scanned).toBe(0);
  });

  test('records an empty item as skipped and continues to the next candidate', async () => {
    await seedCanonicalTarget('people/victor-example', 'person', 'Victor Example');
    await engine.putPage('raw/gmail/empty-1', {
      type: 'email', title: 'Empty', compiled_truth: '', content_hash: 'empty-hash',
      frontmatter: { message_id: 'empty-1' },
    });
    await seedLane('raw/messages/valid-1', 'message', '2026-08-27');

    const result = await makeSourceEventProjectionHandler(engine)(fakeJob({ sourceId: 'default' })) as {
      status: string; scanned: number; partial: number; skipped: number; errors: number;
    };
    expect(result).toMatchObject({ status: 'partial', scanned: 2, partial: 1, skipped: 1, errors: 2, retracted: 0 });
    const receipts = await engine.executeRaw<{ status: string; errors: unknown }>(
      'SELECT status, errors FROM source_event_receipts ORDER BY source_slug',
    );
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ status: 'skipped' });
    expect(JSON.stringify(receipts[0]!.errors)).toContain('empty_content');
  });

  test('contains one canonical-write failure, leaves it retryable, and continues the batch', async () => {
    await seedCanonicalTarget('people/victor-example', 'person', 'Victor Example');
    await seedLane('raw/messages/failing-1', 'message', '2026-08-27');
    const eventId = sourceEventId({ sourceId: 'default', sourceKey: 'message:provider_item_id:id-message-raw/messages/failing-1' });
    fs.mkdirSync(path.join(brainDir, 'source-events', `${eventId}.md`), { recursive: true });
    await engine.putPage('raw/gmail/unknown-2', {
      type: 'email', title: 'Unknown', compiled_truth: 'Nobody Known replied.',
      content_hash: 'unknown-2-hash', frontmatter: { message_id: 'unknown-2' },
    });

    await expect(
      makeSourceEventProjectionHandler(engine)(fakeJob({ sourceId: 'default' })),
    ).rejects.toThrow(/1 item\(s\) failed canonical projection/);
    const receipts = await engine.executeRaw<{ source_slug: string; status: string }>(
      'SELECT source_slug,status FROM source_event_receipts ORDER BY source_slug',
    );
    expect(receipts).toEqual([
      { source_slug: 'raw/gmail/unknown-2', status: 'skipped' },
      { source_slug: 'raw/messages/failing-1', status: 'error' },
    ]);
  });

  test('soft-deleting a source page retracts its private artifact and restoring it reprocesses', async () => {
    await seedCanonicalTarget('people/victor-example', 'person', 'Victor Example');
    await seedLane('raw/messages/retract-1', 'message', '2026-08-27');
    const handler = makeSourceEventProjectionHandler(engine);
    await handler(fakeJob({ sourceId: 'default' }));
    const [receipt] = await engine.executeRaw<{ artifact_slug: string }>(
      "SELECT artifact_slug FROM source_event_receipts WHERE source_slug='raw/messages/retract-1'",
    );
    expect(receipt).toBeDefined();
    await engine.softDeletePage('raw/messages/retract-1', { sourceId: 'default' });
    const retracted = await handler(fakeJob({ sourceId: 'default' })) as { scanned: number; retracted: number };
    expect(retracted).toMatchObject({ scanned: 0, retracted: 1 });
    const disk = fs.readFileSync(path.join(brainDir, `${receipt!.artifact_slug}.md`), 'utf8');
    expect(disk).toContain('source_event_state: retracted');
    const links = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.slug=$1`,
      [receipt!.artifact_slug],
    );
    expect(links[0]!.count).toBe(0);

    await engine.restorePage('raw/messages/retract-1', { sourceId: 'default' });
    const restored = await handler(fakeJob({ sourceId: 'default' })) as { scanned: number; retracted: number };
    expect(restored).toMatchObject({ scanned: 1, retracted: 0 });
    const restoredDisk = fs.readFileSync(path.join(brainDir, `${receipt!.artifact_slug}.md`), 'utf8');
    expect(restoredDisk).toContain('source_event_state: active');
    const restoredLinks = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.slug=$1`,
      [receipt!.artifact_slug],
    );
    expect(restoredLinks[0]!.count).toBe(1);
  });

  test('archiving a source retracts every committed artifact without running admission', async () => {
    await seedCanonicalTarget('people/victor-example', 'person', 'Victor Example');
    await seedLane('raw/messages/archive-1', 'message', '2026-08-27');
    const handler = makeSourceEventProjectionHandler(engine);
    await handler(fakeJob({ sourceId: 'default' }));
    await engine.executeRaw("UPDATE sources SET archived=true,config='{}'::jsonb WHERE id='default'");
    await engine.setConfig('source_events.enabled', 'false');
    const result = await handler(fakeJob({ sourceId: 'default' })) as {
      status: string; scanned: number; retracted: number;
    };
    expect(result).toMatchObject({ status: 'completed', scanned: 0, retracted: 1 });
    const receipt = await engine.executeRaw<{ errors: unknown }>('SELECT errors FROM source_event_receipts');
    expect(JSON.stringify(receipt[0]?.errors)).toContain('source_retracted');
    await engine.executeRaw("UPDATE sources SET archived=false WHERE id='default'");
  });

  test('soft-delete retracts canonical artifact and facts after receipt loss', async () => {
    await seedCanonicalTarget('people/victor-example', 'person', 'Victor Example');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [brainDir]);
    const sourceSlug = 'raw/messages/receipt-loss-delete';
    const content = 'Victor Example confirmed the delivery update in this message.';
    await engine.putPage(sourceSlug, {
      type: 'message', title: 'Receipt loss delete', compiled_truth: content,
      frontmatter: { provider_item_id: 'receipt-loss-delete' },
    });
    let factId = 0;
    const receipt = await projectSourceEvent(engine, {
      sourceId: 'default', sourceKind: 'message',
      sourceKey: 'message:provider_item_id:receipt-loss-delete',
      sourceUri: 'gbrain://raw%2Fmessages%2Freceipt-loss-delete', sourceSlug,
      contentHash: createHash('md5').update(content).digest('hex'),
      processorVersion: SOURCE_EVENT_PROCESSOR_VERSION,
      occurredAt: '2026-08-27T00:00:00.000Z', content,
    }, {
      runFacts: async (factsEngine, sourceInput, _targets, run) => {
        const written = await writeSingleFact(factsEngine, sourceInput.sourceId, {
          fact: 'Victor Example confirmed the delivery update',
          provenance: 'source-event:receipt-loss-delete', kind: 'commitment',
          entity: 'people/victor-example', visibility: 'private',
          sessionId: run.factSessionId, pendingRunId: run.runId,
        });
        factId = written.id;
        return { inserted: 1, duplicate: 0, superseded: 0, factIds: [written.id], stage: 'applied' };
      },
    });
    await engine.executeRaw('DELETE FROM source_event_receipts');
    await engine.softDeletePage(sourceSlug, { sourceId: 'default' });
    const result = await makeSourceEventProjectionHandler(engine)(fakeJob({ sourceId: 'default' })) as {
      scanned: number; retracted: number;
    };
    expect(result).toMatchObject({ scanned: 0, retracted: 1 });
    const artifact = fs.readFileSync(path.join(brainDir, `${receipt.artifactSlug}.md`), 'utf8');
    expect(artifact).toContain('source_event_state: retracted');
    expect(artifact).not.toContain('source-event-pending:');
    expect((await engine.executeRaw<{ expired_at: Date | null }>(
      'SELECT expired_at FROM facts WHERE id=$1', [factId],
    ))[0]?.expired_at).not.toBeNull();
    expect(await engine.executeRaw(
      `SELECT 1 FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.slug=$1`,
      [receipt.artifactSlug],
    )).toHaveLength(0);
  });

  test('soft-delete retracts session-staged fact missing from artifact and receipt', async () => {
    await seedCanonicalTarget('people/victor-example', 'person', 'Victor Example');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [brainDir]);
    const sourceSlug = 'raw/messages/staged-receipt-loss';
    const compiledTruth = 'Victor Example confirmed a staged delivery update.';
    const projectedContent = `${compiledTruth}\n`;
    await engine.putPage(sourceSlug, {
      type: 'message', title: 'Staged receipt loss', compiled_truth: compiledTruth,
      effective_date: new Date('2026-08-27T00:00:00.000Z'),
      frontmatter: { provider_item_id: 'staged-receipt-loss' },
    });
    const projectionInput = {
      sourceId: 'default', sourceKind: 'message',
      sourceKey: 'message:provider_item_id:staged-receipt-loss',
      sourceUri: 'gbrain://raw%2Fmessages%2Fstaged-receipt-loss', sourceSlug,
      contentHash: createHash('md5').update(projectedContent).digest('hex'),
      processorVersion: SOURCE_EVENT_PROCESSOR_VERSION,
      occurredAt: '2026-08-27T00:00:00.000Z', content: projectedContent,
    };
    let factId = 0;
    let retractionResult: { retracted: number } | null = null;
    await expect(projectSourceEvent(engine, projectionInput, {
      runFacts: async (factsEngine, sourceInput, _targets, run) => {
        const written = await writeSingleFact(factsEngine, sourceInput.sourceId, {
          fact: 'Victor Example confirmed the staged delivery update',
          provenance: 'source-event:staged-receipt-loss', kind: 'commitment',
          entity: 'people/victor-example', visibility: 'private',
          sessionId: run.factSessionId, pendingRunId: run.runId,
        });
        factId = written.id;
        await factsEngine.executeRaw('DELETE FROM source_event_receipts');
        await factsEngine.softDeletePage(sourceSlug, { sourceId: 'default' });
        retractionResult = await makeSourceEventProjectionHandler(factsEngine)(
          fakeJob({ sourceId: 'default' }),
        ) as { retracted: number };
        throw new Error('simulated crash before artifact fact-id persistence');
      },
    })).rejects.toThrow(/simulated crash before artifact fact-id persistence/);

    expect(retractionResult as unknown).toEqual({
      status: 'completed', sourceId: 'default', scanned: 0, applied: 0, partial: 0,
      skipped: 0, reviews: 0, failed: 0, errors: 0, retracted: 1,
      identity_rejected: 0, silent_skips: 0,
    });
    const artifactSlug = `source-events/${sourceEventId(projectionInput)}`;
    const artifact = fs.readFileSync(path.join(brainDir, `${artifactSlug}.md`), 'utf8');
    expect(artifact).toContain('source_event_state: retracted');
    const targetPath = path.join(brainDir, 'people/victor-example.md');
    expect(fs.readFileSync(targetPath, 'utf8')).not.toContain('source-event-pending:');
    expect((await engine.executeRaw<{ expired_at: Date | null }>(
      'SELECT expired_at FROM facts WHERE id=$1', [factId],
    ))[0]?.expired_at).not.toBeNull();
    expect(await engine.executeRaw(
      `SELECT 1 FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.slug=$1`, [artifactSlug],
    )).toHaveLength(0);

    await importFromContent(engine, 'people/victor-example', fs.readFileSync(targetPath, 'utf8'), {
      noEmbed: true, sourceId: 'default', sourcePath: 'people/victor-example.md',
    });
    const extract = await runExtractFacts(engine, {
      sourceId: 'default', slugs: ['people/victor-example'],
    });
    expect(extract.warnings.some((warning) => warning.includes('SOURCE_EVENT_FACT_COMMIT_PENDING')))
      .toBe(false);
  });

  test('lock contention is observable and does not throw', async () => {
    const held = await tryAcquireDbLock(engine, sourceEventProjectionLockId('default'), 5);
    expect(held).not.toBeNull();
    try {
      const result = await makeSourceEventProjectionHandler(engine)(fakeJob({ sourceId: 'default' })) as { status: string };
      expect(result.status).toBe('already_in_progress');
    } finally {
      await held!.release();
    }
  });
});
