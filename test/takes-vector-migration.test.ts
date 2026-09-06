import { beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { takesVectorMigrationContract } from './helpers/takes-vector-migration-contract.ts';
let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'llama-server:old-synthetic', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 60000);
afterAll(async () => { await engine.disconnect(); resetGateway(); });
takesVectorMigrationContract(() => engine);
