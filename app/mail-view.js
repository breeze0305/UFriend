(function(){
  'use strict';
  const language=()=>window.UFriendUi||window.UFriendI18n.create();
  const tr=source=>language().tr(source),uiText=(strings,...values)=>language().text(strings,...values);
  const PLACEHOLDER='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  const MAX_HTML=8*1024*1024,MAX_IMAGES=80;
  const CSS_PROPERTIES=new Set(('color background background-color background-image background-position background-repeat background-size background-origin background-clip opacity display visibility width min-width max-width height min-height max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-width border-style border-color border-top border-right border-bottom border-left border-top-width border-right-width border-bottom-width border-left-width border-top-style border-right-style border-bottom-style border-left-style border-top-color border-right-color border-bottom-color border-left-color border-radius border-collapse border-spacing box-sizing box-shadow font font-family font-size font-style font-weight font-variant font-stretch line-height letter-spacing word-spacing text-align text-decoration text-decoration-color text-decoration-line text-decoration-style text-transform text-indent text-shadow text-overflow white-space word-break overflow-wrap vertical-align list-style-type list-style-position table-layout caption-side empty-cells float clear overflow overflow-x overflow-y position top right bottom left z-index flex flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap align-items align-content align-self justify-content gap row-gap column-gap order object-fit object-position direction unicode-bidi').split(' '));
  const DEFAULT_CSS='html{background:#fff;min-height:0}body{display:flow-root;margin:0;padding:0;color:#303b34;background:#fff;font:14px/1.6 Arial,"Microsoft JhengHei",sans-serif;overflow-wrap:anywhere;min-height:0}img{max-width:100%;height:auto}table{max-width:100%}a{color:#1155cc;text-decoration:underline}pre{white-space:pre-wrap}';
  const CSP="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  function linkUrl(value){
    if(typeof value!=='string'||value.length>16384||/[\x00-\x1f\x7f]/.test(value))return null;
    value=value.trim();
    if(value.startsWith('#'))return value;
    try{const url=new URL(value.startsWith('//')?'https:'+value:value);return ['http:','https:','mailto:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
  }
  function imageSource(value){
    if(typeof value!=='string'||value.length>12*1024*1024)return null;
    value=value.trim();
    if(/^cid:[^\s<>]+$/i.test(value))return value;
    if(/^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/=\r\n]+$/i.test(value))return value;
    const url=linkUrl(value);return url&&/^https?:/i.test(url)?url:null;
  }
  function prepareHtml(html){
    if(typeof html!=='string'||html.length>MAX_HTML)throw new Error(tr('郵件排版內容過大，暫時顯示純文字。'));
    if(!window.DOMPurify)throw new Error(tr('郵件排版元件尚未載入。'));
    const clean=window.DOMPurify.sanitize(html,{WHOLE_DOCUMENT:true,RETURN_DOM:true,ALLOW_DATA_ATTR:false,
      ALLOWED_TAGS:['html','head','body','style','a','p','div','span','br','hr','b','strong','i','em','u','s','small','sub','sup','blockquote','pre','code','kbd','samp','ul','ol','li','dl','dt','dd','table','thead','tbody','tfoot','tr','th','td','colgroup','col','caption','center','font','h1','h2','h3','h4','h5','h6','img','map','area'],
      ALLOWED_ATTR:['style','class','id','title','lang','dir','align','valign','bgcolor','color','face','size','width','height','border','cellpadding','cellspacing','colspan','rowspan','scope','headers','start','type','value','reversed','href','name','target','rel','src','alt','usemap','shape','coords','background'],
      FORBID_TAGS:['script','iframe','object','embed','form','input','button','textarea','select','option','link','meta','base','svg','math','template'],FORBID_ATTR:['srcset','ping','srcdoc','formaction','download']});
    const doc=clean.ownerDocument,resources=[],bySource=new Map();
    function imageToken(raw){
      const source=imageSource(raw);if(!source)return null;
      if(bySource.has(source))return bySource.get(source).token;
      if(resources.length>=MAX_IMAGES)return null;
      const resource={source,token:PLACEHOLDER+'#ufriend-image-'+resources.length+'#'};resources.push(resource);bySource.set(source,resource);return resource.token;
    }
    function declarations(style){
      const output=[];
      for(const property of [...style]){
        if(!CSS_PROPERTIES.has(property))continue;
        let value=style.getPropertyValue(property);
        // CSS URLs are replaced before insertion. Escapes and indirect resource
        // functions are excluded so they cannot bypass the image loader.
        if(/[\\<>@]/.test(value)||/\b(?:expression|var|attr|image-set|cross-fade|paint|element)\s*\(/i.test(value))continue;
        // An auto-sized frame cannot also be the source of its own content's
        // viewport height. Resolve these lengths against the reading window.
        value=value.replace(/(-?(?:\d*\.)?\d+)(?:[dsl]?vh|vb|vmin|vmax)\b/gi,(_match,length)=>Number(length)*window.innerHeight/100+'px');
        let bad=false;
        value=value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,(_match,a,b,c)=>{
          if(!['background','background-image'].includes(property)){bad=true;return '';}
          const token=imageToken((a??b??c??'').trim());if(!token){bad=true;return '';}
          return 'url("'+token+'")';
        });
        if(bad||/url\s*\(/i.test(value.replaceAll(/url\("data:image\/gif;base64,[^"]*"\)/g,'')))continue;
        output.push(property+':'+value+(style.getPropertyPriority(property)?' !important':'')+';');
      }
      return output.join('');
    }
    function rules(input){
      let output='';
      for(const rule of input){
        if(rule.type===CSSRule.STYLE_RULE){const css=declarations(rule.style);if(css)output+=rule.selectorText+'{'+css+'}';}
        else if(rule.type===CSSRule.MEDIA_RULE)output+='@media '+rule.conditionText+'{'+rules(rule.cssRules)+'}';
        else if(rule.type===CSSRule.SUPPORTS_RULE)output+='@supports '+rule.conditionText+'{'+rules(rule.cssRules)+'}';
      }
      return output;
    }
    for(const element of [clean,...clean.querySelectorAll('*')]){
      if(element.hasAttribute('style')){const css=declarations(element.style);if(css)element.setAttribute('style',css);else element.removeAttribute('style');}
      if(element.hasAttribute('background')){const token=imageToken(element.getAttribute('background'));element.removeAttribute('background');if(token)element.style.backgroundImage='url("'+token+'")';}
      if(element.tagName==='STYLE'){
        try{const sheet=new CSSStyleSheet();sheet.replaceSync(element.textContent);element.textContent=rules(sheet.cssRules);}catch{element.remove();}
      }
      if(element.tagName==='IMG'){
        const token=imageToken(element.getAttribute('src'));element.removeAttribute('src');
        if(token)element.setAttribute('src',token);else element.setAttribute('alt',element.getAttribute('alt')||tr('圖片無法顯示'));
        element.setAttribute('referrerpolicy','no-referrer');element.setAttribute('decoding','async');
      }
      if(element.tagName==='A'||element.tagName==='AREA'){
        const href=linkUrl(element.getAttribute('href'));element.removeAttribute('target');element.removeAttribute('rel');
        if(href){element.setAttribute('href',href);element.setAttribute('rel','noopener noreferrer');}else element.removeAttribute('href');
      }
    }
    const head=clean.querySelector('head'),meta=doc.createElement('meta'),charset=doc.createElement('meta'),style=doc.createElement('style');
    meta.httpEquiv='Content-Security-Policy';meta.content=CSP;charset.setAttribute('charset','utf-8');style.textContent=DEFAULT_CSS;
    head.prepend(style);head.prepend(meta);head.prepend(charset);
    const layout=doc.createElement('style');
    // The host owns vertical scrolling. Viewport-relative body heights would
    // otherwise grow again every time the iframe expands to fit its content.
    layout.textContent='html,body{height:auto!important;min-height:0!important;max-height:none!important;overflow-y:visible!important}';head.append(layout);
    for(const element of [clean,clean.querySelector('body')])for(const [property,value]of [['height','auto'],['min-height','0'],['max-height','none'],['overflow-y','visible']])element.style.setProperty(property,value,'important');
    return {html:'<!doctype html>'+clean.outerHTML,resources};
  }
  function textBody(container,text,openLink){
    const body=document.createElement('div');body.className='mf-bodytext';
    const value=text||tr('這封信沒有可顯示的文字內文。'),pattern=/https?:\/\/[^\s<>]+/gi;let start=0;
    for(const match of value.matchAll(pattern)){
      const raw=match[0].replace(/[.,;!?，。；！？)\]}]+$/,'');const href=linkUrl(raw);if(!href)continue;
      body.append(document.createTextNode(value.slice(start,match.index)));const anchor=document.createElement('a');anchor.textContent=raw;anchor.href=href;anchor.rel='noopener noreferrer';
      anchor.addEventListener('click',event=>{event.preventDefault();openLink(href);});body.append(anchor);start=match.index+raw.length;
    }
    body.append(document.createTextNode(value.slice(start)));container.append(body);
  }
  // Read author colors once before applying the host palette. Only presentation
  // colors change; the saved HTML, image pixels and image bindings stay intact.
  function themeDocument(doc,host){
    const properties=['color','background-color','border-top-color','border-right-color','border-bottom-color','border-left-color'];
    const rgb=value=>{const match=value.match(/^rgba?\(([^)]+)\)$/);if(!match)return null;const parts=match[1].split(',').map(Number);return parts.length===3||parts[3]>0?parts:null;};
    const mix=(a,b,weight)=>a.slice(0,3).map((value,index)=>Math.round(value*(1-weight)+b[index]*weight));
    const composite=(color,behind)=>color?mix(behind,color,color[3]??1):behind;
    const css=value=>'rgb('+value.join(',')+')';
    const luminance=value=>value.map(channel=>{channel/=255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;}).reduce((sum,channel,index)=>sum+channel*[.2126,.7152,.0722][index],0);
    const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
    const records=[doc.documentElement,...doc.querySelectorAll('body,body *')].filter(element=>!['STYLE','IMG','BR'].includes(element.tagName)).map(element=>{
      const computed=doc.defaultView.getComputedStyle(element);
      return {element,colors:properties.map(property=>rgb(computed.getPropertyValue(property))),original:properties.map(property=>[element.style.getPropertyValue(property),element.style.getPropertyPriority(property)])};
    });
    let previous='';
    return dark=>{
      const hostStyle=getComputedStyle(host),background=rgb(hostStyle.backgroundColor)||[251,251,250],text=rgb(hostStyle.color)||[48,59,52];
      const key=[dark,background,text].join('|');if(key===previous)return;previous=key;
      const effective=new Map(),originalEffective=new Map();
      const surface=color=>{
        if(!color)return null;
        const neutral=Math.max(...color)-Math.min(...color)<5;
        if(neutral&&Math.min(...color)>225)return background;
        return dark&&luminance(color)>.12?mix(background,color,neutral?.06:.13):color;
      };
      for(const record of records){
        const {element,colors,original}=record;
        const authorBackground=composite(colors[1],originalEffective.get(element.parentElement)||[255,255,255]);originalEffective.set(element,authorBackground);
        const backgroundColor=element===doc.documentElement||element===doc.body?background:colors[1]?surface(authorBackground):null;
        const behind=backgroundColor||effective.get(element.parentElement)||background;effective.set(element,behind);
        let foreground=colors[0]?composite(colors[0],authorBackground):null;
        const readable=dark?6:4.5;
        if(foreground&&contrast(foreground,behind)<readable){
          const target=contrast(text,behind)>=readable?text:(luminance(behind)>.4?[20,25,21]:[241,245,240]);
          if(Math.max(...foreground)-Math.min(...foreground)<24)foreground=target;
          else for(let step=1;step<=10;step++){const candidate=mix(foreground,target,step/10);if(contrast(candidate,behind)>=readable||step===10){foreground=candidate;break;}}
        }
        const mapped=[foreground,backgroundColor,...colors.slice(2).map(color=>color?(dark?mix(behind,composite(color,authorBackground),.3):composite(color,authorBackground)):null)];
        for(let index=0;index<properties.length;index++){
          const value=mapped[index],property=properties[index];
          if(value)element.style.setProperty(property,css(value),'important');
          else if(original[index][0])element.style.setProperty(property,...original[index]);
          else element.style.removeProperty(property);
        }
      }
    };
  }
  function mount(container,message,{content,image,openLink,onContent,theme='system'}={}){
    let disposed=false,frame=null,observer=null,generation=0,failed=[],loadingImages=false,resizeFrame=0,applyTheme=null;
    const systemTheme=matchMedia('(prefers-color-scheme: dark)');
    const updateTheme=()=>{if(!frame)return;const dark=theme==='dark'||theme==='system'&&systemTheme.matches,scheme=dark?'dark':'light';if(frame.style.colorScheme!==scheme)frame.style.colorScheme=scheme;applyTheme?.(dark);};
    systemTheme.addEventListener('change',updateTheme);
    function clearFrame(){observer?.disconnect();observer=null;cancelAnimationFrame(resizeFrame);resizeFrame=0;applyTheme=null;}
    const alive=()=>!disposed&&container.isConnected;
    const status=document.createElement('div'),body=document.createElement('div'),imageStatus=document.createElement('div');
    status.id='mail-content-status';status.className='mf-mail-content-status';status.setAttribute('role','status');status.hidden=true;
    imageStatus.id='mail-image-status';imageStatus.className='mf-mail-content-status';imageStatus.setAttribute('role','status');imageStatus.hidden=true;
    container.replaceChildren(status,body,imageStatus);
    function statusMessage(node,text,retryAction,retry){
      node.replaceChildren();node.hidden=!text;if(!text)return;node.append(document.createTextNode(text));
      if(retry){const button=document.createElement('button');button.type='button';button.className='mf-action';button.dataset.action=retryAction;button.textContent=tr('重試');button.addEventListener('click',event=>{event.stopPropagation();retry();});node.append(button);}
    }
    const external=href=>{if(alive())Promise.resolve(openLink(href)).catch(error=>statusMessage(status,error.message||tr('連結無法開啟。')));};
    function fallback(text,reason='',retry=false){
      clearFrame();frame=null;body.replaceChildren();textBody(body,text,external);
      statusMessage(status,reason,retry?'mail-content-retry':null,retry?()=>load(true):null);
    }
    function updateImageStatus(){
      const text=loadingImages?tr('正在載入郵件圖片…'):failed.length?uiText`${failed.length} 張圖片無法載入，其餘內容仍可閱讀。`:'';
      statusMessage(imageStatus,text,!loadingImages&&failed.length?'mail-images-retry':null,!loadingImages&&failed.length?()=>loadImages([...failed],generation,true):null);
    }
    async function loadImages(resources,revision,refresh=false){
      if(!resources.length||!alive())return;loadingImages=true;failed=[];updateImageStatus();let next=0;
      await Promise.all(Array.from({length:Math.min(4,resources.length)},async()=>{
        while(next<resources.length&&alive()&&revision===generation){
          const resource=resources[next++];
          try{
            const result=await image(resource.source,{refresh});if(!alive()||revision!==generation||!frame?.contentDocument)return;
            if(!/^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/=]+$/i.test(result.dataUrl))throw new Error(tr('圖片格式不支援。'));
            const decoded=new Image();decoded.src=result.dataUrl;await decoded.decode();
            if(!decoded.naturalWidth||decoded.naturalWidth>20000||decoded.naturalHeight>20000||decoded.naturalWidth*decoded.naturalHeight>60000000)throw new Error(tr('圖片無法顯示。'));
            if(!alive()||revision!==generation||!frame?.contentDocument)return;
            for(const element of resource.elements||[]){
              if(element.tagName==='IMG'&&element.getAttribute('src')===resource.token)element.setAttribute('src',result.dataUrl);
              const style=element.getAttribute('style');if(style?.includes(resource.token))element.setAttribute('style',style.replaceAll(resource.token,result.dataUrl));
              if(element.tagName==='STYLE'&&element.textContent.includes(resource.token))element.textContent=element.textContent.replaceAll(resource.token,result.dataUrl);
            }
          }catch{if(alive()&&revision===generation)failed.push(resource);}
        }
      }));
      if(alive()&&revision===generation){loadingImages=false;updateImageStatus();}
    }
    function display(value,revision){
      if(!alive()||revision!==generation)return;
      statusMessage(status,'');statusMessage(imageStatus,'');clearFrame();
      if(!value.html){fallback(value.body);return;}
      const prepared=prepareHtml(value.html);
      frame=document.createElement('iframe');frame.id='mail-html-frame';frame.className='mf-mail-html-frame';frame.title=tr('郵件內容');frame.sandbox='allow-same-origin';frame.referrerPolicy='no-referrer';
      const current=frame;
      current.addEventListener('load',()=>{
        if(!alive()||current!==frame||revision!==generation)return;
        const doc=current.contentDocument;if(!doc?.body)return;
        const resize=()=>{
          if(resizeFrame||!alive()||current!==frame)return;
          resizeFrame=requestAnimationFrame(()=>{
            resizeFrame=0;if(!alive()||current!==frame)return;
            const bounds=doc.body.getBoundingClientRect(),style=doc.defaultView.getComputedStyle(doc.body);
            // Use document coordinates and the body box, not the viewport-sized
            // document scrollHeight. No border or nested vertical scroll range.
            const bottom=bounds.top+doc.defaultView.scrollY+Math.max(bounds.height,doc.body.scrollHeight)+Math.max(0,parseFloat(style.marginBottom)||0);
            const horizontal=doc.documentElement.scrollWidth>doc.documentElement.clientWidth?Math.max(0,current.clientHeight-doc.documentElement.clientHeight):0;
            const height=Math.max(120,Math.ceil(bottom+horizontal));
            if(current.style.height!==height+'px')current.style.height=height+'px';
          });
        };
        applyTheme=themeDocument(doc,container.closest('#ufriend-app')||container);updateTheme();
        // Index image targets once instead of rescanning the entire letter for
        // each of up to eighty image completions (including retries).
        for(const resource of prepared.resources)resource.elements=[];
        for(const element of doc.querySelectorAll('img[src],[style],style')){
          const value=(element.getAttribute('src')||'')+(element.getAttribute('style')||'')+(element.tagName==='STYLE'?element.textContent:'');
          for(const index of new Set([...value.matchAll(/#ufriend-image-(\d+)#/g)].map(match=>Number(match[1]))))prepared.resources[index]?.elements.push(element);
        }
        doc.addEventListener('click',event=>{
          const link=event.target.closest?.('a[href],area[href]');if(!link)return;event.preventDefault();
          const href=link.getAttribute('href');if(href.startsWith('#')){let id;try{id=decodeURIComponent(href.slice(1));}catch{return;}doc.getElementById(id)?.scrollIntoView();return;}external(href);
        });
        doc.addEventListener('auxclick',event=>{const link=event.target.closest?.('a[href],area[href]');if(link){event.preventDefault();if(event.button===1&&!link.getAttribute('href').startsWith('#'))external(link.getAttribute('href'));}});
        doc.addEventListener('load',resize,true);observer=new ResizeObserver(resize);observer.observe(doc.body);resize();current.dataset.ready='true';loadImages(prepared.resources,revision);
      });
      current.srcdoc=prepared.html;body.replaceChildren(current);
    }
    async function load(force=false){
      const revision=++generation;failed=[];loadingImages=false;statusMessage(imageStatus,'');
      if(!force&&message.htmlVersion===1){try{display(message,revision);}catch(error){fallback(message.body,error.message);}return;}
      if(message.source!=='Gmail'){fallback(message.body,message.htmlVersion===1?'':tr('這封舊郵件只保存純文字，重新匯入原始 EML 可恢復完整排版。'));return;}
      statusMessage(status,tr('正在載入郵件原始排版…'));
      try{const value=await content();if(!alive()||revision!==generation)return;message={...message,...value};onContent?.(value);display(message,revision);}
      catch(error){if(alive()&&revision===generation)fallback(message.body,tr('無法載入原始排版，暫時顯示純文字。')+(error.message||''),true);}
    }
    load();return{setTheme(value){if(value===theme)return;theme=value;updateTheme();},dispose(){disposed=true;generation++;clearFrame();systemTheme.removeEventListener('change',updateTheme);}};
  }
  window.UFriendMailView={mount};
})();
