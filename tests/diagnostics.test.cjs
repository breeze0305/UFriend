'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {Diagnostics}=require('../app/services/diagnostics.cjs');
const root=path.resolve(__dirname,'../.test-data/diagnostics-tests');
async function fixture(t,options={}){await fs.mkdir(root,{recursive:true});const directory=await fs.mkdtemp(path.join(root,'case-'));t.after(async()=>{assert.equal(path.dirname(directory),root);await fs.rm(directory,{recursive:true,force:true});});return new Diagnostics({directory,version:'test',...options});}
test('diagnostics persists correlated technical fields while excluding content, credentials and endpoint paths',async t=>{
  const logger=await fixture(t),requestId='05a5d764-104b-4e81-b5cc-30c849bfcbf5';
  await logger.write({event:'llm.failed',level:'error',task:'chat',requestId,code:'MODEL_OUTPUT_LIMIT',finishReason:'length',durationMs:123.4,endpoint:'http://127.0.0.1:8765/private?token=secret',message:'private reply',prompt:'private prompt',input:'private mail',Authorization:'Bearer private-token',stack:'private path'});
  const exported=await logger.export(),entry=exported.entries[0],raw=JSON.stringify(exported);
  assert.equal(entry.requestId,requestId);assert.equal(entry.finishReason,'length');assert.equal(entry.durationMs,123);assert.equal(entry.endpoint,'http://127.0.0.1:8765');assert(!raw.includes('private'));assert(!raw.includes('secret'));
});
test('diagnostic rotation keeps bounded files and preserves ordered complete JSON records',async t=>{
  const logger=await fixture(t,{maxBytes:1024,retainedFiles:3});
  await Promise.all(Array.from({length:50},(_,index)=>logger.write({event:'llm.done',durationMs:index,code:'DONE'})));
  const files=await fs.readdir(logger.directory);assert.equal(files.length,3);
  for(const file of files)assert((await fs.stat(path.join(logger.directory,file))).size<=1024);
  const entries=(await logger.export()).entries;assert(entries.length>1&&entries.length<50);assert.equal(entries.at(-1).durationMs,49);assert(entries.every((entry,index)=>!index||entry.durationMs>entries[index-1].durationMs));
});
test('a failed diagnostic write is observable without breaking the caller, and later writes recover',async t=>{
  const logger=await fixture(t);await fs.writeFile(logger.fileAt(0),'');
  const occupied=path.join(logger.directory,'occupied');await fs.writeFile(occupied,'fixture');logger.file=path.join(occupied,'events.jsonl');
  await logger.write({event:'llm.failed'});assert(logger.info().error);logger.file=path.join(logger.directory,'events.jsonl');await logger.write({event:'llm.done'});assert.equal(logger.info().error,'');assert.equal((await logger.export()).entries.length,1);
});
test('fatal diagnostics are written synchronously with the same content exclusions',async t=>{
  const logger=await fixture(t);logger.writeFatal({event:'app.crashed',code:'EIO',errorName:'Error',message:'private crash content',stack:'private stack'});
  const raw=await fs.readFile(logger.file,'utf8'),entry=JSON.parse(raw);assert.equal(entry.event,'app.crashed');assert.equal(entry.level,'error');assert(!raw.includes('private'));
});

test('clear follows queued writes, removes old rotation settings, and preserves later events and unrelated files',async t=>{
  const logger=await fixture(t,{retainedFiles:2});
  await fs.writeFile(logger.fileAt(9),JSON.stringify({event:'old.retention'})+'\n');
  const unrelated=['export.jsonl','events.10.jsonl','notes.txt'];
  for(const file of unrelated)await fs.writeFile(path.join(logger.directory,file),'keep');
  await fs.mkdir(path.join(logger.directory,'PC-LLM-API'));await fs.writeFile(path.join(logger.directory,'PC-LLM-API','events.jsonl'),'keep');
  let release;logger.queue=new Promise(resolve=>{release=resolve;});
  const before=logger.write({event:'old.queued'}),clearing=logger.clear(),after=logger.write({event:'new.queued'});
  release();await Promise.all([before,clearing,after]);
  assert.deepEqual((await logger.export()).entries.map(entry=>entry.event),['new.queued']);
  assert.equal(await fs.stat(logger.fileAt(9)).then(()=>true,()=>false),false);
  for(const file of unrelated)assert.equal(await fs.readFile(path.join(logger.directory,file),'utf8'),'keep');
  assert.equal(await fs.readFile(path.join(logger.directory,'PC-LLM-API','events.jsonl'),'utf8'),'keep');
  logger.writeFatal({event:'new.fatal'});assert.deepEqual((await logger.export()).entries.map(entry=>entry.event),['new.queued','new.fatal']);
});

test('clear reports deletion failures while keeping the queue writable and retryable',async t=>{
  const logger=await fixture(t);await logger.write({event:'old.event'});await fs.mkdir(logger.fileAt(1));
  await assert.rejects(logger.clear());assert(logger.info().error);
  await logger.write({event:'new.event'});assert.equal(logger.info().error,'');
  assert.equal(JSON.parse((await fs.readFile(logger.file,'utf8')).trim()).event,'new.event');
  await fs.rmdir(logger.fileAt(1));await logger.clear();assert.deepEqual((await logger.export()).entries,[]);
  await logger.clear();assert.equal(logger.info().error,'');
});

test('cleanup info counts owned regular files across past retention settings without reading or changing them',async t=>{
  const logger=await fixture(t,{retainedFiles:1});assert.deepEqual(await logger.cleanupInfo(),{files:0,bytes:0});
  await fs.writeFile(logger.file,'old');await fs.writeFile(logger.fileAt(9),'old rotation');await fs.writeFile(path.join(logger.directory,'events.10.jsonl'),'unrelated');await fs.mkdir(logger.fileAt(2));
  assert.deepEqual(await logger.cleanupInfo(),{files:2,bytes:15});assert.equal(await fs.readFile(logger.file,'utf8'),'old');assert.equal(await fs.readFile(logger.fileAt(9),'utf8'),'old rotation');
  await fs.rmdir(logger.fileAt(2));assert.deepEqual(await logger.clear(),{deletedFiles:2});assert.deepEqual(await logger.cleanupInfo(),{files:0,bytes:0});
  assert.equal(await fs.readFile(path.join(logger.directory,'events.10.jsonl'),'utf8'),'unrelated');
});

test('clear and cleanup info reject a redirected diagnostic directory without touching an external sentinel',async t=>{
  const base=await fixture(t),external=path.join(base.directory,'external'),directory=path.join(base.directory,'diagnostics');
  await fs.mkdir(external);const sentinel=path.join(external,'events.jsonl');await fs.writeFile(sentinel,'external sentinel');await fs.symlink(external,directory,'junction');
  const logger=new Diagnostics({directory});await assert.rejects(logger.cleanupInfo(),/目錄不安全/);await assert.rejects(logger.clear(),/目錄不安全/);
  assert.equal(await fs.readFile(sentinel,'utf8'),'external sentinel');assert(logger.info().error);
  await fs.unlink(directory);await fs.mkdir(directory);await logger.write({event:'new.safe.event'});assert.equal((await logger.cleanupInfo()).files,1);
  assert.deepEqual(await logger.clear(),{deletedFiles:1});assert.equal(await fs.readFile(sentinel,'utf8'),'external sentinel');
});
