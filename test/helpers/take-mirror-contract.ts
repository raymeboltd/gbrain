import { expect } from 'bun:test';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { addTakeToPage } from '../../src/core/takes-write.ts';
import { parseTakesFence, renderTakesFence } from '../../src/core/takes-fence.ts';
import { extractTakes } from '../../src/core/cycle/extract-takes.ts';
import { renderFactsTable, parseFactsFence } from '../../src/core/facts-fence.ts';

export async function assertMissingTakeMirrorRoundTrip(engine: BrainEngine, withExistingTakes = true) {
  const sourceId = 'take-mirror-fixture';
  const slug = 'atoms/2026-01-02/durable-evidence';
  const repo = mkdtempSync(join(tmpdir(), 'gbrain-take-mirror-'));
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)`, [sourceId, repo]);
  const facts = renderFactsTable([{rowNum:1,claim:'Original fact survives',kind:'fact',confidence:1,
    visibility:'private',notability:'medium',source:'raw/fixture',active:true}]);
  const oldTakes = renderTakesFence([{rowNum:3,claim:'Existing take survives',kind:'take',holder:'world',weight:0.5,active:true}]);
  const core = '# Durable evidence\n\nOriginal quasar substrate supports the conclusion.\n\n' + facts + (withExistingTakes ? '\n\n## Takes\n\n' + oldTakes : '');
  const timeline = '## Timeline\n\n- 2026-01-02: Original dated event.';
  const md = serializeMarkdown({atom_type:'insight',source_hash:'fixture-hash',source_slug:'raw/fixture',
    extracted_by:'extract_atoms-v0.41.2.1',custom:{nested:'preserve me'}},core,timeline,
    {type:'atom',title:'Durable evidence',tags:['fixture-tag']});
  try {
    // Same native DB-only import used by extract_atoms, no model/provider.
    await importFromContent(engine,slug,md,{sourceId,noEmbed:true});
    const before = await engine.getPage(slug,{sourceId});
    expect(before?.type).toBe('atom');
    expect(existsSync(join(repo,`${slug}.md`))).toBe(false);
    // Another source has the same slug. It must never seed this file.
    await engine.putPage(slug,{type:'note',title:'Wrong source',compiled_truth:'WRONG SOURCE'}, {sourceId:'default'});
    const added = await addTakeToPage({engine,slug,sourceId,brainDir:repo},
      {claim:'A fresh derived take',kind:'take',holder:'world',weight:0.7});
    const fileBody = readFileSync(added.mirror.path,'utf8');
    expect(fileBody).toContain('Original quasar substrate');
    expect(fileBody).not.toContain('WRONG SOURCE');
    expect(added.rowNum).toBe(withExistingTakes ? 4 : 1);
    expect(parseFactsFence(fileBody).facts[0].claim).toBe('Original fact survives');
    const expectedTakes = withExistingTakes ? ['Existing take survives','A fresh derived take'] : ['A fresh derived take'];
    expect(parseTakesFence(fileBody).takes.map(t=>t.claim)).toEqual(expectedTakes);
    // The filesystem becomes authoritative on the next sync/import.
    await importFromContent(engine,slug,fileBody,{sourceId,noEmbed:true,sourcePath:`${slug}.md`});
    const after = await engine.getPage(slug,{sourceId});
    expect(after?.id).toBe(before?.id);
    expect(after?.type).toBe('atom');
    expect(after?.title).toBe(before?.title);
    expect(after?.frontmatter).toMatchObject({atom_type:'insight',source_hash:'fixture-hash',source_slug:'raw/fixture',
      extracted_by:'extract_atoms-v0.41.2.1',custom:{nested:'preserve me'}});
    expect(after?.compiled_truth).toContain('Original quasar substrate');
    expect(after?.timeline.trim()).toStartWith(timeline);
    expect(await engine.getTags(slug,{sourceId})).toContain('fixture-tag');
    expect((await engine.searchKeyword('quasar',{sourceId})).some(p=>p.slug===slug)).toBe(true);
    // Native DB-source extraction explicitly reads compiled_truth + timeline,
    // so a first fence appended after the timeline sentinel remains visible.
    await extractTakes(engine,{source:'db'});
    const takes = await engine.executeRaw<{claim:string}>('SELECT claim FROM takes WHERE page_id=$1 ORDER BY row_num',[after!.id]);
    expect(takes.map(t=>t.claim)).toEqual(expectedTakes);
    // A second async append continues the preserved fence numbering.
    const again=await addTakeToPage({engine,slug,sourceId,brainDir:repo},
      {claim:'Another take',kind:'take',holder:'world'});
    expect(again.rowNum).toBe(withExistingTakes ? 5 : 2);
    expect((await engine.getPage(slug,{sourceId:'default'}))?.compiled_truth).toBe('WRONG SOURCE');
    return {before,after,fileBody,repo,path:added.mirror.path};
  } finally {
    await engine.executeRaw('DELETE FROM pages WHERE source_id=$1 OR (source_id=$2 AND slug=$3)',[sourceId,'default',slug]);
    await engine.executeRaw('DELETE FROM sources WHERE id=$1',[sourceId]);
    rmSync(repo, { recursive: true, force: true });
  }
}
