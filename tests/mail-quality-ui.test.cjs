'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {create}=require('../app/i18n.js');
const english={...require('../app/locales/en-common.js'),...require('../app/locales/en-settings.js'),...require('../app/locales/en-native.js'),...require('../app/locales/en-extra.js')};
const renderer=fs.readFileSync(path.join(__dirname,'..','app','renderer.js'),'utf8');
const begin=renderer.indexOf('  function mailPriorityGroup(m){'),end=renderer.indexOf('  function updateMailAnalysisUi(){',begin);
assert(begin>=0&&end>begin,'Mail summary UI helpers must be available for synthetic rendering.');
const code=renderer.slice(begin,end);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const baseline={id:'synthetic-mail',folder:'inbox',level:0,prioritySource:'model',analysis:{summary:'Payment has been received.',reason:'A completed transaction.',priority:0,evidence:['Payment received.'],category:'finance',categoryStatus:'done',meta:{model:'Synthetic model'}}};
function context(fixture,locale='zh-TW'){
  const i18n=create({locale,catalogs:{en:english}});
  return {fixture,tr:i18n.tr.bind(i18n),uiText:i18n.text.bind(i18n),esc:escape,levels:i18n.labels(['優先回覆','今日處理','稍後處理']),selected:(a,b)=>a===b?' selected':'',mailCategory:()=> 'finance',mailClassifying:()=>false,mailCategoryBadge:()=>'<span class="mf-mail-category">Finance</span>',resultSourceBadge:()=>'',day:()=>'',time:()=>''};
}
const render=(fixture,locale='zh-TW',expression='mailAnalysisResult(fixture)')=>vm.runInNewContext(code+'\n'+expression,context(fixture,locale));
const withAnalysis=patch=>({...baseline,analysis:{...baseline.analysis,...patch}});

test('the summary card preserves and escapes the complete summary while keeping stored analysis details out of the card',()=>{
  const summary='Payment <img src=x onerror="alert(1)"> & received. '+ '完整摘要。'.repeat(250)+' SUMMARY_END';
  const fixture=withAnalysis({summary,sourceFacts:['SOURCE_FACT <script>source</script>'],evidence:['EVIDENCE_QUOTE'],analyzedAt:'2027-03-12T01:30:00.000Z',categoryError:'CATEGORY_ERROR',quality:{summaryMode:'source-excerpts',sourceFactsTruncated:true,priorityReview:true,imageTextUnavailable:true,attachmentTextUnavailable:true,issues:['duration-mismatch']}});
  const saved=structuredClone(fixture);
  for(const locale of ['zh-TW','en']){
    const html=render(fixture,locale);
    assert(html.includes('<p class="mf-analysis-summary">'+escape(summary)+'</p>'),'Summary stays complete and is rendered as plain text.');
    assert.match(html,/mf-mail-category">Finance/);
    assert.match(html,locale==='en'?/Summary and category/:/摘要與分類/);
    assert.doesNotMatch(html,/<img|<script|SOURCE_FACT|EVIDENCE_QUOTE|CATEGORY_ERROR|Synthetic model|A completed transaction|2027-03-12/);
    assert.doesNotMatch(html,/mf-analysis-facts|mf-analysis-quality|mf-analysis-evidence|mf-analysis-source|mf-analysis-mode|mf-priority-review|mf-mail-analysis-notice/);
    assert.doesNotMatch(html,/模型建議|目前人工設定|Model suggestion|Current manual priority/);
  }
  assert.deepEqual(fixture,saved,'Rendering must not delete or rewrite saved facts, evidence, quality or priority.');
});

test('legacy and malformed stored analysis retain the summary or the existing empty-summary help',()=>{
  for(const locale of ['zh-TW','en']){
    assert(render(baseline,locale).includes('Payment has been received.'));
    assert.doesNotThrow(()=>render(withAnalysis({sourceFacts:{unexpected:'value'},quality:{issues:'<img src=x>'},evidence:'invalid'}),locale));
    for(const analysis of [null,{...baseline.analysis,summary:''}]){
      const html=render({...baseline,analysis},locale);
      assert.match(html,locale==='en'?/No summary yet/:/尚未產生摘要/);
      assert.doesNotMatch(html,/mf-analysis-summary|mf-analysis-evidence|Synthetic model|A completed transaction/);
    }
  }
});

test('unverified model priority remains in the review group and a manual priority remains selected outside the summary card',()=>{
  const fixture=withAnalysis({quality:{priorityReview:true,summaryMode:'source-excerpts',issues:['priority-unverified']}});
  for(const locale of ['zh-TW','en']){
    const options=render(fixture,locale,'mailPriorityOptions(fixture)');
    assert.match(options,/<option value="" selected>/);assert.doesNotMatch(options,/<option value="[012]" selected>/);
    assert.match(options,locale==='en'?/Needs review/:/待核對/);
    assert.equal(render(fixture,locale,'mailPriorityGroup(fixture)'),'review');
    const manual={...fixture,prioritySource:'manual',level:1};
    assert.equal(render(manual,locale,'mailPriorityGroup(fixture)'),1);
    assert.match(render(manual,locale,'mailPriorityOptions(fixture)'),/<option value="1" selected>/);
  }
});

test('the home view keeps an unverified model result out of numeric priority groups and exposes its source mode',()=>{
  const first=renderer.indexOf('  function renderHome(){'),last=renderer.indexOf('  function visibleMails(){',first);
  assert(first>=0&&last>first);
  const fixture=withAnalysis({quality:{priorityReview:true,summaryMode:'source-excerpts',issues:[]}});
  const sandbox={...context(fixture),data:{messages:[fixture],accounts:[]},page:{innerHTML:''},header:()=>'',dateLabel:()=>'',analysisActions:()=>'',analysisScope:()=>'',analysisProgress:()=>'',btn:()=>'',empty:()=>'',idAttr:id=>'data-id="'+escape(id)+'"',provider:()=>''};
  vm.runInNewContext(code+'\n'+renderer.slice(first,last)+'\nrenderHome();',sandbox);
  assert.match(sandbox.page.innerHTML,/<h2>待核對<\/h2>/);assert.match(sandbox.page.innerHTML,/data-level="review"/);
  assert.doesNotMatch(sandbox.page.innerHTML,/<h2>優先回覆<\/h2>|data-level="0"/);
  assert.match(sandbox.page.innerHTML,/mf-analysis-mode">原文摘錄/);
});
