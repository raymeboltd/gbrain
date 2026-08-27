import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { maybeDispatchSourceEventProjection } from '../src/commands/autopilot-fanout.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { MinionQueue } from '../src/core/minions/queue.ts';

function harness(opts: { enabled?: string; sourceIds?: string; coalesced?: boolean; sources?: Array<{ id: string; config: Record<string, unknown> }> } = {}) {
  const added: Array<{ name: string; data: unknown; options: Record<string, unknown> }> = [];
  const engine = {
    getConfig: async (key: string) => key === 'source_events.enabled'
      ? opts.enabled
      : key === 'source_events.source_ids' ? opts.sourceIds : undefined,
    listAllSources: async () => opts.sources ?? [],
  } as unknown as BrainEngine;
  const queue = {
    add: async (name: string, data: unknown, options: Record<string, unknown>) => {
      added.push({ name, data, options });
      return { id: added.length, coalesced: opts.coalesced === true };
    },
  } as unknown as MinionQueue;
  return { engine, queue, added };
}

describe('Autopilot source-event projection dispatch', () => {
  test('is default-off and dispatches nothing without explicit enablement', async () => {
    const { engine, queue, added } = harness({ sources: [{ id: 'personal', config: {} }] });
    expect(await maybeDispatchSourceEventProjection(engine, queue, { slot: 's1', timeoutMs: 1000 })).toEqual({ dispatched: [], reason: 'disabled' });
    expect(added).toEqual([]);
  });

  test('explicit false-like values remain disabled', async () => {
    for (const enabled of ['false', '0', 'off']) {
      const { engine, queue, added } = harness({ enabled, sourceIds: 'personal', sources: [{ id: 'personal', config: {} }] });
      expect((await maybeDispatchSourceEventProjection(engine, queue, { slot: 's1', timeoutMs: 1000 })).reason).toBe('disabled');
      expect(added).toEqual([]);
    }
  });

  test('dispatches one explicit source-scoped, single-flight job per enabled source', async () => {
    const { engine, queue, added } = harness({
      enabled: 'true',
      sourceIds: 'personal',
      sources: [
        { id: 'personal', config: {} },
        { id: 'paused', config: { autopilot_sync: false } },
      ],
    });
    expect(await maybeDispatchSourceEventProjection(engine, queue, { slot: 's1', timeoutMs: 1000 })).toEqual({ dispatched: ['personal'], reason: 'enabled' });
    expect(added).toEqual([{
      name: 'source-event-projection',
      data: { sourceId: 'personal' },
      options: {
        queue: 'default', idempotency_key: 'source-event-projection:personal:s1',
        max_attempts: 2, timeout_ms: 1000, maxPending: 1,
      },
    }]);
  });

  test('has no legacy/default fallback when the source registry is empty', async () => {
    const { engine, queue, added } = harness({ enabled: 'true', sourceIds: 'personal', sources: [] });
    expect(await maybeDispatchSourceEventProjection(engine, queue, { slot: 's1', timeoutMs: 1000 })).toEqual({ dispatched: [], reason: 'no_sources' });
    expect(added).toEqual([]);
  });

  test('enabled without an approved source allowlist still dispatches nothing', async () => {
    const { engine, queue, added } = harness({ enabled: 'true', sources: [{ id: 'personal', config: {} }] });
    expect(await maybeDispatchSourceEventProjection(engine, queue, { slot: 's1', timeoutMs: 1000 })).toEqual({ dispatched: [], reason: 'source_unconfigured' });
    expect(added).toEqual([]);
  });

  test('coalesced work is not falsely reported as a fresh dispatch', async () => {
    const { engine, queue } = harness({
      enabled: 'true', sourceIds: 'personal', coalesced: true,
      sources: [{ id: 'personal', config: {} }],
    });
    expect(await maybeDispatchSourceEventProjection(engine, queue, { slot: 's1', timeoutMs: 1000 })).toEqual({ dispatched: [], reason: 'enabled' });
  });

  test('Autopilot calls the projector dispatcher after producer dispatch', () => {
    const source = readFileSync(join(import.meta.dir, '../src/commands/autopilot.ts'), 'utf8');
    expect(source).toMatch(/maybeDispatchSourceEventProjection/);
    const jobs = readFileSync(join(import.meta.dir, '../src/commands/jobs.ts'), 'utf8');
    expect(jobs).toMatch(/worker\.register\('source-event-projection'/);
  });
});
