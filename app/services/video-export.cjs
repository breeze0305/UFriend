'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {validateSegments}=require('./formats.cjs');

class VideoExportError extends Error {
  constructor(code,message,options) {super(message,options);this.name='VideoExportError';this.code=code;}
}

function aborted(signal) {
  if(signal?.aborted) {const error=new VideoExportError('ABORT_ERR','影片字幕輸出已取消。');error.name='AbortError';throw error;}
}

function localPath(value) {
  if(typeof value!=='string'||!value.trim()||value.includes('\0')) throw new VideoExportError('VIDEO_INVALID_PATH','請選擇有效的本機影片與輸出位置。');
  if(/^[\\/]{2}/.test(value)||(/^[a-z][a-z0-9+.-]*:/i.test(value)&&!(/^[a-z]:[\\/]/i.test(value)))) throw new VideoExportError('VIDEO_LOCAL_ONLY','影片字幕輸出只接受本機檔案與資料夾。');
  return path.resolve(value);
}

async function assertAbsent(file) {
  try {await fs.lstat(file);} catch(error) {if(error.code==='ENOENT') return;throw error;}
  throw new VideoExportError('VIDEO_OUTPUT_EXISTS','輸出檔案已存在，請選擇新的檔名。');
}

function subtitleSegments(segments) {
  try {
    if(!Array.isArray(segments)||!segments.length||segments.length>100000) throw new Error();
    for(const segment of segments) {
      if(!segment||!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.end<=segment.start||segment.end>=596*3600||typeof segment.text!=='string') throw new Error();
    }
    const normalized=validateSegments(segments).map(segment=>({...segment,text:cleanPlainText(segment.text).trim()}));
    if(normalized.some(segment=>!segment.text)) throw new Error();
    if(normalized.reduce((total,segment)=>total+segment.text.length,0)>8*1024*1024) throw new Error();
    return normalized;
  } catch {throw new VideoExportError('VIDEO_INVALID_SUBTITLES','逐字稿必須包含有效文字，以及依序排列且結束晚於開始的時間。');}
}

function assTime(centiseconds) {
  return `${Math.floor(centiseconds/360000)}:${String(Math.floor(centiseconds/6000)%60).padStart(2,'0')}:${String(Math.floor(centiseconds/100)%60).padStart(2,'0')}.${String(centiseconds%100).padStart(2,'0')}`;
}

function cleanPlainText(text) {
  return text.replace(/\r\n?/g,'\n').replace(/[\u2028\u2029]/g,'\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').replace(/\t/g,' ');
}

function wrapText(text,columns) {
  const graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'});
  return cleanPlainText(text).split('\n').map(line=>{
    const result=[];let current=[],width=0;
    const weight=value=>/^\s+$/u.test(value)?0.35:/^[\x20-\x7e]+$/.test(value)?0.6:1;
    for(const {segment} of graphemes.segment(line)) {
      if(current.length&&width+weight(segment)>columns) {
        const lastSpace=current.lastIndexOf(' ');
        if(lastSpace>current.length/2) {result.push(current.slice(0,lastSpace).join(''));current=current.slice(lastSpace+1);width=current.reduce((sum,value)=>sum+weight(value),0);}
        else {result.push(current.join(''));current=[];width=0;}
      }
      current.push(segment);width+=weight(segment);
    }
    result.push(current.join(''));return result.join('\n');
  }).join('\n');
}

function escapeAssText(text) {
  // libass explicitly supports escaped braces. A zero-width word joiner after a
  // literal backslash prevents \N, \n, \h and \{ from being parsed as escapes.
  // HTML is ordinary ASS text, so retain it literally instead of interpreting it.
  return text.replace(/[\\{}\n]/g,character=>character==='\\'?'\\\u2060':character==='\n'?'\\N':`\\${character}`);
}

