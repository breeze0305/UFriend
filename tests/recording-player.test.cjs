'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {timedSegments,cueText,seek,attach,dispose}=require('../app/recording-player.js');

class Cue{constructor(start,end,text){this.startTime=start;this.endTime=end;this.text=text;}}
class Media extends EventTarget{
  constructor(tagName='VIDEO'){super();this.tagName=tagName;this.currentTime=0;this.duration=20;this.paused=true;this.playCalls=0;this.pauseCalls=0;this.tracks=[];this.textTracks=new EventTarget();}
  play(){this.playCalls++;this.paused=false;return Promise.resolve();}
  pause(){this.pauseCalls++;this.paused=true;}
  addTextTrack(kind,label,language){
    const media=this,cues=[];let mode='disabled';
    const track={kind,label,language,adds:0,removes:0,get cues(){return mode==='disabled'?null:cues;},get mode(){return mode;},set mode(next){mode=next;queueMicrotask(()=>media.textTracks.dispatchEvent(new Event('change')));},addCue(cue){this.adds++;cues.push(cue);},removeCue(cue){this.removes++;cues.splice(cues.indexOf(cue),1);}};
    this.tracks.push(track);return track;
  }
}
const segments=[{start:0,end:2,text:'第一段 <b>literal</b> & text'},{start:2,end:4,text:'Second line\n第三行'}];
function transcript(count){
  const rows=Array.from({length:count},(_,index)=>{const attributes={};return {dataset:{segmentIndex:String(index)},active:false,classList:{toggle(name,value){rows[index].active=value;}},querySelector(){return {setAttribute(name,value){attributes[name]=value;},removeAttribute(name){delete attributes[name];}};},attributes};});
  return {dataset:{},rows,querySelectorAll(){return rows;}};
}

test('timed captions reject invalid ranges, preserve original indices and escape cue markup',()=>{
  const input=[segments[1],{start:-1,end:2,text:'invalid'},{start:0,end:0,text:'empty interval'},{start:4,end:Infinity,text:'invalid'},{start:0,end:1,text:' '},segments[0],null];
  assert.deepEqual(timedSegments(input),[{...segments[0],index:5},{...segments[1],index:0}]);
  assert.equal(cueText('<c.red>text</c> & <00:00:01.000>\nnext'),'&lt;c.red&gt;text&lt;/c&gt; &amp; &lt;00:00:01.000&gt;\nnext');
  assert.deepEqual(timedSegments(undefined),[]);
});

test('caption tracks preserve playback and cue identity during progress-only updates',async()=>{
  const media=new Media(),states=[],player=attach(media,{Cue,onCaptionState:state=>states.push(state)});
  await media.play();media.currentTime=1.25;
  player.update({segments,language:'en',label:'Transcript captions'});await Promise.resolve();
  const track=media.tracks[0],firstCue=track.cues[0];
  assert.deepEqual({kind:track.kind,label:track.label,language:track.language,mode:track.mode},{kind:'captions',label:'Transcript captions',language:'en',mode:'showing'});
  assert.equal(firstCue.text,'第一段 &lt;b&gt;literal&lt;/b&gt; &amp; text');
  player.update({segments:structuredClone(segments)});
  assert.equal(media.tracks.length,1);assert.equal(track.cues[0],firstCue);assert.equal(track.adds,2);assert.equal(track.removes,0);
  assert.equal(media.currentTime,1.25);assert.equal(media.paused,false);assert.equal(media.playCalls,1);
  assert.deepEqual(states.at(-1),{available:true,enabled:true});
});

test('disabled captions stay disabled when the transcript changes and have no duplicated cues',async()=>{
  const media=new Media(),player=attach(media,{Cue});player.update({segments});await Promise.resolve();
  assert.deepEqual(player.toggleCaptions(),{available:true,enabled:false});await Promise.resolve();
  player.update({segments:[{start:5,end:8,text:'replacement'}]});await Promise.resolve();
  assert.equal(media.tracks[0].mode,'disabled');assert.equal(media.tracks[0].removes,2);
  player.toggleCaptions();await Promise.resolve();
  assert.equal(media.tracks[0].cues.length,1);assert.equal(media.tracks[0].cues[0].text,'replacement');
  media.tracks[0].mode='disabled';await Promise.resolve();
  assert.equal(player.captionState().enabled,false);
  player.update({segments:[{start:5,end:9,text:'updated again'}]});await Promise.resolve();
  assert.equal(media.tracks[0].mode,'disabled');
});

test('timestamp seeking preserves paused and playing states and honors media boundaries',async()=>{
  const media=new Media(),player=attach(media,{Cue});
  assert.equal(player.seek(3),true);assert.equal(media.currentTime,3);assert.equal(media.paused,true);assert.equal(media.playCalls,0);
  await media.play();assert.equal(player.seek(7),true);assert.equal(media.paused,false);assert.equal(media.playCalls,1);
  assert.equal(seek(media,100),true);assert.equal(media.currentTime,20);
  assert.equal(seek(media,-1),false);assert.equal(seek(media,'bad'),false);assert.equal(media.currentTime,20);
  media.duration=NaN;assert.equal(seek(media,100),true);assert.equal(media.currentTime,100);
  assert.equal(seek({set currentTime(value){throw new Error('not seekable');}},2),false);
});

test('timeline marks exact start/end boundaries, gaps and overlapping subtitles',()=>{
  const media=new Media(),view=transcript(3),player=attach(media,{Cue});
  player.update({segments:[{start:0,end:2,text:'one'},{start:2,end:4,text:'two'},{start:3,end:4,text:'overlap'}],transcript:view});
  assert.deepEqual(view.rows.map(row=>row.active),[true,false,false]);assert.equal(view.rows[0].attributes['aria-current'],'true');
  player.seek(2);assert.deepEqual(view.rows.map(row=>row.active),[false,true,false]);assert.equal(view.rows[0].attributes['aria-current'],undefined);
  player.seek(3.25);assert.deepEqual(view.rows.map(row=>row.active),[false,true,true]);
  player.seek(4);assert.deepEqual(view.rows.map(row=>row.active),[false,false,false]);
});

test('text-only/audio media remain usable without captions and disposal stops detached playback',async()=>{
  const video=new Media(),player=attach(video,{Cue});player.update({segments:[]});assert.deepEqual(player.captionState(),{available:false,enabled:false});assert.equal(video.tracks.length,0);
  const audio=new Media('AUDIO'),audioPlayer=attach(audio,{Cue});audioPlayer.update({segments});assert.equal(audio.tracks.length,0);assert.equal(audioPlayer.seek(1),true);
  player.update({segments});await video.play();dispose(video);assert.equal(video.paused,true);assert.equal(video.tracks[0].mode,'disabled');
  const pauses=video.pauseCalls;dispose(video);assert.equal(video.pauseCalls,pauses);
  const unsupported=new Media(),unsupportedPlayer=attach(unsupported);unsupportedPlayer.update({segments});assert.equal(unsupported.tracks.length,0);assert.equal(unsupportedPlayer.seek(3),true);
});
