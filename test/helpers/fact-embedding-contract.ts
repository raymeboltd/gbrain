import { randomUUID } from 'node:crypto';
import { describe, test, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runFactEmbeddingBackfill } from '../../src/core/fact-embedding-backfill.ts';
import { tryAcquireDbLock } from '../../src/core/db-lock.ts';
import { embedBackfillLockId } from '../../src/core/embed-backfill-lock.ts';
const model = 'ollama:all-minilm';
const vec = () => new Array(384).fill(0.125);
export function factEmbeddingContract(getEngine: () => BrainEngine) {
  let seq = 0;
  const prefix = randomUUID().slice(0,8);
  async function setup() {
    const engine = getEngine();
    const source = `fact-embed-${prefix}-${++seq}`;
    await engine.executeRaw(`INSERT INTO sources (id,name) VALUES ($1,$1)`, [source]);
    await engine.setConfig('embedding_model',model);
    await engine.setConfig('embedding_dimensions','384');
    configureGateway({embedding_model:model,embedding_dimensions:384,env:{}});
    __setEmbedTransportForTests((async ({values}: {values:string[]}) => ({embeddings: values.map(vec),usage:{tokens:values.length}})) as never);
    const seed = async (text: string, extra = '') => {
      const rows = await engine.executeRaw<{id:number}>(`INSERT INTO facts
        (source_id,entity_slug,fact,kind,visibility,notability,source,confidence,source_session,context,claim_metric,claim_value,claim_unit)
        VALUES ($1,'example-entity',$2,'fact','private','medium','test',0.8,'session-proof',$3,'mrr',42,'USD') RETURNING id`,[source,text,extra]);
      return Number(rows[0].id);
    };
    const snapshot = async (id:number) => (await engine.executeRaw<{row:string}>(`SELECT (to_jsonb(facts)-'embedding')::text AS row FROM facts WHERE id=$1`,[id]))[0]?.row;
    const vector = async (id:number) => (await engine.executeRaw<{v:string|null}>(`SELECT embedding::text AS v FROM facts WHERE id=$1`,[id]))[0]?.v;
    const run = (more = {}) => runFactEmbeddingBackfill(engine,{sourceId:source,localOnly:true,...more});
    return {engine,source,seed,snapshot,vector,run};
  }
  describe('fact embedding backfill contract', () => {
    test('preserves every non-vector field, existing vectors and other sources; retry is no-op', async () => {
      const a=await setup();const id=await a.seed('missing');const existing=await a.seed('existing');
      await a.engine.executeRaw(`UPDATE facts SET embedding=$2::vector WHERE id=$1`,[existing,`[${vec().join(',')}]`]);
      const before=await a.snapshot(id), old=await a.vector(existing);
      const other=await setup();const otherId=await other.seed('foreign');
      const result=await a.run();expect(result.embedded).toBe(1);expect(result.status).toBe('complete');
      expect(await a.snapshot(id)).toBe(before);expect(await a.vector(id)).not.toBeNull();
      expect(await a.vector(existing)).toBe(old);expect(await other.vector(otherId)).toBeNull();
      expect((await a.run()).embedded).toBe(0);
    });
    test('dry run, expired and pending exclusions never invoke provider', async () => {
      const a=await setup();const id=await a.seed('active');const expired=await a.seed('expired');const pending=await a.seed('pending','source-event-pending:run1');
      await a.engine.executeRaw(`UPDATE facts SET expired_at=now() WHERE id=$1`,[expired]);
      let calls=0;__setEmbedTransportForTests(async()=>{calls++;throw Error('forbidden')});
      const result=await a.run({dryRun:true});expect(result.remaining).toBe(1);expect(result.status).toBe('planned');expect(calls).toBe(0);
      expect(await a.vector(id)).toBeNull();expect(await a.vector(expired)).toBeNull();expect(await a.vector(pending)).toBeNull();
    });
    test('concurrent fact correction defeats full-row CAS', async () => {
      const a=await setup();const id=await a.seed('before');
      __setEmbedTransportForTests((async()=>{await a.engine.executeRaw(`UPDATE facts SET source_session='corrected',claim_value=43 WHERE id=$1`,[id]);return {embeddings:[vec()],usage:{tokens:1}}}) as never);
      const result=await a.run();expect(result.conflicted).toBe(1);expect(result.embedded).toBe(0);expect(await a.vector(id)).toBeNull();
      expect(await a.snapshot(id)).toContain('corrected');
    });
    test('model drift after generation commits no vector', async () => {
      const a=await setup();const id=await a.seed('model-race');
      __setEmbedTransportForTests((async()=>{await a.engine.setConfig('embedding_model','ollama:bge-m3');return {embeddings:[vec()],usage:{tokens:1}}}) as never);
      const result=await a.run();expect(result.failed).toBe(1);expect(result.status).toBe('partial');expect(await a.vector(id)).toBeNull();
    });
    test('source lock contention preserves rows and retry succeeds', async () => {
      const a=await setup();const id=await a.seed('locked');const before=await a.snapshot(id);
      const lock=await tryAcquireDbLock(a.engine,embedBackfillLockId(a.source),60);expect(lock).not.toBeNull();
      try {const r=await a.run();expect(r.failed).toBe(1);expect(await a.snapshot(id)).toBe(before);expect(await a.vector(id)).toBeNull();}
      finally {await lock!.release();}
      expect((await a.run()).embedded).toBe(1);
    });
    test('partial batch failure leaves retry cursor and reports committed progress', async () => {
      const a=await setup();const first=await a.seed('first');const second=await a.seed('second');let calls=0;const receipts:number[]=[];
      __setEmbedTransportForTests((async()=>{if(++calls===2)throw Error('synthetic provider failure');return {embeddings:[vec()],usage:{tokens:1}}}) as never);
      const result=await a.run({batchSize:1,onProgress:async(r:{embedded:number})=>{receipts.push(r.embedded)}});
      expect(result.embedded).toBe(1);expect(result.failed).toBe(1);expect(result.remaining).toBe(1);expect(receipts).toEqual([1,1]);
      expect(await a.vector(first)).not.toBeNull();expect(await a.vector(second)).toBeNull();
      __setEmbedTransportForTests((async()=>({embeddings:[vec()],usage:{tokens:1}})) as never);
      expect((await a.run()).embedded).toBe(1);
    });
    test('BIGSERIAL cursor remains exact above the JavaScript integer boundary', async () => {
      const a=await setup();const first=await a.seed('wide-one');const second=await a.seed('wide-two');const small=await a.seed('numeric-order');
      await a.engine.executeRaw(`UPDATE facts SET id=99 WHERE id=$1`,[small]);
      await a.engine.executeRaw(`UPDATE facts SET id=9007199254740993 WHERE id=$1`,[first]);
      await a.engine.executeRaw(`UPDATE facts SET id=9007199254740994 WHERE id=$1`,[second]);
      const r=await a.run({batchSize:1});expect(r.embedded).toBe(3);expect(r.selected).toBe(3);expect(r.remaining).toBe(0);
    });
    test('historical valid_until remains eligible unless logically expired', async () => {
      const a=await setup();const id=await a.seed('historical');
      await a.engine.executeRaw(`UPDATE facts SET valid_until='2020-01-01' WHERE id=$1`,[id]);
      expect((await a.run()).embedded).toBe(1);expect(await a.vector(id)).not.toBeNull();
    });
    test('cancellation after generation does not commit a vector', async () => {
      const a=await setup();const id=await a.seed('cancel');const controller=new AbortController();
      __setEmbedTransportForTests((async()=>{controller.abort();return {embeddings:[vec()],usage:{tokens:1}}}) as never);
      const r=await a.run({signal:controller.signal});expect(r.status).toBe('partial');expect(r.embedded).toBe(0);expect(await a.vector(id)).toBeNull();
    });
    test('concurrent vector writer wins without overwrite', async () => {
      const a=await setup();const id=await a.seed('vector-race');const winner=`[${new Array(384).fill(0.25).join(',')}]`;
      __setEmbedTransportForTests((async()=>{await a.engine.executeRaw(`UPDATE facts SET embedding=$2::vector WHERE id=$1`,[id,winner]);return {embeddings:[vec()],usage:{tokens:1}}}) as never);
      const r=await a.run();expect(r.conflicted).toBe(1);expect(await a.vector(id)).toBe(winner);
    });
    test('incomplete batch does not partially assign positional vectors', async () => {
      const a=await setup();const one=await a.seed('one');const two=await a.seed('two');
      __setEmbedTransportForTests((async()=>({embeddings:[vec()],usage:{tokens:1}})) as never);
      const r=await a.run();expect(r.failed).toBe(2);expect(r.embedded).toBe(0);expect(await a.vector(one)).toBeNull();expect(await a.vector(two)).toBeNull();
    });
    test('archive/source and dimension validation occur before provider calls', async () => {
      const a=await setup();await a.seed('scope');let calls=0;__setEmbedTransportForTests(async()=>{calls++;throw Error('forbidden')});
      await expect(a.run({sourceId:''})).rejects.toThrow('explicit source');
      await expect(a.run({sourceId:'absent'})).rejects.toThrow('does not exist');
      await a.engine.executeRaw(`UPDATE sources SET archived=true WHERE id=$1`,[a.source]);
      await expect(a.run()).rejects.toThrow('does not exist');
      await a.engine.executeRaw(`UPDATE sources SET archived=false WHERE id=$1`,[a.source]);
      configureGateway({embedding_model:model,embedding_dimensions:768,env:{}});await a.engine.setConfig('embedding_dimensions','768');
      await expect(a.run()).rejects.toThrow('column dimensions');expect(calls).toBe(0);
    });
    test('hosted provider and remote local-provider endpoint are refused before transport', async () => {
      const a=await setup();await a.seed('private');let calls=0;__setEmbedTransportForTests(async()=>{calls++;throw Error('forbidden')});
      configureGateway({embedding_model:'openai:text-embedding-3-small',embedding_dimensions:384,env:{OPENAI_API_KEY:'synthetic'}});
      await expect(a.run()).rejects.toThrow('native local');
      configureGateway({embedding_model:model,embedding_dimensions:384,env:{},base_urls:{ollama:'https://example.com/v1'}});
      await expect(a.run()).rejects.toThrow('loopback');expect(calls).toBe(0);
    });
    test('malformed vector and active migration retain NULL cursor', async () => {
      const a=await setup();const id=await a.seed('malformed');
      __setEmbedTransportForTests((async()=>({embeddings:[new Array(384).fill(0)],usage:{tokens:1}})) as never);
      expect((await a.run()).failed).toBe(1);expect(await a.vector(id)).toBeNull();
      await a.engine.setConfig('embedding_migration.state','{}');
      try {await expect(a.run()).rejects.toThrow('active migration');}finally {await a.engine.executeRaw(`DELETE FROM config WHERE key='embedding_migration.state'`);}
    });
  });
}
