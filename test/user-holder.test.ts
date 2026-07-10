import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  DEFAULT_USER_HOLDER,
  USER_HOLDER_CONFIG_KEY,
  resolveUserHolder,
} from '../src/core/calibration/user-holder.ts';

function engineWith(value: string | null): BrainEngine {
  return {
    kind: 'pglite',
    async getConfig(key: string) {
      expect(key).toBe(USER_HOLDER_CONFIG_KEY);
      return value;
    },
  } as unknown as BrainEngine;
}

describe('resolveUserHolder', () => {
  test('explicit holder wins without reading config', async () => {
    const engine = {
      kind: 'pglite',
      async getConfig() {
        throw new Error('config should not be read');
      },
    } as unknown as BrainEngine;
    expect(await resolveUserHolder(engine, ' self ')).toBe('self');
  });

  test('uses the configured personal holder', async () => {
    expect(await resolveUserHolder(engineWith(' self '))).toBe('self');
  });

  test('preserves the legacy default when unset', async () => {
    expect(await resolveUserHolder(engineWith(null))).toBe(DEFAULT_USER_HOLDER);
  });
});
