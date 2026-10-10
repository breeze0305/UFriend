(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.UFriendI18n=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const TOKEN=/\uE000(\d+)\uE001/g;
  const markup=value=>/<\/?[a-z]|\b(?:title|aria-label|placeholder|alt)=["']/i.test(value);
  const escapeHtml=value=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function phrase(source,catalog,collect,asHtml=false){
    const match=/^(\s*)([\s\S]*?)(\s*)$/.exec(source),tokens=[];
    const key=match[2].replace(TOKEN,token=>'{'+(tokens.push(token)-1)+'}');
    if(!key)return source;
    if(collect&&/[\u3400-\u9fff]/.test(key))collect(key);
    if(!Object.hasOwn(catalog,key))return source;
    const translated=asHtml?escapeHtml(catalog[key]):catalog[key];
    return match[1]+translated.replace(/\{(\d+)\}/g,(token,index)=>tokens[index]??token)+match[3];
  }
  // Only developer-authored literal segments enter this function. Interpolated
  // mail, model output, filenames and input values are inserted afterwards.
  function staticText(source,catalog,collect){
    if(!markup(source))return phrase(source,catalog,collect);
    let result=source.replace(/\b(title|aria-label|placeholder|alt)=("|')([^"']*)(\2|$)/gi,(_all,name,quote,value,end)=>name+'='+quote+phrase(value,catalog,collect,true)+end);
    return result.replace(/(^|>)([^<>]*)(?=<|$)/g,(_all,prefix,value)=>prefix+phrase(value,catalog,collect,true));
  }
  function create({locale='zh-TW',catalogs={}}={}){
    let current=locale==='en'?'en':'zh-TW';
    const catalog=()=>current==='zh-TW'?{}:catalogs[current]||{};
    const tr=source=>staticText(String(source),catalog());
    const template=(strings,...values)=>{
      const source=strings.reduce((all,part,index)=>all+part+(index<values.length?'\uE000'+index+'\uE001':''),'');
      return staticText(source,catalog()).replace(TOKEN,(_token,index)=>String(values[index]));
    };
    const proxies=new WeakMap();
    function labels(value){
      if(typeof value==='string')return tr(value);
      if(!value||typeof value!=='object')return value;
      if(!proxies.has(value))proxies.set(value,new Proxy(value,{get(target,key,receiver){return labels(Reflect.get(target,key,receiver));}}));
      return proxies.get(value);
    }
    return{tr,html:template,text:template,labels,get locale(){return current;},setLocale(value){current=value==='en'?'en':'zh-TW';return current;}};
  }
  function collect(source){const keys=new Set();staticText(source,{},key=>keys.add(key));return[...keys];}
  return{create,collect};
});
