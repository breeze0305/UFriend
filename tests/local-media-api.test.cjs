'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {once}=require('node:events');
const {LocalMediaApiAdapter,endpoint,validateResult}=require('../app/models/local-media-api.cjs');

const JOB='fixture_job_000001';
const META={model:'fixture-model',backend:'fixture-backend'};
const ASR={segments:[{start:0,end:1.25,text:' 測試逐字稿。 '}],language:'zh',duration:2,meta:META};
const OCR={text:' 辨識文字。 ',regions:[{text:'辨識文字。',confidence:0.98,box:[[0,0],[100,0],[100,20],[0,20]]}],meta:META};
const TEST_ROOT=path.resolve(__dirname,'../.test-data');

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
function json(response,value,status=200){response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify({apiVersion:'1',...value}));}
async function bytes(request){const chunks=[];for await(const chunk of request)chunks.push(chunk);return Buffer.concat(chunks);}
function completed(result){return{jobId:JOB,status:'completed',progress:1,result};}
function adapter(kind,base,options={}){return new LocalMediaApiAdapter({kind,getSettings:()=>({compute:'dev-api',devOcr:{endpoint:base},devWhisper:{endpoint:base}}),pollMs:1,timeoutMs:2000,...options});}
async function serverFixture(t,handler){
  const errors=[];
  const server=http.createServer((request,response)=>{
    Promise.resolve().then(()=>handler(request,response)).catch(error=>{
      errors.push(error);
      if(!response.headersSent)json(response,{error:{code:'FIXTURE_FAILURE'}},500);
      else response.destroy();
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    assert.deepEqual(errors,[],'the HTTP fixture must not fail internally');
  });
  return{base:'http://127.0.0.1:'+server.address().port,server};
}
async function fileFixture(t,name='會議 錄音.wav',content=Buffer.from('synthetic audio\0\xff','latin1')){
  await fs.mkdir(TEST_ROOT,{recursive:true});
  const directory=await fs.mkdtemp(path.join(TEST_ROOT,'local-media-api-'));
  t.after(async()=>{
    assert.ok(path.resolve(directory).startsWith(TEST_ROOT+path.sep));
    await fs.rm(directory,{recursive:true,force:true});
  });
  const filePath=path.join(directory,name);await fs.writeFile(filePath,content);
  return{filePath,directory,content};
}
async function jobFixture(t,{kind='whisper',result=ASR,onUpload,onPoll,onDelete}={}){
  let uploads=0,polls=0,deletes=0;
  const fixture=await serverFixture(t,async(request,response)=>{
    if(request.method==='POST'&&request.url==='/v1/jobs'){
      uploads++;const body=await bytes(request);
      if(onUpload)return onUpload(request,response,body);
      json(response,{jobId:JOB});return;
    }
    assert.equal(request.url,'/v1/jobs/'+JOB);
    if(request.method==='DELETE'){
      deletes++;if(onDelete)return onDelete(request,response);
      json(response,{jobId:JOB,status:'cancelled'});return;
    }
    assert.equal(request.method,'GET');polls++;
    if(onPoll)return onPoll(request,response,polls);
    json(response,completed(result));
  });
  return{...fixture,adapter:adapter(kind,fixture.base),counts:()=>({uploads,polls,deletes})};
}

test('only explicit API mode and loopback root HTTP endpoints can make requests',async t=>{
  for(const kind of ['ocr','whisper']){
    let calls=0;
    const settings={compute:'local'};
    const local=new LocalMediaApiAdapter({kind,getSettings:()=>settings,fetchImpl:()=>{calls++;throw new Error('must not fetch');}});
    assert.equal(local.isConfigured(),false);
    await assert.rejects(local.run({}),{code:'MODEL_NOT_CONFIGURED'});
    settings.compute='cloud';await assert.rejects(local.run({}),{code:'MODEL_NOT_CONFIGURED'});
    settings.compute='dev-api';assert.equal(local.isConfigured(),true);
    for(const value of ['https://127.0.0.1:8767','http://example.com','http://127.0.0.1@evil.example','http://user:pass@127.0.0.1','http://localhost/?secret=1','http://localhost/#secret','http://localhost/private','file:///private','http://192.168.1.10']){
      assert.throws(()=>endpoint(value,kind),{code:'MODEL_INVALID_REQUEST'});
      await assert.rejects(local.health({endpoint:value}),{code:'MODEL_INVALID_REQUEST'});
    }
    assert.equal(calls,0);
  }
  assert.equal(endpoint('http://127.0.0.1:8767/','ocr'),'http://127.0.0.1:8767');
  assert.equal(endpoint('http://[::1]:8768/','whisper'),'http://[::1]:8768');
  assert.equal(endpoint(undefined,'ocr'),'http://127.0.0.1:8767');
  assert.equal(endpoint(undefined,'whisper'),'http://127.0.0.1:8768');
});

test('each media kind checks its own endpoint, capability and readiness',async t=>{
  const calls=[];
  const ocr=await serverFixture(t,(request,response)=>{calls.push('ocr');assert.equal(request.method,'GET');assert.equal(request.url,'/health');json(response,{ready:true,capabilities:['ocr','other'],...META,privatePath:'must be discarded'});});
  const whisper=await serverFixture(t,(request,response)=>{calls.push('whisper');assert.equal(request.url,'/health');json(response,{ready:true,capabilities:['whisper'],...META});});
  const settings={compute:'dev-api',devOcr:{endpoint:ocr.base},devWhisper:{endpoint:whisper.base}};
  for(const kind of ['ocr','whisper']){
    const client=new LocalMediaApiAdapter({kind,getSettings:()=>settings});
    assert.deepEqual(await client.health(),{ok:true,apiVersion:'1',ready:true,capabilities:[kind],...META});
  }
  assert.deepEqual(calls,['ocr','whisper']);
  let health={ready:true,capabilities:['whisper'],...META};
  const invalid=await serverFixture(t,(request,response)=>json(response,health));
  const client=adapter('whisper',invalid.base);
  for(const [value,code] of [
    [{...health,capabilities:['ocr']},'MODEL_API_INCOMPATIBLE'],
    [{...health,ready:'yes'},'MODEL_API_INCOMPATIBLE'],
    [{...health,ready:false},'MODEL_API_UNAVAILABLE'],
    [{...health,model:''},'MODEL_INVALID_OUTPUT'],
    [{...health,apiVersion:'2'},'MODEL_API_INCOMPATIBLE'],
  ]){health=value;await assert.rejects(client.health(),{code});}
});

test('Whisper streams exact bytes with UTF-8 basename and language, then reports monotonic progress below 100',async t=>{
  const file=await fileFixture(t,'會議 & 音訊.wav',Buffer.alloc(256*1024,0xa5));
  const states=[
    {jobId:JOB,status:'running',progress:0.5,processedSeconds:1,durationSeconds:2},
    {jobId:JOB,status:'running',progress:0.25,processedSeconds:1.5,durationSeconds:2},
    {jobId:JOB,status:'running',progress:1,processedSeconds:2,durationSeconds:2},
    completed({...ASR,meta:{...META,privatePath:'discard'},extra:'discard'}),
  ];
  const fixture=await jobFixture(t,{
    onUpload:(request,response,body)=>{
      assert.deepEqual(body,file.content);
      assert.equal(request.headers['content-type'],'application/octet-stream');
      assert.equal(request.headers['content-length'],String(file.content.length));
      assert.equal(request.headers['x-ufriend-client'],'1');
      assert.equal(request.headers['x-ufriend-language'],'zh-TW');
      assert.equal(decodeURIComponent(request.headers['x-ufriend-filename']),path.basename(file.filePath));
      assert.ok(!JSON.stringify(request.headers).includes(file.directory));
      json(response,{jobId:JOB});
    },
    onPoll:(request,response,index)=>json(response,states[index-1]),
  });
  let streamed=false;
  fixture.adapter.fetch=(url,options)=>{
    if(options.method==='POST'){streamed=true;assert.equal(typeof options.body.getReader,'function');assert.equal(options.duplex,'half');assert.equal(Buffer.isBuffer(options.body),false);}
    return fetch(url,options);
  };
  const progress=[];
  const output=await fixture.adapter.run({task:'transcribe',input:{filePath:file.filePath,language:'zh-TW',privatePath:'must not be sent'},onProgress:(value,details)=>progress.push({value,...details})});
  assert.ok(streamed);
  assert.deepEqual(output,{segments:[{start:0,end:1.25,text:'測試逐字稿。'}],language:'zh',duration:2,meta:META});
  assert.deepEqual(progress.map(item=>item.value),[50,50,99,99]);
  assert.equal(progress[3].stage,'completed');assert.equal(progress[3].processedSeconds,2);assert.equal(progress[3].durationSeconds,2);
  assert.deepEqual(fixture.counts(),{uploads:1,polls:4,deletes:0});
  assert.equal(fixture.adapter.activeRuns.size,0);
});

test('OCR uploads image bytes and accepts both text regions and an empty recognition',async t=>{
  for(const [name,mime,result] of [['掃描.JPEG','image/jpeg',OCR],['空白.png','image/png',{text:'  ',regions:[],meta:META}]]){
    const file=await fileFixture(t,name);
    const fixture=await jobFixture(t,{kind:'ocr',result,onUpload:(request,response,body)=>{
      assert.deepEqual(body,file.content);assert.equal(request.headers['content-type'],mime);
      assert.equal(request.headers['x-ufriend-language'],undefined);
      assert.equal(request.headers['x-ufriend-filename'],undefined);
      json(response,{jobId:JOB});
    }});
    const output=await fixture.adapter.run({task:'recognize',input:{filePath:file.filePath}});
    assert.equal(output.text,result.text.trim());assert.deepEqual(output.regions,result.regions);
    assert.equal(fixture.counts().deletes,0);
  }
  const sanitized=validateResult('ocr',OCR);
  assert.notEqual(sanitized.regions,OCR.regions);assert.notEqual(sanitized.regions[0].box[0],OCR.regions[0].box[0]);
});

test('silent audio is a valid empty result and an omitted input language becomes auto',async t=>{
  const file=await fileFixture(t);
  const result={segments:[],language:'zh',duration:3.2,meta:META};
  const fixture=await jobFixture(t,{result,onUpload:(request,response)=>{assert.equal(request.headers['x-ufriend-language'],'auto');json(response,{jobId:JOB});}});
  assert.deepEqual(await fixture.adapter.run({task:'transcribe',input:{filePath:file.filePath}}),result);
  assert.equal(fixture.counts().deletes,0);
});

test('malformed OCR and transcript results never become successful jobs',async t=>{
  const file=await fileFixture(t);
  const invalid=[
    ['ocr',{...OCR,regions:[{...OCR.regions[0],confidence:1.01}]}],
    ['ocr',{...OCR,regions:[{...OCR.regions[0],box:[[0,0],[1,0],[1,1]]}]}],
    ['ocr',{...OCR,regions:[{...OCR.regions[0],box:[[-1,0],[1,0],[1,1],[0,1]]}]}],
    ['ocr',{...OCR,text:null}],
    ['whisper',{...ASR,segments:[{start:-0.1,end:1,text:'invalid'}]}],
    ['whisper',{...ASR,segments:[{start:1,end:0.5,text:'invalid'}]}],
    ['whisper',{...ASR,segments:[{start:1,end:2,text:'first'},{start:0,end:1,text:'second'}]}],
    ['whisper',{...ASR,segments:[{start:0,end:3.01,text:'past duration'}]}],
    ['whisper',{...ASR,segments:[{start:0,end:1,text:'  '}]}],
    ['whisper',{...ASR,duration:-1}],
    ['whisper',{...ASR,language:''}],
    ['whisper',{...ASR,meta:{model:'',backend:'fixture'}}],
  ];
  for(const [kind,result] of invalid){
    const fixture=await jobFixture(t,{kind,result});
    await assert.rejects(fixture.adapter.run({task:kind==='ocr'?'recognize':'transcribe',input:{filePath:file.filePath}}),{code:'MODEL_INVALID_OUTPUT'});
    assert.equal(fixture.counts().deletes,1);assert.equal(fixture.adapter.activeRuns.size,0);
  }
});

test('invalid job IDs and polling states are rejected with cleanup when an ID is known',async t=>{
  const file=await fileFixture(t);
  const badId=await jobFixture(t,{onUpload:(request,response)=>json(response,{jobId:'../private'})});
  await assert.rejects(badId.adapter.run({task:'transcribe',input:{filePath:file.filePath}}),{code:'MODEL_INVALID_OUTPUT'});
  assert.deepEqual(badId.counts(),{uploads:1,polls:0,deletes:0});
  for(const state of [
    {...completed(ASR),jobId:'different_job_000001'},
    {...completed(ASR),status:'surprise'},
    {...completed(ASR),progress:-0.01},
    {...completed(ASR),progress:1.01},
    {...completed(ASR),progress:'1'},
  ]){
    const fixture=await jobFixture(t,{onPoll:(request,response)=>json(response,state)});
    await assert.rejects(fixture.adapter.run({task:'transcribe',input:{filePath:file.filePath}}),{code:'MODEL_INVALID_OUTPUT'});
    assert.equal(fixture.counts().deletes,1);
  }
});

test('cancellation closes an in-flight HTTP poll and awaits DELETE cleanup',async t=>{
  const file=await fileFixture(t),arrived=deferred(),closed=deferred(),deleted=deferred();
  const fixture=await jobFixture(t,{onPoll:(request,response)=>{response.on('close',closed.resolve);arrived.resolve();},onDelete:(request,response)=>{deleted.resolve();json(response,{jobId:JOB,status:'cancelled'});}});
  const controller=new AbortController();
  const pending=fixture.adapter.run({task:'transcribe',input:{filePath:file.filePath},signal:controller.signal});
  const rejection=assert.rejects(pending,{name:'AbortError'});
  await arrived.promise;controller.abort();await rejection;await closed.promise;await deleted.promise;
  assert.equal(fixture.counts().deletes,1);assert.equal(fixture.adapter.activeRuns.size,0);
});

test('a completed HTTP response arriving after cancellation cannot be applied',async t=>{
  const file=await fileFixture(t),arrived=deferred(),release=deferred();
  const fixture=await jobFixture(t,{onPoll:async(request,response)=>{arrived.resolve();await release.promise;json(response,completed(ASR));}});
  fixture.adapter.fetch=(url,options)=>fetch(url,options.method==='GET'?{...options,signal:undefined}:options);
  const controller=new AbortController(),progress=[];
  const pending=fixture.adapter.run({task:'transcribe',input:{filePath:file.filePath},signal:controller.signal,onProgress:value=>progress.push(value)});
  const rejection=assert.rejects(pending,{name:'AbortError'});
  await arrived.promise;controller.abort();release.resolve();await rejection;
  assert.deepEqual(progress,[]);assert.equal(fixture.counts().deletes,1);assert.equal(fixture.adapter.activeRuns.size,0);
});

test('cancelAll settles every active upload job after its DELETE completes',async t=>{
  const file=await fileFixture(t),allArrived=deferred(),allDeleted=deferred(),releaseDeletes=deferred();
  let polls=0,deletes=0;
  const fixture=await jobFixture(t,{
    onPoll:()=>{if(++polls===2)allArrived.resolve();},
    onDelete:async(request,response)=>{if(++deletes===2)allDeleted.resolve();await releaseDeletes.promise;json(response,{jobId:JOB,status:'cancelled'});},
  });
  const rejections=[1,2].map(()=>assert.rejects(fixture.adapter.run({task:'transcribe',input:{filePath:file.filePath}}),{name:'AbortError'}));
  await allArrived.promise;assert.equal(fixture.adapter.activeRuns.size,2);
  let cancelSettled=false;
  const cancellation=fixture.adapter.cancelAll().then(()=>{cancelSettled=true;});
  await allDeleted.promise;assert.equal(cancelSettled,false);releaseDeletes.resolve();
  await cancellation;await Promise.all(rejections);
  assert.equal(fixture.counts().deletes,2);assert.equal(fixture.adapter.activeRuns.size,0);
});

test('overall timeout keeps progress details and removes the remote job',async t=>{
  const file=await fileFixture(t);
  const fixture=await jobFixture(t,{onPoll:(request,response,index)=>{
    if(index===1)json(response,{jobId:JOB,status:'running',progress:0.5,processedSeconds:3,durationSeconds:6});
  }});
  fixture.adapter.timeoutMs=250;
  await assert.rejects(fixture.adapter.run({task:'transcribe',input:{filePath:file.filePath}}),error=>error.code==='MODEL_API_TIMEOUT'&&error.processedSeconds===3&&error.durationSeconds===6);
  assert.equal(fixture.counts().deletes,1);assert.equal(fixture.adapter.activeRuns.size,0);
});

test('API and failed-job errors retain safe codes while discarding service text',async t=>{
  const file=await fileFixture(t);
  const privateText='private audio and C:\\secret\\recording.wav';
  let response={status:429,code:'MODEL_API_BUSY'};
  const fixture=await serverFixture(t,async(request,res)=>{await bytes(request);json(res,{error:{code:response.code,message:privateText}},response.status);});
  const client=adapter('whisper',fixture.base);
  for(const [status,code,expected] of [[429,'MODEL_API_BUSY','MODEL_API_BUSY'],[413,'unknown','MODEL_INPUT_TOO_LONG'],[404,'unknown','MODEL_JOB_NOT_FOUND'],[503,'unknown','MODEL_API_UNAVAILABLE'],[422,'MODEL_INVALID_REQUEST','MODEL_INVALID_REQUEST']]){
    response={status,code};
    await assert.rejects(client.run({task:'transcribe',input:{filePath:file.filePath}}),error=>error.code===expected&&!error.message.includes(privateText)&&!error.message.includes('C:\\secret'));
  }
  for(const [status,code,expected] of [['failed','MODEL_PROCESSING_FAILED','MODEL_PROCESSING_FAILED'],['failed','unknown','MODEL_PROCESSING_FAILED'],['failed','MODEL_INPUT_TOO_LONG','MODEL_INPUT_TOO_LONG'],['cancelled',undefined,'MODEL_CANCELLED']]){
    const job=await jobFixture(t,{onPoll:(request,res)=>json(res,{jobId:JOB,status,progress:0.5,processedSeconds:2,durationSeconds:4,error:{code,message:privateText}})});
    await assert.rejects(job.adapter.run({task:'transcribe',input:{filePath:file.filePath}}),error=>error.code===expected&&error.processedSeconds===2&&error.durationSeconds===4&&!error.message.includes(privateText));
    assert.equal(job.counts().deletes,1);
  }
});

for(const [kind,cases] of Object.entries({
  ocr:[
    [403,'UNSAFE_REQUEST','MODEL_INVALID_REQUEST'],
    [415,'UNSUPPORTED_MEDIA_TYPE','MODEL_INVALID_REQUEST'],
    [413,'IMAGE_TOO_LARGE','MODEL_INPUT_TOO_LONG'],
    [400,'INVALID_IMAGE','MODEL_INVALID_REQUEST'],
    [408,'UPLOAD_TIMEOUT','MODEL_API_TIMEOUT'],
    [499,'REQUEST_CANCELLED','MODEL_CANCELLED'],
    [500,'MODEL_TIMEOUT','MODEL_API_TIMEOUT'],
    [500,'MODEL_PROCESS_EXIT','MODEL_API_UNAVAILABLE'],
    [500,'MODEL_LOAD_FAILED','MODEL_API_UNAVAILABLE'],
    [500,'OCR_FAILED','MODEL_PROCESSING_FAILED'],
    [500,'INVALID_MODEL_OUTPUT','MODEL_INVALID_OUTPUT'],
    [404,'JOB_NOT_FOUND','MODEL_JOB_NOT_FOUND'],
    [404,'NOT_FOUND','MODEL_API_INCOMPATIBLE'],
    [500,'INTERNAL_ERROR','MODEL_PROCESSING_FAILED'],
  ],
  whisper:[
    [403,'MODEL_API_FORBIDDEN','MODEL_INVALID_REQUEST'],
    [413,'MODEL_API_INPUT_TOO_LARGE','MODEL_INPUT_TOO_LONG'],
    [415,'MODEL_API_INVALID_REQUEST','MODEL_INVALID_REQUEST'],
    [400,'MODEL_API_INVALID_AUDIO','MODEL_INVALID_REQUEST'],
    [502,'MODEL_API_INVALID_RESPONSE','MODEL_INVALID_OUTPUT'],
    [500,'MODEL_API_TRANSCRIPTION_FAILED','MODEL_PROCESSING_FAILED'],
    [400,'MODEL_API_CANCELLED','MODEL_CANCELLED'],
    [404,'MODEL_API_JOB_NOT_FOUND','MODEL_JOB_NOT_FOUND'],
    [404,'MODEL_API_NOT_FOUND','MODEL_API_INCOMPATIBLE'],
  ],
}))test(kind+' service protocol codes map to safe desktop errors in HTTP and failed-job responses',async t=>{
  const file=await fileFixture(t,kind==='ocr'?'synthetic.png':'synthetic.wav');
  const privateText='private transcript, C:\\secret\\source.wav and worker stderr';
  const task=kind==='ocr'?'recognize':'transcribe';
  const expectedMessage={MODEL_INVALID_REQUEST:/檔案格式/,MODEL_INVALID_OUTPUT:/格式錯誤/,MODEL_API_TIMEOUT:/逾時/,MODEL_API_UNAVAILABLE:/獨立服務/,MODEL_API_INCOMPATIBLE:/不相容/};
  let current,delivery;
  const fixture=await jobFixture(t,{kind,
    onUpload:(request,response)=>delivery==='http'?json(response,{error:{code:current[1],message:privateText}},current[0]):json(response,{jobId:JOB}),
    onPoll:(request,response)=>json(response,{jobId:JOB,status:'failed',progress:0.5,processedSeconds:2,durationSeconds:4,error:{code:current[1],message:privateText}}),
  });
  for(current of cases){
    let httpMessage;
    for(delivery of ['http','job']){
      await assert.rejects(fixture.adapter.run({task,input:{filePath:file.filePath}}),error=>{
        assert.equal(error.code,current[2],delivery+' '+current[1]);
        assert.equal(typeof error.message,'string');assert(error.message.length>0);
        assert(!error.message.includes(privateText));assert(!error.message.includes('C:\\secret'));assert(!error.message.includes('stderr'));
        if(expectedMessage[error.code])assert.match(error.message,expectedMessage[error.code]);
        if(delivery==='http')httpMessage=error.message;
        else{assert.equal(error.message,httpMessage);assert.equal(error.processedSeconds,2);assert.equal(error.durationSeconds,4);}
        return true;
      });
      assert.equal(fixture.adapter.activeRuns.size,0);
    }
  }
  assert.deepEqual(fixture.counts(),{uploads:cases.length*2,polls:cases.length,deletes:cases.length});
});

test('unknown and malformed service codes cannot access inherited properties or expose diagnostics',async t=>{
  const file=await fileFixture(t);
  let code,delivery;
  const fixture=await jobFixture(t,{
    onUpload:(request,response)=>delivery==='http'?json(response,{error:{code,message:'private raw diagnostic'}},400):json(response,{jobId:JOB}),
    onPoll:(request,response)=>json(response,{jobId:JOB,status:'failed',progress:0,error:{code,message:'private raw diagnostic'}}),
  });
  for(code of ['constructor','toString','__proto__',null,{unexpected:'field'},['MODEL_TIMEOUT'],'UNKNOWN_SERVICE_CODE']){
    for(delivery of ['http','job'])await assert.rejects(fixture.adapter.run({task:'transcribe',input:{filePath:file.filePath}}),error=>{
      assert.equal(error.code,delivery==='http'?'MODEL_API_UNAVAILABLE':'MODEL_PROCESSING_FAILED');
      assert(!error.message.includes('private raw diagnostic'));assert(!error.message.includes('function'));
      return true;
    });
  }
  assert.equal(fixture.counts().deletes,7);
});

test('redirects are never followed and malformed or oversized JSON is rejected',async t=>{
  let targetCalls=0,mode='redirect';
  const target=await serverFixture(t,(request,response)=>{targetCalls++;json(response,{ready:true,capabilities:['ocr'],...META});});
  const source=await serverFixture(t,(request,response)=>{
    if(mode==='redirect'){response.writeHead(302,{Location:target.base+'/health'});response.end();return;}
    if(mode==='html'){response.writeHead(200,{'Content-Type':'text/html'});response.end('<h1>private service error</h1>');return;}
    response.writeHead(200,{'Content-Type':'application/json'});
    response.end(mode==='broken'?'{broken':JSON.stringify({apiVersion:'1',text:'x'.repeat(12*1024*1024)}));
  });
  const client=adapter('ocr',source.base);
  await assert.rejects(client.health(),{code:'MODEL_API_UNAVAILABLE'});assert.equal(targetCalls,0);
  for(const next of ['html','broken','oversize']){mode=next;await assert.rejects(client.health(),{code:'MODEL_INVALID_OUTPUT'});}
});

for(const kind of ['ocr','whisper'])test(kind+' rejects malformed UTF-8 result text and removes the remote job',async t=>{
  const file=await fileFixture(t,kind==='ocr'?'synthetic.png':'synthetic.wav');
  const invalid=[
    Buffer.from([0xc3,0x28]), // Invalid continuation byte.
    Buffer.from([0x80]), // Lone continuation byte.
    Buffer.from([0xed,0xa0,0x80]), // UTF-8 cannot encode a surrogate.
    Buffer.from([0xc0,0xaf]), // Overlong encoding.
    Buffer.from([0xe4,0xb8]), // Truncated multibyte character.
  ];
  let malformed;
  const result=kind==='ocr'?{...OCR,text:'UTF8_PAYLOAD'}:{...ASR,segments:[{start:0,end:1,text:'UTF8_PAYLOAD'}]};
  const [prefix,suffix]=JSON.stringify({apiVersion:'1',...completed(result)}).split('UTF8_PAYLOAD');
  const fixture=await jobFixture(t,{kind,onPoll:(request,response)=>{
    response.writeHead(200,{'Content-Type':'application/json'});
    response.end(Buffer.concat([Buffer.from(prefix),malformed,Buffer.from(suffix)]));
  }});
  for(malformed of invalid){
    await assert.rejects(fixture.adapter.run({task:kind==='ocr'?'recognize':'transcribe',input:{filePath:file.filePath}}),{code:'MODEL_INVALID_OUTPUT'});
    assert.equal(fixture.adapter.activeRuns.size,0);
  }
  assert.deepEqual(fixture.counts(),{uploads:invalid.length,polls:invalid.length,deletes:invalid.length});
});

test('valid multibyte UTF-8 split across response chunks is preserved',async()=>{
  const model={model:'本機模型 🐱',backend:'語音與影像辨識'};
  for(const kind of ['ocr','whisper']){
    const body=Buffer.from(JSON.stringify({apiVersion:'1',ready:true,capabilities:[kind],...model}));
    const client=adapter(kind,'http://127.0.0.1:8767',{fetchImpl:async()=>new Response(new ReadableStream({
      start(controller){for(let index=0;index<body.length;index++)controller.enqueue(body.subarray(index,index+1));controller.close();},
    }),{headers:{'Content-Type':'application/json'}})});
    assert.deepEqual(await client.health(),{ok:true,apiVersion:'1',ready:true,capabilities:[kind],...model});
  }
});

test('invalid files, language and tasks fail locally without exposing a filesystem path',async t=>{
  const file=await fileFixture(t),empty=path.join(file.directory,'empty.wav'),large=path.join(file.directory,'large.png');
  await fs.writeFile(empty,'');
  const handle=await fs.open(large,'w');await handle.truncate(40*1024*1024+1);await handle.close();
  let calls=0;
  const options={fetchImpl:()=>{calls++;throw new Error('must not fetch');}};
  const whisper=adapter('whisper','http://127.0.0.1:8768',options);
  const ocr=adapter('ocr','http://127.0.0.1:8767',options);
  for(const input of [
    {filePath:'relative.wav'},
    {filePath:'\\\\server\\share\\recording.wav'},
    {filePath:'//server/share/recording.wav'},
    {filePath:path.join(file.directory,'missing-private-file.wav')},
    {filePath:file.directory},
    {filePath:empty},
    {filePath:file.filePath,language:'invalid'},
  ])await assert.rejects(whisper.run({task:'transcribe',input}),error=>error.code==='MODEL_INVALID_REQUEST'&&!error.message.includes(file.directory)&&!error.message.includes('missing-private-file'));
  await assert.rejects(whisper.run({task:'recognize',input:{filePath:file.filePath}}),{code:'MODEL_INVALID_REQUEST'});
  await assert.rejects(ocr.run({task:'recognize',input:{filePath:large}}),{code:'MODEL_INPUT_TOO_LONG'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(whisper.run({task:'transcribe',input:{filePath:file.filePath},signal:controller.signal}),{name:'AbortError'});
  assert.equal(calls,0);assert.equal(whisper.activeRuns.size,0);
});
