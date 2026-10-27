import {test,expect} from 'bun:test';
import {makeShareable,runPublish,generateHtml} from '../src/commands/publish.ts';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('bare Timeline heading strips private records',()=>{
 expect(makeShareable('# Public\n\n## Timeline\n\nPRIVATE_TIMELINE')).not.toContain('PRIVATE_TIMELINE');
});
test('absolute, relative and wiki brain links keep labels without internal paths',()=>{
 const result=makeShareable('[Absolute](/people/private.md) [Bare](people/private.md) [[people/private|Alias]]');
 expect(result).toBe('Absolute Bare Alias');
});
test('external links and same-page anchors survive',()=>{
 const result=makeShareable('[External](https://example.com/people/private?x=1) [Anchor](#section)');
 expect(result).toContain('https://example.com/people/private?x=1');expect(result).toContain('](#section)');
});
test('confirmation label is not itself interpreted as a conf number',()=>{
 expect(makeShareable('**Confirmation:** ABC123DEF')).toBe('**Confirmation:** on file');
});
test('CRLF frontmatter and bare Timeline remain private',()=>{
 const result=makeShareable('---\r\nowner: PRIVATE_OWNER\r\n---\r\n# Public\r\n\r\n## Timeline\r\nPRIVATE_TIMELINE');
 expect(result).not.toContain('PRIVATE_');expect(result).toContain('# Public');
});
test('actual CLI handler defaults encrypted and requires explicit public output',async()=>{
 const root=mkdtempSync(join(tmpdir(),'publish-privacy-'));try{
  const page=join(root,'page.md');writeFileSync(page,'# Synthetic\n\nPUBLIC_BODY');
  await runPublish([page,'--out',join(root,'default.html')]);
  const encrypted=readFileSync(join(root,'default.html'),'utf8');expect(encrypted).toContain('window.__CT');expect(encrypted).not.toContain('PUBLIC_BODY');
  await runPublish([page,'--public','--out',join(root,'public.html')]);
  const open=readFileSync(join(root,'public.html'),'utf8');expect(open).not.toContain('window.__CT');expect(open).toContain('PUBLIC_BODY');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('private local URI schemes are stripped but public schemes survive',()=>{
 const input='[File](file:///Users/example/people/private.md) [Vault](vault://people/private) [Brain](gbrain://people/private) [Obsidian](obsidian://open?vault=private) [Email](mailto:public@example.com) [Phone](tel:+15555550123)';
 const result=makeShareable(input);expect(result).toBe('File Vault Brain Obsidian [Email](mailto:public@example.com) [Phone](tel:+15555550123)');
});
test('default encrypted title contains no inferred private page data',async()=>{
 const root=mkdtempSync(join(tmpdir(),'publish-private-title-'));try{
  const page=join(root,'page.md');writeFileSync(page,'---\ntitle: PRIVATE_FRONTMATTER_TITLE\n---\n# PRIVATE_H1_TITLE\n\nPRIVATE_BODY');
  await runPublish([page,'--out',join(root,'default.html')]);
  const encrypted=readFileSync(join(root,'default.html'),'utf8');expect(encrypted).toContain('<title>Protected document</title>');expect(encrypted).not.toContain('PRIVATE_');
  await runPublish([page,'--password','fixture-password','--title','Approved public title','--out',join(root,'explicit.html')]);
  const explicit=readFileSync(join(root,'explicit.html'),'utf8');expect(explicit).toContain('<title>Approved public title</title>');expect(explicit).not.toContain('PRIVATE_');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('inline public JSON cannot terminate a script element',()=>{
 const html=generateHtml({title:'Fixture',markdown:'</ScRiPt><img src="https://example.invalid/automatic.png"><script>REVIEW_EXECUTED=1',encrypted:null});
 expect(html).not.toContain('</ScRiPt>');expect(html).toContain('\\u003c/ScRiPt>');
});
test('private references, nested destinations and raw HTML paths disappear',()=>{
 const result=makeShareable('[Private colleague][person] ![Private image][image] [External][external]\n\n[person]: /people/PRIVATE_PERSON.md\n[image]: file:///PRIVATE_IMAGE.png\n[external]: https://example.com/public\n\n[Nested](/people/PRIVATE_(TEAM).md) <a href="file:///PRIVATE_RAW.md">Raw label</a>');
 expect(result).not.toContain('PRIVATE_');expect(result).toContain('Private colleague');expect(result).toContain('https://example.com/public');expect(result).toContain('Nested');
});
