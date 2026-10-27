import {beforeAll,expect,test} from 'bun:test';
import {join} from 'node:path';
import {extractPageLinks} from '../src/core/link-extraction.ts';
import {loadPackFromFile} from '../src/core/schema-pack/loader.ts';
import {resolvePack} from '../src/core/schema-pack/registry.ts';
import {inferLinkTypeFromPack} from '../src/core/schema-pack/link-inference.ts';
import {parseSchemaPackManifest} from '../src/core/schema-pack/manifest-v1.ts';
let pack:any;
beforeAll(async()=>{const load=(n:string)=>loadPackFromFile(join(import.meta.dir,'../src/core/schema-pack/base',n+'.yaml'));pack=(await resolvePack(load('company-brain'),async n=>load(n))).manifest;});
async function champions(body:string){const result=await extractPageLinks('customers/fixture',body,{},'customer',{resolve:async()=>null},{pack,targetType:(slug)=>slug.startsWith('people/')?'person':undefined,skipFrontmatter:true});return [...new Set(result.candidates.filter(x=>x.linkType==='champion').map(x=>x.targetSlug))].sort();}
test('URL terminal sentence punctuation separates subjects',async()=>{expect(await champions('[[people/ben]] is the champion https://example.com. [[people/ada]] owns the account.')).toEqual(['people/ben']);});
for(const negative of ['is no champion','is neither the champion nor the sponsor','cannot be the champion'])test('literal negative: '+negative,async()=>{expect(await champions('[[people/ada]] '+negative+'. [[people/ben]] is the champion.')).toEqual(['people/ben']);});
test('HTML comment role words cannot assert a role or shift UTF16 offsets',async()=>{expect(await champions('[[people/ada]] owns the account <!-- champion -->. [[people/ben]] is the champion.')).toEqual(['people/ben']);expect(await champions('😀 [[people/ada]] owns <!-- sponsor\nchampion --> the account. [[people/ben]] is the champion.')).toEqual(['people/ben']);});
test('schema rejects attribution without nonempty regex',()=>{for(const regex of [undefined,'','   '])expect(()=>parseSchemaPackManifest({...pack,name:'invalid-v2',extends:null,link_types:[{name:'champion',inference:{page_type:'customer',target_type:'person',attribution:'reference_clause',...(regex===undefined?{}:{regex})}}]})).toThrow();});
test('runtime bypass cannot infer opted role without regex or empty clause',()=>{for(const regex of [undefined,'','   ']){const malformed:any={link_types:[{name:'champion',inference:{page_type:'customer',target_type:'person',attribution:'reference_clause',regex}}]};for(const referenceContext of ['', 'not champion','champion'])expect(inferLinkTypeFromPack(malformed,'customer','champion',undefined,'person',{referenceContext})).toBeNull();}expect(inferLinkTypeFromPack({link_types:[{name:'champion',inference:{attribution:'reference_clause',regex:'^$'}}]} as any,'customer','champion',undefined,'person',{referenceContext:''})).toBeNull();});
