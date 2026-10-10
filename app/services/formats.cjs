'use strict';
const path=require('node:path');
const crypto=require('node:crypto');
const AUDIO=new Set(['.mp3','.wav','.m4a','.aac','.flac','.ogg','.opus','.wma']);
const VIDEO=new Set(['.mp4','.m4v','.mov','.webm','.mkv','.avi','.wmv']);
const IMAGE=new Set(['.png','.jpg','.jpeg','.webp','.bmp']);
const MIME={'.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.aac':'audio/aac','.flac':'audio/flac','.ogg':'audio/ogg','.opus':'audio/ogg','.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.bmp':'image/bmp','.txt':'text/plain','.srt':'application/x-subrip'};
function safeName(name){return path.basename(String(name||'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,180)||'file';}
function fileType(name){const ext=path.extname(name).toLowerCase();return AUDIO.has(ext)?'audio':VIDEO.has(ext)?'video':IMAGE.has(ext)?'image':null;}
function mimeType(name){return MIME[path.extname(name).toLowerCase()]||'application/octet-stream';}
function digest(buffer){return crypto.createHash('sha256').update(buffer).digest('hex');}
function milliseconds(seconds){if(!Number.isFinite(seconds)||seconds<0)throw new Error('逐字稿時間必須是非負數字。');return Math.round(seconds*1000);}
function srtTime(seconds){const total=milliseconds(seconds);return `${String(Math.floor(total/3600000)).padStart(2,'0')}:${String(Math.floor(total/60000)%60).padStart(2,'0')}:${String(Math.floor(total/1000)%60).padStart(2,'0')},${String(total%1000).padStart(3,'0')}`;}
function validateSegments(segments){if(!Array.isArray(segments))throw new Error('逐字稿格式錯誤。');let previous=-1;return segments.map(s=>{const start=Number(s.start),end=Number(s.end);milliseconds(start);milliseconds(end);if(end<start||start<previous)throw new Error('逐字稿時間順序不正確。');previous=start;const text=String(s.text??'').replace(/\r/g,'').replace(/\n(?:[ \t]*\n)+/g,'\n').trim();if(!text)throw new Error('逐字稿不能包含空白段落。');return{start,end,text};});}
function exportSrt(segments){return validateSegments(segments).map((s,i)=>`${i+1}\r\n${srtTime(s.start)} --> ${srtTime(s.end)}\r\n${s.text.replace(/\n/g,'\r\n')}\r\n`).join('\r\n');}
function exportTxt(recording){return recording.textOnly??(recording.segments||[]).map(s=>s.text).join('\r\n');}
function parseSrt(text){const blocks=String(text).replace(/^\uFEFF/,'').replace(/\r/g,'').trim().split(/\n[ \t]*\n/);if(!String(text).trim())return[];const result=blocks.map(block=>{const lines=block.split('\n');if(/^\d+$/.test(lines[0]))lines.shift();const match=lines.shift()?.match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})\s*$/);if(!match)throw new Error('SRT 時間格式不正確，請使用 HH:MM:SS,mmm --> HH:MM:SS,mmm。');const a=match.slice(1).map(Number);if(a[1]>59||a[2]>59||a[5]>59||a[6]>59)throw new Error('SRT 分鐘與秒數不可超過 59。');return{start:a[0]*3600+a[1]*60+a[2]+a[3]/1000,end:a[4]*3600+a[5]*60+a[6]+a[7]/1000,text:lines.join('\n')};});return validateSegments(result);}
module.exports={AUDIO,VIDEO,IMAGE,safeName,fileType,mimeType,digest,exportSrt,exportTxt,parseSrt,validateSegments};
