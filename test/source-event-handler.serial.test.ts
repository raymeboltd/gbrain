import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import {
  makeSourceEventProjectionHandler,
  sourceEventProjectionLockId,
} from '../src/core/minions/handlers/source-event-projection.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;

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
});

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

async function seedLane(slug: string, type: string, date: string): Promise<void> {
  await engine.putPage(slug, {
    type,
    title: `${type} fixture`,
    compiled_truth: `Victor Example appears in this ${type} fixture.`,
    content_hash: `hash-${type}`,
    effective_date: new Date(`${date}T00:00:00.000Z`),
    effective_date_source: 'date',
    frontmatter: { date, provider_item_id: `id-${type}` },
  });
}

describe('source-event projection handler', () => {
  test('requires explicit sourceId', async () => {
    const handler = makeSourceEventProjectionHandler(engine);
    await expect(handler(fakeJob({}))).rejects.toThrow(/sourceId is required/);
    await expect(handler(fakeJob({ sourceId: 'missing' }))).rejects.toThrow(/registered source/);
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
      scanned: number; applied: number; skipped: number; reviews: number; errors: number;
    };
    expect(result).toMatchObject({ scanned: 2, applied: 0, skipped: 1, reviews: 1, errors: 2 });
  });

  test('normalizes every supported ingestion shape and excludes derived Dream pages', async () => {
    await engine.putPage('people/victor-example', {
      type: 'person', title: 'Victor Example', compiled_truth: 'Known person.',
    });
    await seedLane('raw/messages/beeper-1', 'message', '2026-08-21');
    await seedLane('raw/gmail/mail-1', 'email', '2026-08-22');
    await seedLane('raw/calendar/event-1', 'calendar-event', '2026-08-23');
    await seedLane('raw/meetings/note-1', 'meeting-note', '2026-08-24');
    await seedLane('events/event-1', 'event', '2026-08-25');
    await seedLane('raw/sessions/session-1', 'conversation', '2026-08-26');
    await seedLane('dreams/reflection-1', 'reflection', '2026-08-27');

    const progress: unknown[] = [];
    const result = await makeSourceEventProjectionHandler(engine)(fakeJob({ sourceId: 'default', limit: 10 }, progress)) as {
      status: string; sourceId: string; scanned: number; applied: number; skipped: number; reviews: number; errors: number;
    };
    expect(result).toEqual({ status: 'completed', sourceId: 'default', scanned: 6, applied: 6, skipped: 0, reviews: 0, errors: 0 });
    expect(progress.length).toBeGreaterThan(0);

    const receipts = await engine.executeRaw<{ source_kind: string }>(
      'SELECT source_kind FROM source_event_receipts ORDER BY source_kind',
    );
    expect(receipts.map((row) => row.source_kind)).toEqual([
      'calendar-event', 'conversation', 'email', 'event', 'meeting-note', 'message',
    ]);

    const replay = await makeSourceEventProjectionHandler(engine)(fakeJob({ sourceId: 'default', limit: 10 })) as { scanned: number };
    expect(replay.scanned).toBe(0);
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
