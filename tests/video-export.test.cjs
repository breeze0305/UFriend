'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {burnVideoSubtitles,VideoExportError,createSubtitleScript}=require('../app/services/video-export.cjs');

const ffmpegPath=process.env.UFRIEND_TEST_FFMPEG||(process.platform==='win32'?'C:/ffmpeg/bin/ffmpeg.exe':'/usr/bin/ffmpeg');
const ffprobePath=path.join(path.dirname(ffmpegPath),process.platform==='win32'?'ffprobe.exe':'ffprobe');
const realFFmpeg={skip:fs.existsSync(ffmpegPath)&&fs.existsSync(ffprobePath)?false:'Install FFmpeg/ffprobe or set UFRIEND_TEST_FFMPEG to run synthetic video tests'};
const segments=[{start:0.2,end:1.8,text:'字幕測試：你好，世界！\nUFriend subtitle export'}];

function temporary(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ufriend-video-test-'));
  t.after(()=>{
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('ufriend-video-test-'));
    fs.rmSync(dir,{recursive:true,force:true});
  });return dir;
}

function ffmpeg(args) {
  const result=spawnSync(ffmpegPath,['-hide_banner','-loglevel','error','-nostdin',...args],{shell:false,windowsHide:true,maxBuffer:16*1024*1024});
  assert.equal(result.status,0,result.stderr?.toString());return result.stdout;
}

function createVideo(file,{audio=false,odd=false}={}) {
  const args=['-n','-f','lavfi','-i',odd?'nullsrc=size=321x241:rate=10,format=yuv444p':'color=c=black:size=640x360:rate=10'];
  if(audio) args.push('-f','lavfi','-i','sine=frequency=440:sample_rate=48000');
  args.push('-t','2','-map','0:v:0');if(audio) args.push('-map','1:a:0','-c:a','aac');
  args.push('-c:v',odd?'ffv1':'libx264','-pix_fmt',odd?'yuv444p':'yuv420p',file);ffmpeg(args);
  return fs.readFileSync(file);
}

