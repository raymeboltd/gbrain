import {beforeAll,beforeEach,afterAll,test,expect,spyOn} from 'bun:test';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
import {admitAutomaticOwnerFacts,admitConversationOwnerFacts} from '../src/core/facts/owner-admission.ts';
import {resetPgliteState} from './helpers/reset-pglite.ts';
let engine:PGLiteEngine;
beforeAll(async()=>{engine=new PGLiteEngine();await engine.connect({});await engine.initSchema();},60_000);
beforeEach(async()=>{await resetPgliteState(engine);await engine.executeRaw("UPDATE sources SET config='{\"facts_owner_slug\":\"people/owner-example\"}'::jsonb WHERE id='default'");});
afterAll(async()=>{await engine.disconnect()});
test('automatic owner floor preserves medium ordinary entity and high owner',async()=>{
 const facts=[{fact:'owner medium example',entity_slug:'people/owner-example',notability:'medium'},{fact:'owner high example',entity_slug:'people/owner-example',notability:'high'},{fact:'ordinary medium example',entity_slug:'people/alice-example',notability:'medium'}];
 expect(await admitConversationOwnerFacts(engine,'default','conversations/fixture','private',facts)).toEqual(facts.slice(1));
});
test('owner batch dedupe preserves evidence already stored on another page',async()=>{
 await engine.insertFact({fact:'Owner joined board',entity_slug:'people/owner-example',notability:'high',visibility:'world',source:'test'}, {source_id:'default'});
 const claim={fact:'Owner joined board.',entity_slug:'people/owner-example',notability:'high'};
 expect(await admitConversationOwnerFacts(engine,'default','conversations/fixture','private',[claim,claim])).toHaveLength(1);
 expect(await admitConversationOwnerFacts(engine,'default','conversations/fixture','world',[claim])).toHaveLength(1);
});

test('owner configuration normalizes canonical slug case and suffix', async () => {
 await engine.executeRaw("UPDATE sources SET config=config || '{\"facts_owner_slug\":\" People/Owner-Example.md \"}'::jsonb WHERE id='default'");
 const facts=[{fact:'medium rejected',entity_slug:'people/owner-example',notability:'medium'},{fact:'ordinary retained',entity_slug:'people/alice-example',notability:'medium'}];
 expect(await admitConversationOwnerFacts(engine,'default','conversations/fixture','private',facts)).toEqual(facts.slice(1));
});
test('retaining later-page evidence survives expiry of the first evidence page', async () => {
 const fact={fact:'Owner attends synthetic board',entity_slug:'people/owner-example',notability:'high' as const,visibility:'private' as const,source:'test'};
 const a=await engine.insertFact(fact, {source_id:'default'});
 await engine.executeRaw("UPDATE facts SET source_markdown_slug='conversations/first',row_num=0 WHERE id=$1",[a.id]);
 const rows=await admitConversationOwnerFacts(engine,'default','conversations/later','private',[fact]);
 expect(rows).toHaveLength(1);
 const b=await engine.insertFact(rows[0], {source_id:'default'});
 await engine.executeRaw("UPDATE facts SET source_markdown_slug='conversations/later',row_num=0 WHERE id=$1",[b.id]);
 await engine.executeRaw('UPDATE facts SET expired_at=now() WHERE id=$1',[a.id]);
 expect(await engine.executeRaw('SELECT id FROM facts WHERE id=$1 AND expired_at IS NULL',[b.id])).toHaveLength(1);
});

test('legacy nested JSON owner config is decoded through native source parser',async()=>{
 await engine.executeRaw('UPDATE sources SET config=$1::text::jsonb WHERE id=$2',[JSON.stringify(JSON.stringify({facts_owner_slug:'people/owner-example'})),'default']);
 const rows=[{fact:'nested owner medium',entity_slug:'people/owner-example',notability:'medium'}];
 expect(await admitConversationOwnerFacts(engine,'default','conversations/fixture','private',rows)).toHaveLength(0);
 await engine.executeRaw("UPDATE sources SET config='{\"facts_owner_slug\":\"people/owner-example\"}'::jsonb WHERE id='default'");
});
for(const [field,a,b] of [['valid_from','2026-09-01','2026-10-01'],['context','Segment A','Segment B'],['attributed_to','people/alice-example','people/bob-example'],['provider_id','fixture-a','fixture-b']])test('owner retains distinct '+field+' evidence',async()=>{
 const base={fact:'Owner repeated synthetic milestone',entity_slug:'people/owner-example',notability:'high'};const rows=[{...base,[field]:a},{...base,[field]:b}];
 expect(await admitConversationOwnerFacts(engine,'default','conversations/fixture','private',rows)).toEqual(rows);
});

test('owner config is source-local and absent config leaves every tier unchanged',async()=>{
 await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('other','Other','{}'::jsonb)");
 const rows=[{fact:'Source-local owner evidence',entity_slug:'people/owner-example',notability:'medium'}];
 expect(await admitConversationOwnerFacts(engine,'other','conversations/fixture','private',rows)).toEqual(rows);
 expect(await admitConversationOwnerFacts(engine,'default','conversations/fixture','private',rows)).toEqual([]);
});

test('automatic admission uses source-aware canonical resolution and explicit extraction bypasses it',async()=>{
 const rows=[{fact:'Canonical owner evidence',entity_slug:'Owner Alias',notability:'medium'}];
 let calls=0;
 const resolve=async(_engine:unknown,sourceId:string,slug:string)=>{
  calls++;expect(sourceId).toBe('default');expect(slug).toBe('Owner Alias');
  return {source:'exact_alias',slug:'people/owner-example'};
 };
 expect(await admitAutomaticOwnerFacts(engine,'default','mcp:put_page',rows,resolve)).toEqual([]);
 expect(calls).toBe(1);
 expect(await admitAutomaticOwnerFacts(engine,'default','mcp:extract_facts',rows,resolve)).toEqual(rows);
 expect(calls).toBe(1);
});

test('missing and low owner notability is rejected without disclosing claims in diagnostics',async()=>{
 const secret='Synthetic private claim never belongs in diagnostic output';
 const spy=spyOn(process.stderr,'write').mockImplementation(()=>true);
 try {
  const rows=[{fact:secret,entity_slug:'people/owner-example'}, {fact:secret,entity_slug:'people/owner-example',notability:'low'}];
  expect(await admitConversationOwnerFacts(engine,'default','conversations/fixture','private',rows)).toEqual([]);
  expect(spy.mock.calls.map(args=>String(args[0])).join('')).not.toContain(secret);
  expect(spy.mock.calls.map(args=>String(args[0])).join('')).toContain('filtered=2');
 } finally {spy.mockRestore();}
});
