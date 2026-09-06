import { describe, test, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runSchemaTransition, planEmbeddingMigration, applyEmbeddingMigration, readDimPinnedWidths } from '../../src/core/embedding-migration.ts';

export function takesVectorMigrationContract(getEngine: () => BrainEngine) {
  let seq = 0;
  async function seed() {
    const engine = getEngine();
    await runSchemaTransition(engine, 1536);
    await engine.setConfig('embedding_model', 'llama-server:old-synthetic');
    await engine.setConfig('embedding_dimensions', '1536');
    const page = await engine.putPage(`synthetic/take-${++seq}`, { title: 'Synthetic take', type: 'note', compiled_truth: 'Synthetic evidence' });
    await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Synthetic provenance survives migration', kind: 'fact', holder: 'world', weight: 0.8, source: 'synthetic/source', since_date: '2026-01-01' }]);
    const id = Number((await engine.executeRaw<{ id: number }>('SELECT id FROM takes WHERE page_id=$1', [page.id]))[0].id);
    await engine.updateTakeEmbeddings([{ take_id: id, embedding: new Float32Array(1536).fill(0.01) }]);
    const snapshot = async () => (await engine.executeRaw<{ row: string }>(`SELECT (to_jsonb(takes)-'embedding'-'embedded_at')::text AS row FROM takes WHERE id=$1`, [id]))[0].row;
    const before = await snapshot();
    return { engine, id, snapshot, before };
  }
  describe('takes vector migration contract', () => {
    test('1536 to 1024 preserves take identity/provenance, clears derived state and restores vector retrieval', async () => {
      const a = await seed();
      await runSchemaTransition(a.engine, 1024);
      expect((await readDimPinnedWidths(a.engine)).find(r => r.table === 'takes')?.dims).toBe(1024);
      expect(await a.snapshot()).toBe(a.before);
      const row = (await a.engine.executeRaw<{ embedding: unknown; embedded_at: unknown }>('SELECT embedding,embedded_at FROM takes WHERE id=$1', [a.id]))[0];
      expect(row.embedding).toBeNull(); expect(row.embedded_at).toBeNull();
      const v = new Float32Array(1024).fill(0.01);
      expect(await a.engine.searchTakesVector(v, { sourceId: 'default' })).toEqual([]);
      expect(await a.engine.updateTakeEmbeddings([{ take_id: a.id, embedding: v }])).toBe(1);
      expect((await a.engine.searchTakesVector(v, { sourceId: 'default' })).some(r => r.take_id === a.id)).toBe(true);
      const indexes = await a.engine.executeRaw<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname='idx_takes_embedding_hnsw'`);
      expect(indexes).toHaveLength(1); expect(indexes[0].indexdef).toContain('active');
    });
    test('same-width model switch invalidates facts and takes before file-plane persistence, preserving semantic rows', async () => {
      const a = await seed();
      await a.engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,source,source_session,embedding,embedded_at)
        VALUES ('default','synthetic/entity','Synthetic fact','synthetic','synthetic-session',$1::vector,now())`,
        [`[${new Array(1536).fill(0.01).join(',')}]`]);
      const snapshot = async () => (await a.engine.executeRaw<{ row: string }>(`SELECT (to_jsonb(facts)-'embedding'-'embedded_at')::text AS row FROM facts WHERE entity_slug='synthetic/entity'`));
      const before = await snapshot();
      const plan = await planEmbeddingMigration(a.engine, { to: 'llama-server:new-synthetic', dim: 1536, fromModel: 'llama-server:old-synthetic', fromDims: 1536 });
      let callbackChecked = false;
      const result = await applyEmbeddingMigration(a.engine, plan, { persistConfig: async () => {
        const rows = await a.engine.executeRaw<{ n: number }>(`SELECT (SELECT count(*) FROM facts WHERE embedding IS NOT NULL)+(SELECT count(*) FROM takes WHERE embedding IS NOT NULL) AS n`);
        expect(Number(rows[0].n)).toBe(0); callbackChecked = true;
      } });
      expect(result.status).toBe('applied'); expect(callbackChecked).toBe(true);
      expect(await a.snapshot()).toBe(a.before); expect(await snapshot()).toEqual(before);
      const stamps = await a.engine.executeRaw<{ n: number }>(`SELECT (SELECT count(*) FROM facts WHERE embedded_at IS NOT NULL)+(SELECT count(*) FROM takes WHERE embedded_at IS NOT NULL) AS n`);
      expect(Number(stamps[0].n)).toBe(0);
      await a.engine.updateTakeEmbeddings([{ take_id: a.id, embedding: new Float32Array(1536).fill(0.02) }]);
      expect((await applyEmbeddingMigration(a.engine, plan)).status).toBe('applied');
      expect((await a.engine.executeRaw('SELECT embedding FROM takes WHERE id=$1',[a.id]))[0].embedding).not.toBeNull();
    });
    test('failed file-plane persistence resumes without clearing newly regenerated target vectors', async () => {
      const a = await seed();
      const plan = await planEmbeddingMigration(a.engine, { to: 'llama-server:new-synthetic', dim: 1536, fromModel: 'llama-server:old-synthetic', fromDims: 1536 });
      expect((await applyEmbeddingMigration(a.engine, plan, { persistConfig: async () => { throw Error('synthetic file write failure'); } })).status).toBe('failed');
      expect(await a.engine.getConfig('embedding_model')).toBe('llama-server:new-synthetic');
      expect((await a.engine.executeRaw('SELECT embedding FROM takes WHERE id=$1', [a.id]))[0].embedding).toBeNull();
      await a.engine.updateTakeEmbeddings([{ take_id: a.id, embedding: new Float32Array(1536).fill(0.03) }]);
      const snapshot = await a.snapshot();
      expect((await applyEmbeddingMigration(a.engine, plan)).status).toBe('applied');
      expect(await a.snapshot()).toBe(snapshot);
      expect((await a.engine.searchTakesVector(new Float32Array(1536).fill(0.03), { sourceId: 'default' })).some(r => r.take_id === a.id)).toBe(true);
    });
    test('apply independently repairs stranded takes width then resume preserves regenerated vectors', async () => {
      const a = await seed();
      await runSchemaTransition(a.engine, 1024);
      // Reproduce an older migration that already moved every other column.
      await a.engine.executeRaw('DROP INDEX IF EXISTS idx_takes_embedding_hnsw');
      await a.engine.executeRaw('ALTER TABLE takes DROP COLUMN embedding');
      await a.engine.executeRaw('ALTER TABLE takes ADD COLUMN embedding vector(1536)');
      await a.engine.updateTakeEmbeddings([{ take_id: a.id, embedding: new Float32Array(1536).fill(0.01) }]);
      const beforeRepair = await a.snapshot();
      const plan = await planEmbeddingMigration(a.engine, { to: 'llama-server:bge-m3', dim: 1024 });
      const result = await applyEmbeddingMigration(a.engine, plan);
      expect(result.status).toBe('applied');
      if (result.status !== 'applied') throw Error('unexpected migration refusal');
      expect(result.schema_transitioned).toBe(false);
      expect((await readDimPinnedWidths(a.engine)).find(r => r.table === 'takes')?.dims).toBe(1024);
      expect(await a.snapshot()).toBe(beforeRepair);
      await a.engine.updateTakeEmbeddings([{ take_id: a.id, embedding: new Float32Array(1024).fill(0.02) }]);
      const vector = async () => (await a.engine.executeRaw<{ v: string }>('SELECT embedding::text AS v FROM takes WHERE id=$1', [a.id]))[0].v;
      const beforeVector = await vector();
      expect((await applyEmbeddingMigration(a.engine, plan)).status).toBe('applied');
      expect(await vector()).toBe(beforeVector);
    });
  });
}
