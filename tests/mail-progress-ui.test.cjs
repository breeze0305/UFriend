'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {create}=require('../app/i18n.js');
const english={...require('../app/locales/en-common.js'),...require('../app/locales/en-settings.js'),...require('../app/locales/en-native.js'),...require('../app/locales/en-extra.js')};
const renderer=fs.readFileSync(path.join(__dirname,'..','app','renderer.js'),'utf8');
const start=renderer.indexOf('  function analysisProgress(){'),end=renderer.indexOf('  function analysisScope(){',start);
assert(start>=0&&end>start,'The renderer must expose its existing mail progress rendering function.');
const progressCode=renderer.slice(start,end)+'\nanalysisProgress();';
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function render(state,locale='zh-TW'){
  const i18n=create({locale,catalogs:{en:english}});
  return vm.runInNewContext(progressCode,{data:{mailAnalysis:state},tr:i18n.tr.bind(i18n),uiText:i18n.text.bind(i18n),esc:escape,message:()=>({subject:'Synthetic mail'})});
}
const running={status:'running',processed:2,total:4,failed:0,skipped:0,currentId:'fixture',phase:'chunking',chunkIndex:0,chunkTotal:3};

test('mail progress renders actual completed segment counts and allows adaptive totals in both interface languages',()=>{
  for(const locale of ['zh-TW','en']){
    const first=render(running,locale),adaptive=render({...running,chunkIndex:1,chunkTotal:5},locale);
    assert.match(first,locale==='en'?/Analyzing in segments/:/正在分段分析/);
    assert.match(first,locale==='en'?/Completed 0 \/ 3 segments/:/已完成 0 \/ 3 段/);
    assert.match(adaptive,locale==='en'?/Completed 1 \/ 5 segments/:/已完成 1 \/ 5 段/);
    assert.match(adaptive,/2 \/ 4/,'Mail count must stay separate from the segment count.');assert.match(adaptive,/data-phase="chunking"/);
  }
});

test('merge, classification and terminal states never show stale segment counters',()=>{
  for(const locale of ['zh-TW','en']){
    const merge=render({...running,phase:'merging',chunkIndex:3},locale);
    assert.match(merge,locale==='en'?/Combining summaries/:/正在彙整摘要/);assert.doesNotMatch(merge,/Completed|已完成|3 \/ 3/);
    for(const state of [{...running,phase:'classification'},{...running,status:'cancelled'},{...running,status:'error'},{...running,status:'done'}]){
      const markup=render(state,locale);assert.doesNotMatch(markup,/Analyzing in segments|正在分段分析|Completed 0 \/ 3 segments|已完成 0 \/ 3 段/);
    }
    const noChanges=render({...running,status:'done',processed:0,total:0,unchanged:2},locale);
    assert.match(noChanges,locale==='en'?/No new or changed emails to organize/:/沒有新增或需要更新的信件/);assert.doesNotMatch(noChanges,/0 \/ 0|0 \/ 3/);
  }
});

test('malformed persisted segment counts cannot render bogus progress or injected markup',()=>{
  for(const patch of [{chunkIndex:-1},{chunkIndex:4},{chunkIndex:'<img src=x>'},{chunkIndex:NaN},{chunkIndex:Infinity},{chunkTotal:0},{chunkTotal:129},{chunkTotal:'3'}]){
    const markup=render({...running,...patch},'en');assert.match(markup,/Analyzing in segments/);assert.doesNotMatch(markup,/Completed|<img|NaN|Infinity/);
  }
});
