import { afterAll, beforeAll, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { assertMissingTakeMirrorRoundTrip } from './helpers/take-mirror-contract.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

test('DB-only atom survives take append and filesystem re-import', async () => {
  await assertMissingTakeMirrorRoundTrip(engine);
  await assertMissingTakeMirrorRoundTrip(engine, false);
});
