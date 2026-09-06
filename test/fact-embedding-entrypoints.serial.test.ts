import { beforeAll, afterAll, test, expect } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSchemaTransition } from '../src/core/embedding-migration.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbed } from '../src/commands/embed.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
let engine:PGLiteEngine;
beforeAll(async()=>{
 engine=new PGLiteEngine();await engine.connect({});await engine.initSchema();await runSchemaTransition(engine,384);
 await engine.setConfig('embedding_model','ollama:all-minilm');await engine.setConfig('embedding_dimensions','384');
 configureGateway({embedding_model:'ollama:all-minilm',embedding_dimensions:384,env:{}});
 await engine.insertFacts([{fact:'synthetic existing fact',kind:'fact',source:'test',row_num:1,source_markdown_slug:'synthetic-entity'}],{source_id:'default'});
},60000);
afterAll(async()=>{__setEmbedTransportForTests(null);resetGateway();await engine.disconnect();});
test('native CLI requires explicit scope and preserves dry-run semantics',async()=>{
 let calls=0;__setEmbedTransportForTests(async()=>{calls++;throw Error('no inference')});
 await expect(runEmbed(engine,['--facts','--stale'])).rejects.toThrow('source');
 await expect(runEmbed(engine,['--facts','--all','--source','default'])).rejects.toThrow('stale');
 const r=await runEmbed(engine,['--facts','--stale','--source','default','--local-only','--dry-run']);
 expect(r?.facts?.status).toBe('planned');expect(r?.would_embed).toBe(1);expect(r?.embedded).toBe(0);expect(calls).toBe(0);
});
test('native embed job records partial progress, fails, then retries only remaining NULL vectors',async()=>{
 const worker=new MinionWorker(engine,{concurrency:1});await registerBuiltinHandlers(worker,engine);
 const handler=(worker as unknown as {handlers:Map<string,(job:unknown)=>Promise<unknown>>}).handlers.get('embed')!;
 const progress:Array<{phase:string;failed:number;embedded:number}>=[];
 const job={id:'fact-embed-job',data:{facts:true,stale:true,sourceId:'default',localOnly:true},signal:new AbortController().signal,
  updateProgress:async(p:typeof progress[number])=>{progress.push(p)}};
 __setEmbedTransportForTests(async()=>{throw Error('synthetic failure')});
 await expect(handler(job)).rejects.toThrow('Fact embedding partial');
 expect(progress.at(-1)?.phase).toBe('embed.facts');expect(progress.at(-1)?.failed).toBe(1);
 __setEmbedTransportForTests((async()=>({embeddings:[new Array(384).fill(0.125)],usage:{tokens:1}})) as never);
 const result=await handler(job) as {facts:{embedded:number;status:string}};
 expect(result.facts.embedded).toBe(1);expect(result.facts.status).toBe('complete');
 const again=await handler(job) as {facts:{embedded:number}};expect(again.facts.embedded).toBe(0);
},30000);
