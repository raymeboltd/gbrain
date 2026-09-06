import { beforeAll, afterAll, describe } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import { takesVectorMigrationContract } from '../helpers/takes-vector-migration-contract.ts';
const d = hasDatabase() ? describe : describe.skip;
d('takes migration real Postgres', () => {
  let engine: PostgresEngine;
  beforeAll(async () => {
    configureGateway({ embedding_model: 'llama-server:old-synthetic', embedding_dimensions: 1536, env: {} });
    engine = await setupDB();
  }, 60000);
  afterAll(async () => { await teardownDB(); resetGateway(); });
  takesVectorMigrationContract(() => engine);
});
