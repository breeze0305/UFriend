'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {once}=require('node:events');
const {LocalLlmApiAdapter}=require('../app/models/local-llm-api.cjs');
async function fixture(t,handler){const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});const settings={compute:'dev-api',devLlm:{endpoint:'http://127.0.0.1:'+server.address().port}};return{settings,adapter:new LocalLlmApiAdapter({getSettings:()=>settings})};}
const json=(res,value)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
test('each request uses a snapshot of only its own saved prompt override',async t=>{
  const requests=[];const f=await fixture(t,async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push(JSON.parse(Buffer.concat(chunks)));json(res,{apiVersion:'1',text:'complete'});});
  f.settings.llmPrompts={chat:{system:'chat experiment',user:'{{text}}'},polish:{system:'polish experiment',user:'{{text}}'}};
  const input={messages:[{role:'user',content:'question'}]};await f.adapter.run({task:'chat',input});
  assert.deepEqual(requests[0],{task:'chat',input,prompt:{system:'chat experiment',user:'{{text}}'}});
  delete f.settings.llmPrompts.chat;await f.adapter.run({task:'chat',input});assert.deepEqual(requests[1],{task:'chat',input});
});
test('prompt catalog loads real service defaults and refuses incomplete catalogs',async t=>{
  let valid=true;const tasks=Object.fromEntries(['mail','polish','chat','translate'].map(task=>[task,{system:task+' default',user:task==='mail'?'{{lines}}':'{{text}}'}]));
  const f=await fixture(t,(req,res)=>{assert.equal(req.url,'/v1/prompts');json(res,{apiVersion:'1',tasks:valid?tasks:{chat:tasks.chat}});});
  const catalog=await f.adapter.prompts();assert.equal(catalog.tasks.mail.system,'mail default');assert.deepEqual(catalog.tasks.translate.requiredVariables,['text']);
  valid=false;await assert.rejects(f.adapter.prompts(),{code:'MODEL_API_INCOMPATIBLE'});
});
