import { beforeAll, afterAll, describe } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runSchemaTransition } from '../../src/core/embedding-migration.ts';
import { resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { factEmbeddingContract } from '../helpers/fact-embedding-contract.ts';
(hasDatabase()?describe:describe.skip)('Postgres fact embedding',()=>{
 let engine:PostgresEngine;let dims:number;
 beforeAll(async()=>{engine=await setupDB();dims=Number((await engine.executeRaw<{dims:number}>(`SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'`))[0].dims);await runSchemaTransition(engine,384);},60000);
 afterAll(async()=>{__setEmbedTransportForTests(null);resetGateway();if(engine)await runSchemaTransition(engine,dims);await teardownDB();},60000);
 factEmbeddingContract(()=>engine);
});
