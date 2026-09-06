import { beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSchemaTransition } from '../src/core/embedding-migration.ts';
import { resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { factEmbeddingContract } from './helpers/fact-embedding-contract.ts';
let engine:PGLiteEngine;
beforeAll(async()=>{engine=new PGLiteEngine();await engine.connect({});await engine.initSchema();await runSchemaTransition(engine,384);},60000);
afterAll(async()=>{__setEmbedTransportForTests(null);resetGateway();await engine.disconnect();});
factEmbeddingContract(()=>engine);
