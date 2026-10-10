(function(root,factory){
  'use strict';
  const player=factory();
  if(typeof module==='object'&&module.exports)module.exports=player;
  else root.UFriendRecordingPlayer=player;
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const players=new WeakMap();

  function timedSegments(segments){
    return (Array.isArray(segments)?segments:[]).flatMap((segment,index)=>{
      const start=Number(segment?.start),end=Number(segment?.end),text=String(segment?.text??'');
      return Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&text.trim()?[{start,end,text,index}]:[];
    }).sort((a,b)=>a.start-b.start||a.end-b.end||a.index-b.index);
  }
  // Cue text has its own markup syntax; transcript text must remain literal.
  function cueText(text){return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function seek(media,time){
    const seconds=Number(time);if(!media||!Number.isFinite(seconds)||seconds<0)return false;
    try{media.currentTime=Number.isFinite(media.duration)?Math.min(seconds,Math.max(0,media.duration)):seconds;return true;}catch{return false;}
  }
  function attach(media,{onCaptionState=()=>{},Cue=media?.ownerDocument?.defaultView?.VTTCue}={}){
    players.get(media)?.dispose();
    let track=null,segments=[],signature='',enabled=true,transcript=null,activeKey='';
    const supportsCaptions=media?.tagName==='VIDEO'&&typeof media.addTextTrack==='function'&&typeof Cue==='function';
    const state=()=>({available:!!track&&segments.length>0,enabled:!!track&&segments.length>0&&track.mode==='showing'});
    function publish(){onCaptionState(state());}
    function highlight(){
      if(!transcript)return;
      const current=Number(media.currentTime),active=segments.filter(segment=>segment.start<=current&&current<segment.end).map(segment=>segment.index),key=active.join(',');
      if(key===activeKey&&transcript.dataset.playbackMarked==='true')return;
      activeKey=key;transcript.dataset.playbackMarked='true';
      const indices=new Set(active.map(String));
      for(const row of transcript.querySelectorAll('[data-segment-index]')){
        const isActive=indices.has(row.dataset.segmentIndex);row.classList.toggle('mf-transcript-active',isActive);
        const button=row.querySelector('[data-action="seek-media"]');if(button){if(isActive)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');}
      }
    }
    function update({segments:nextSegments,language='zh-TW',label='CC',transcript:nextTranscript=null}={}){
      if(transcript!==nextTranscript){transcript=nextTranscript;activeKey='';}
      const next=timedSegments(nextSegments),nextSignature=JSON.stringify(next);
      if(nextSignature!==signature){
        signature=nextSignature;segments=next;
        if(supportsCaptions&&!track&&segments.length)track=media.addTextTrack('captions',label,language);
        if(track){
          // Do not recreate the player (or track) when transcription progress arrives.
          track.mode='hidden';
          for(const cue of Array.from(track.cues||[]))track.removeCue(cue);
          for(const segment of segments){const cue=new Cue(segment.start,segment.end,cueText(segment.text));cue.line=-2;cue.position=50;cue.size=90;cue.align='center';track.addCue(cue);}
          track.mode=segments.length&&enabled?'showing':'disabled';
        }
        activeKey='';if(transcript)delete transcript.dataset.playbackMarked;
      }
      highlight();publish();
    }
    media?.addEventListener('timeupdate',highlight);
    media?.addEventListener('seeking',highlight);
    const trackChanged=()=>{if(track&&segments.length){enabled=track.mode==='showing';publish();}};
    media?.textTracks?.addEventListener?.('change',trackChanged);
    const player={
      update,
      seek:time=>{const success=seek(media,time);if(success)highlight();return success;},
      toggleCaptions(){if(track&&segments.length){enabled=track.mode!=='showing';track.mode=enabled?'showing':'disabled';publish();}return state();},
      captionState:state,
      dispose(){media?.removeEventListener('timeupdate',highlight);media?.removeEventListener('seeking',highlight);media?.textTracks?.removeEventListener?.('change',trackChanged);media?.pause();if(track)track.mode='disabled';transcript=null;players.delete(media);}
    };
    players.set(media,player);return player;
  }
  function dispose(media){if(media)players.get(media)?.dispose();}
  return {timedSegments,cueText,seek,attach,dispose};
});