function probe(file) {
  const result=spawnSync(ffprobePath,['-v','error','-show_streams','-show_format','-of','json',file],{shell:false,windowsHide:true,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}

function frame(file,time) {return ffmpeg(['-ss',String(time),'-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);}

test('ASS treats braces, backslashes, HTML, commas and event-looking text as plain subtitle content',()=>{
  const text='你好 {\\pos(0,0)} \\N \\n \\h <b>bold</b>, <script>alert(1)</script>\n[Events]\nDialogue: 9,evil\u2028last';
  const script=createSubtitleScript([{start:0.201,end:1.809,text}],{width:3840,height:2160});
  const events=script.split('\r\n').filter(line=>line.startsWith('Dialogue:'));
  assert.equal(events.length,1);
  assert.ok(events[0].includes('0:00:00.20,0:00:01.81'));
  assert.ok(events[0].includes('\\{\\\u2060pos(0,0)\\}'));
  assert.ok(events[0].includes('\\\u2060N'));
  assert.ok(events[0].includes('\\\u2060n'));
  assert.ok(events[0].includes('\\\u2060h'));
  assert.ok(events[0].includes('<b>bold</b>'));
  assert.ok(events[0].includes('\\N[Events]\\NDialogue: 9,evil\\Nlast'));
  assert.equal((script.match(/^\[Events\]$/gm)||[]).length,1);
});

test('ASS wraps long CJK lines without losing text and retains very short positive cues',()=>{
  const text='這是沒有空白而且需要在直式影片中自動換行的繁體中文字幕測試內容';
  const script=createSubtitleScript([{start:0.201,end:0.202,text}],{width:360,height:640});
  const event=script.split('\r\n').find(line=>line.startsWith('Dialogue:'));
  assert.ok(event.includes('0:00:00.20,0:00:00.21'));
  const escaped=event.split(',').slice(9).join(',');assert.ok(escaped.includes('\\N'));assert.equal(escaped.replace(/\\N/g,''),text);
});

test('invalid, empty, nonfinite, zero-length and unordered subtitle timings are rejected before file access',async()=>{
  for(const invalid of [[],null,[null],[{start:0,end:0,text:'x'}],[{start:-1,end:1,text:'x'}],[{start:0,end:NaN,text:'x'}],[{start:0,end:Infinity,text:'x'}],[{start:0,end:596*3600,text:'x'}],[{start:0,end:1,text:' '}],[{start:0,end:1,text:'\u0001'}],[{start:2,end:3,text:'x'},{start:1,end:2,text:'y'}],[{start:null,end:1,text:'x'}]]) {
    assert.throws(()=>createSubtitleScript(invalid),{code:'VIDEO_INVALID_SUBTITLES'});
    await assert.rejects(burnVideoSubtitles({sourcePath:'missing.mp4',outputPath:'result.mp4',segments:invalid}),{code:'VIDEO_INVALID_SUBTITLES'});
  }
});

test('source, existing output, and an existing hardlink to the source are never overwritten',async t=>{
  const dir=temporary(t),sourcePath=path.join(dir,'source.mp4'),outputPath=path.join(dir,'existing.mp4'),alias=path.join(dir,'alias.mp4');
  fs.writeFileSync(sourcePath,'original video');fs.writeFileSync(outputPath,'existing content');fs.linkSync(sourcePath,alias);
  for(const target of [sourcePath,outputPath,alias]) await assert.rejects(burnVideoSubtitles({sourcePath,outputPath:target,segments,ffmpegPath}),{code:'VIDEO_OUTPUT_EXISTS'});
  assert.equal(fs.readFileSync(sourcePath,'utf8'),'original video');assert.equal(fs.readFileSync(outputPath,'utf8'),'existing content');assert.equal(fs.readdirSync(dir).length,3);
});

test('URLs, network shares and non-MP4 outputs are rejected',async t=>{
  const dir=temporary(t);
  for(const sourcePath of ['https://example.test/video.mp4','file:///tmp/video.mp4','\\\\server\\share\\video.mp4']) await assert.rejects(burnVideoSubtitles({sourcePath,outputPath:path.join(dir,'result.mp4'),segments}),{code:'VIDEO_LOCAL_ONLY'});
  await assert.rejects(burnVideoSubtitles({sourcePath:path.join(dir,'source.mp4'),outputPath:path.join(dir,'result.avi'),segments}),{code:'VIDEO_INVALID_OUTPUT'});
  assert.deepEqual(fs.readdirSync(dir),[]);
});

for(const audio of [false,true]) test(`real FFmpeg burns visible Chinese/English pixels into MP4 with ${audio?'AAC audio':'no audio track'} and keeps source intact`,realFFmpeg,async t=>{
  const dir=temporary(t),nested=path.join(dir,"繁中 ' 引號 [folder];");fs.mkdirSync(nested);
  const sourcePath=path.join(nested,"source ' ; 原始.mp4"),outputPath=path.join(nested,"finished ' ; 字幕.mp4");
  const original=createVideo(sourcePath,{audio}),reports=[];
  const result=await burnVideoSubtitles({sourcePath,outputPath,segments,ffmpegPath,durationSeconds:2,onProgress:value=>reports.push(value)});
  assert.equal(result.outputPath,fs.realpathSync.native(outputPath));assert.equal(result.size,fs.statSync(outputPath).size);assert.ok(result.seconds>=1.8);
  const info=probe(outputPath),video=info.streams.find(stream=>stream.codec_type==='video'),audios=info.streams.filter(stream=>stream.codec_type==='audio');
  assert.equal(video.codec_name,'h264');assert.equal(video.pix_fmt,'yuv420p');assert.equal(video.width,640);assert.equal(video.height,360);assert.equal(audios.length,audio?1:0);if(audio) assert.equal(audios[0].codec_name,'aac');
  const before=frame(sourcePath,0.5),after=frame(outputPath,0.5),outsideCue=frame(outputPath,0.1);
  assert.equal(after.length,before.length);assert.ok(after.some((byte,index)=>byte>before[index]+100),'subtitle is encoded into the video pixels');
  assert.ok(after.subarray(640*240*3).filter(byte=>byte>160).length>300,'visible white glyphs appear in the bottom of the frame');
  assert.ok(after.subarray(0,640*200*3).every(byte=>byte<15),'the top of the black frame stays black');
  assert.ok(outsideCue.every(byte=>byte<15),'no subtitle appears outside its timestamp');
  assert.deepEqual(fs.readFileSync(sourcePath),original);assert.deepEqual(fs.readdirSync(nested).sort(),[path.basename(sourcePath),path.basename(outputPath)].sort());
  assert.equal(reports[0].stage,'started');assert.equal(reports.at(-1).stage,'complete');assert.equal(reports.at(-1).progress,1);assert.ok(reports.every(report=>report.progress>=0&&report.progress<=1));
});

test('real FFmpeg pads odd dimensions without scaling away source pixels',realFFmpeg,async t=>{
  const dir=temporary(t),sourcePath=path.join(dir,'odd.mkv'),outputPath=path.join(dir,'result.mp4');createVideo(sourcePath,{odd:true});
  await burnVideoSubtitles({sourcePath,outputPath,segments,ffmpegPath});
  const video=probe(outputPath).streams.find(stream=>stream.codec_type==='video');assert.equal(video.width,322);assert.equal(video.height,242);assert.equal(video.pix_fmt,'yuv420p');
});

test('rotation metadata becomes upright portrait pixels before subtitle layout, without a second playback rotation',realFFmpeg,async t=>{
  const dir=temporary(t),plain=path.join(dir,'landscape.mp4'),sourcePath=path.join(dir,'phone-portrait.mp4'),outputPath=path.join(dir,'result.mp4');
  ffmpeg(['-n','-f','lavfi','-i','color=c=black:s=640x360:r=10,drawbox=x=0:y=0:w=320:h=180:color=red:t=fill,drawbox=x=320:y=0:w=320:h=180:color=green:t=fill,drawbox=x=0:y=180:w=320:h=180:color=blue:t=fill,drawbox=x=320:y=180:w=320:h=180:color=yellow:t=fill','-t','2','-c:v','libx264','-pix_fmt','yuv420p',plain]);
  ffmpeg(['-n','-display_rotation:v:0','90','-i',plain,'-map','0','-c','copy',sourcePath]);
  const original=probe(sourcePath).streams.find(stream=>stream.codec_type==='video');
  assert.equal(original.width,640);assert.equal(original.height,360);assert.equal(original.side_data_list.find(item=>item.side_data_type==='Display Matrix').rotation,90);
  await burnVideoSubtitles({sourcePath,outputPath,segments,ffmpegPath});
  const video=probe(outputPath).streams.find(stream=>stream.codec_type==='video');
  assert.equal(video.width,360);assert.equal(video.height,640);assert.equal(video.sample_aspect_ratio,'1:1');assert.ok(!video.side_data_list?.some(item=>item.rotation));
  // Compare outside the cue: both decoders must present the same four quadrants.
  // Re-encoding changes a few edge pixels, so permit a small codec-error budget.
  const expected=frame(sourcePath,0.1),actual=frame(outputPath,0.1);
  assert.equal(actual.length,360*640*3);assert.equal(actual.length,expected.length);
  const averageDifference=actual.reduce((sum,byte,index)=>sum+Math.abs(byte-expected[index]),0)/actual.length;
  assert.ok(averageDifference<2,`upright color quadrants changed by ${averageDifference}`);
});

test('a competing destination created after start wins; no export temporary files remain',realFFmpeg,async t=>{
  const dir=temporary(t),sourcePath=path.join(dir,'source.mp4'),outputPath=path.join(dir,'result.mp4');createVideo(sourcePath);
  await assert.rejects(burnVideoSubtitles({sourcePath,outputPath,segments,ffmpegPath,onProgress:({stage})=>{if(stage==='started') fs.writeFileSync(outputPath,'other writer',{flag:'wx'});}}),{code:'VIDEO_OUTPUT_EXISTS'});
  assert.equal(fs.readFileSync(outputPath,'utf8'),'other writer');assert.deepEqual(fs.readdirSync(dir).sort(),['result.mp4','source.mp4']);
});

test('cancelling a running process waits for close and removes only its own temporary output',realFFmpeg,async t=>{
  const dir=temporary(t),sourcePath=path.join(dir,'source.mp4'),outputPath=path.join(dir,'result.mp4'),controller=new AbortController();const original=createVideo(sourcePath);let started=false;
  await assert.rejects(burnVideoSubtitles({sourcePath,outputPath,segments,ffmpegPath,signal:controller.signal,onProgress:({stage})=>{if(stage==='started') {started=true;controller.abort();}}}),{name:'AbortError',code:'ABORT_ERR'});
  assert.equal(started,true);assert.deepEqual(fs.readFileSync(sourcePath),original);assert.deepEqual(fs.readdirSync(dir),['source.mp4']);
});

test('cancelling after encoding progress prevents publication and cleans subtitles and partial MP4',realFFmpeg,async t=>{
  const dir=temporary(t),sourcePath=path.join(dir,'source.mp4'),outputPath=path.join(dir,'result.mp4'),controller=new AbortController();createVideo(sourcePath);let processing=false;
  await assert.rejects(burnVideoSubtitles({sourcePath,outputPath,segments,ffmpegPath,signal:controller.signal,onProgress:({stage})=>{if(stage==='processing') {processing=true;controller.abort();}}}),{code:'ABORT_ERR'});
  assert.equal(processing,true);assert.deepEqual(fs.readdirSync(dir),['source.mp4']);
});

test('an already cancelled request creates nothing; missing FFmpeg and invalid input errors contain no raw source text',async t=>{
  const dir=temporary(t),sourcePath=path.join(dir,'private-title.mp4'),outputPath=path.join(dir,'result.mp4'),controller=new AbortController();controller.abort();
  await assert.rejects(burnVideoSubtitles({sourcePath,outputPath,segments,signal:controller.signal}),{code:'ABORT_ERR'});assert.deepEqual(fs.readdirSync(dir),[]);
  fs.writeFileSync(sourcePath,'private media bytes');
  await assert.rejects(burnVideoSubtitles({sourcePath,outputPath,segments,ffmpegPath:path.join(dir,'missing-ffmpeg')}),error=>error instanceof VideoExportError&&error.code==='FFMPEG_NOT_FOUND'&&!error.message.includes('private')&&!error.detail&&!error.cause);
  assert.deepEqual(fs.readdirSync(dir),['private-title.mp4']);
});

test('invalid video fails with a local message and no transcript or source path in the error',realFFmpeg,async t=>{
  const dir=temporary(t),sourcePath=path.join(dir,'private-title.mp4'),outputPath=path.join(dir,'result.mp4');fs.writeFileSync(sourcePath,'private media bytes');
  await assert.rejects(burnVideoSubtitles({sourcePath,outputPath,segments,ffmpegPath}),error=>error.code==='VIDEO_INVALID_SOURCE'&&!error.message.includes('private')&&!error.detail&&!error.cause);
  assert.deepEqual(fs.readdirSync(dir),['private-title.mp4']);
});

test('completion observers cannot turn an already published MP4 into a failure',realFFmpeg,async t=>{
  const dir=temporary(t),sourcePath=path.join(dir,'source.mp4'),outputPath=path.join(dir,'result.mp4'),controller=new AbortController();createVideo(sourcePath);
  const result=await burnVideoSubtitles({sourcePath,outputPath,segments,ffmpegPath,signal:controller.signal,onProgress:({stage})=>{if(stage==='complete') {controller.abort();throw new Error('observer failure');}}});
  assert.equal(result.outputPath,fs.realpathSync.native(outputPath));assert.ok(result.size>32);assert.deepEqual(fs.readdirSync(dir).sort(),['result.mp4','source.mp4']);
});
