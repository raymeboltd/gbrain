import { describe, expect, test } from 'bun:test';
import { schemaEngineConfig } from '../src/commands/schema.ts';

describe('schema CLI engine config', () => {
  test('propagates configured PGLite database_path', () => {
    expect(schemaEngineConfig({
      engine: 'pglite',
      database_path: '/tmp/example/brain.pglite',
    })).toEqual({
      engine: 'pglite',
      database_url: undefined,
      database_path: '/tmp/example/brain.pglite',
    });
  });

  test('preserves Postgres URL routing', () => {
    expect(schemaEngineConfig({
      engine: 'postgres',
      database_url: 'postgres://example.invalid/db',
    })).toEqual({
      engine: 'postgres',
      database_url: 'postgres://example.invalid/db',
      database_path: undefined,
    });
  });
});