function createSubtitleScript(segments,{width=1280,height=720}={}) {
  const normalized=subtitleSegments(segments);
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>65536||height>65536) throw new VideoExportError('VIDEO_INVALID_SOURCE','無法讀取影片的畫面尺寸。');
  const fontName=process.platform==='win32'?'Microsoft JhengHei':process.platform==='darwin'?'PingFang TC':'Noto Sans CJK TC';
  const fontSize=Math.max(1,Math.min(height*0.042,width*0.058,511));
  const margin=Math.max(1,Math.round(Math.min(width,height)*0.045));
  const columns=Math.max(4,(width-margin*2)/fontSize);
  const header=['[Script Info]','ScriptType: v4.00+','ScaledBorderAndShadow: yes','YCbCr Matrix: None',`PlayResX: ${width}`,`PlayResY: ${height}`,'WrapStyle: 2','','[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${fontSize.toFixed(2)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${Math.max(0.5,fontSize*0.075).toFixed(2)},0,2,${margin},${margin},${margin},1`,'','[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const events=normalized.map(segment=>{
    const start=Math.floor(segment.start*100),end=Math.max(start+1,Math.ceil(segment.end*100));
    const text=escapeAssText(wrapText(segment.text,columns));
    if(!text.trim()) throw new VideoExportError('VIDEO_INVALID_SUBTITLES','逐字稿不能只包含空白或控制字元。');
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`;
  });
  return '\uFEFF'+header.concat(events,'').join('\r\n');
}

function execute({ffmpegPath,args,cwd,signal,onLine,onSpawn,errorCode,errorMessage}) {
  return new Promise((resolve,reject)=>{
    let child,spawnError,observerError,killTimer;const pending={stdout:'',stderr:''};
    const stop=()=>{
      if(!child||child.exitCode!==null||child.signalCode!==null) return;
      child.kill('SIGTERM');
      if(!killTimer) {killTimer=setTimeout(()=>child.kill('SIGKILL'),1500);killTimer.unref();}
    };
    const observe=callback=>{if(!callback||observerError||signal?.aborted) return;try {callback();} catch {observerError=new VideoExportError('VIDEO_PROGRESS_ERROR','影片輸出進度回報失敗。');stop();}};
    try {aborted(signal);child=spawn(ffmpegPath,args,{cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});} catch(error) {reject(error);return;}
    signal?.addEventListener('abort',stop,{once:true});
    child.once('spawn',()=>{observe(onSpawn);if(signal?.aborted) stop();});
    child.once('error',error=>{spawnError=error;});
    for(const stream of ['stdout','stderr']) {
      child[stream].setEncoding('utf8');
      child[stream].on('data',chunk=>{
        pending[stream]+=chunk;const lines=pending[stream].split(/\r?\n/);pending[stream]=lines.pop();
        if(pending[stream].length>16000) pending[stream]='';
        for(const line of lines) observe(()=>onLine?.(stream,line));
      });
    }
    child.once('close',code=>{
      clearTimeout(killTimer);signal?.removeEventListener('abort',stop);
      try {aborted(signal);} catch(error) {reject(error);return;}
      if(observerError) {reject(observerError);return;}
      if(spawnError) {reject(new VideoExportError(spawnError.code==='ENOENT'?'FFMPEG_NOT_FOUND':'FFMPEG_START_FAILED',spawnError.code==='ENOENT'?'找不到影片處理工具，請重新安裝完整的 UFriend。':'無法啟動影片處理工具，請檢查執行權限。'));return;}
      if(code!==0) {const error=new VideoExportError(errorCode,errorMessage);error.exitCode=code;reject(error);return;}
      resolve();
    });
    if(signal?.aborted) stop();
  });
}

/** Burn the supplied timeline into a new local MP4 (H.264 and optional AAC).
 * FFmpeg must provide libass and libx264. Font lookup uses the OS font provider.
 * Progress is {stage:'started'|'processing'|'complete',seconds,progress?}; a 0..1
 * progress fraction is provided only when durationSeconds is finite and positive.
 * Existing files are never replaced, even when another writer races publication.
 * Cancellation waits for the child to exit before removing this job's temp files.
 */
async function burnVideoSubtitles({sourcePath,outputPath,segments,ffmpegPath='ffmpeg',signal,onProgress,durationSeconds}={}) {
  aborted(signal);
  const source=localPath(sourcePath),requested=localPath(outputPath),normalized=subtitleSegments(segments);
  if(path.extname(requested).toLowerCase()!=='.mp4') throw new VideoExportError('VIDEO_INVALID_OUTPUT','字幕影片請儲存為 MP4 檔案。');
  if(typeof ffmpegPath!=='string'||!ffmpegPath.trim()||ffmpegPath.includes('\0')) throw new VideoExportError('VIDEO_INVALID_FFMPEG','影片處理工具的程式路徑無效。');
  if(onProgress!==undefined&&typeof onProgress!=='function') throw new VideoExportError('VIDEO_INVALID_PROGRESS','影片輸出進度回報設定無效。');
  // Resolve explicit relative executable paths before changing the child cwd.
  if(/[\\/]/.test(ffmpegPath)) ffmpegPath=path.resolve(ffmpegPath);
  let realSource,outputDir,destination,temporaryDir,result,published=false;
  let seconds=0;
  const progress=stage=>({stage,seconds,...(Number.isFinite(durationSeconds)&&durationSeconds>0?{progress:stage==='complete'?1:Math.min(0.99,seconds/durationSeconds)}:{})});
  try {
    realSource=localPath(await fs.realpath(source));
    if(!(await fs.stat(realSource)).isFile()) throw new VideoExportError('VIDEO_INVALID_SOURCE','影片來源必須是一般檔案。');
    outputDir=localPath(await fs.realpath(path.dirname(requested)));destination=path.join(outputDir,path.basename(requested));
    await assertAbsent(destination);aborted(signal);
    temporaryDir=await fs.mkdtemp(path.join(outputDir,'.ufriend-video-'));
    let dimensions;
    // showinfo describes the decoded frame after FFmpeg's automatic rotation.
    // Only fixed numeric fields are retained, never the source metadata or stderr.
    await execute({ffmpegPath,cwd:temporaryDir,signal,args:['-hide_banner','-loglevel','info','-nostdin','-protocol_whitelist','file','-i',realSource,'-map','0:v:0','-an','-sn','-dn','-vf','showinfo','-frames:v','1','-f','null','-'],
      onSpawn:()=>onProgress?.(progress('started')),
      onLine:(stream,line)=>{if(stream==='stderr'&&line.includes('Parsed_showinfo')) {const match=line.match(/\bs:(\d+)x(\d+)\b/);if(match) dimensions={width:Number(match[1]),height:Number(match[2])};}},
      errorCode:'VIDEO_INVALID_SOURCE',errorMessage:'無法讀取影片，請確認來源檔案包含可播放的影像。'});
    if(!dimensions) throw new VideoExportError('VIDEO_INVALID_SOURCE','無法讀取影片的畫面尺寸。');
    aborted(signal);
    await fs.writeFile(path.join(temporaryDir,'subtitles.ass'),createSubtitleScript(normalized,{width:Math.ceil(dimensions.width/2)*2,height:Math.ceil(dimensions.height/2)*2}),{encoding:'utf8',flag:'wx'});
    await execute({ffmpegPath,cwd:temporaryDir,signal,args:[
      '-hide_banner','-loglevel','error','-nostdin','-n','-protocol_whitelist','file','-i',realSource,
      '-map','0:v:0','-map','0:a:0?','-sn','-dn','-map_metadata','-1','-map_chapters','-1',
      '-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2,ass=filename=subtitles.ass',
      '-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k',
      '-movflags','+faststart','-progress','pipe:1','-nostats','-f','mp4','video.mp4'],
      onLine:(stream,line)=>{if(stream!=='stdout') return;const [key,value]=line.split('=',2);if(key==='out_time_us') {const number=Number(value);if(Number.isFinite(number)) seconds=Math.max(seconds,number/1e6);}if(key==='progress') onProgress?.(progress('processing'));},
      errorCode:'VIDEO_EXPORT_FAILED',errorMessage:'無法輸出字幕影片，請確認影片可播放、磁碟空間足夠，且影片處理工具支援字幕。'});
    aborted(signal);
    const temporaryPath=path.join(temporaryDir,'video.mp4'),handle=await fs.open(temporaryPath,'r+');
    try {const stat=await handle.stat();if(stat.size<32) throw new VideoExportError('VIDEO_EMPTY_OUTPUT','影片處理工具沒有產生有效的輸出。');await handle.sync();result={outputPath:destination,size:stat.size,seconds,format:'mp4',videoCodec:'h264',audioCodec:'aac'};} finally {await handle.close();}
    aborted(signal);
    try {await fs.link(temporaryPath,destination);published=true;} catch(error) {if(error.code==='EEXIST') throw new VideoExportError('VIDEO_OUTPUT_EXISTS','輸出檔案已存在，請選擇新的檔名。');throw new VideoExportError('VIDEO_PUBLISH_FAILED','無法安全儲存影片，請選擇支援硬連結的本機資料夾。');}
  } catch(error) {
    if(error instanceof VideoExportError) throw error;
    throw new VideoExportError('VIDEO_FILE_ACCESS_FAILED','無法存取影片或輸出位置，請確認檔案、資料夾與存取權限。');
  } finally {
    if(temporaryDir) {
      const cleanup=await Promise.allSettled(['subtitles.ass','video.mp4'].map(name=>fs.unlink(path.join(temporaryDir,name))));
      const directoryCleanup=await fs.rmdir(temporaryDir).then(()=>true,()=>false);
      // Publication is the commit point: an observer or cleanup problem after it
      // must not present a successful output as failed and invite a duplicate job.
      if(published&&(!directoryCleanup||cleanup.some(entry=>entry.status==='rejected'&&entry.reason.code!=='ENOENT'))) result.temporaryCleanupPending=true;
    }
  }
  try {onProgress?.(progress('complete'));} catch {}
  return result;
}

module.exports={burnVideoSubtitles,VideoExportError,createSubtitleScript};
