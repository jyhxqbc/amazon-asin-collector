// Temporary mobile request headers, scoped to the requesting tab and marketplace.
(() => {
  let jobs=Promise.resolve();
  const PREFIX='ac-mobile-';
  const ua='Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  async function remove(rules) {
    if (!rules.length) return;
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:rules.map(r=>r.id)});
    for(const rule of rules) await chrome.alarms.clear(PREFIX+rule.id);
  }
  async function end(tabId) {
    const rules=await chrome.declarativeNetRequest.getSessionRules();
    await remove(rules.filter(r=>r.id>=10000 && (tabId===undefined || r.condition.tabIds?.includes(tabId))));
  }
  async function handle(message,sender) {
    const tabId=sender.tab?.id;
    if (!Number.isInteger(tabId) || tabId<0) throw new Error('无法识别当前标签页');
    if(message.type==='END_MOBILE_MODE') { await end(tabId); return {ok:true}; }
    const page=new URL(sender.url || sender.tab.url);
    const asin=ASINCollector.normalize(message.asin);
    if(page.protocol!=='https:' || !ASINCollector.isAmazon(page.hostname) || !asin) throw new Error('仅支持亚马逊商品页');
    if(!(await chrome.storage.local.get('asinCollectorState')).asinCollectorState?.imagesEnabled) throw new Error('请先开启图片下载');
    await end(tabId);
    const rules=await chrome.declarativeNetRequest.getSessionRules();
    let id=10000; while(rules.some(r=>r.id===id)) id++;
    await chrome.declarativeNetRequest.updateSessionRules({addRules:[{id,priority:1,
      condition:{tabIds:[tabId],requestDomains:[page.hostname],resourceTypes:['main_frame','sub_frame','xmlhttprequest']},
      action:{type:'modifyHeaders',requestHeaders:[{header:'user-agent',operation:'set',value:ua},{header:'sec-ch-ua-mobile',operation:'set',value:'?1'},{header:'sec-ch-ua-platform',operation:'set',value:'"Android"'}]}}]});
    await chrome.alarms.create(PREFIX+id,{delayInMinutes:3});
    return {ok:true,url:new URL(`/gp/aw/d/${asin}?psc=1`,page.origin).href};
  }
  function enqueue(fn){const job=jobs.then(fn);jobs=job.catch(()=>{});return job;}
  chrome.runtime.onMessage.addListener((m,sender,respond)=>{
    if(sender.id!==chrome.runtime.id || !['START_MOBILE_MODE','END_MOBILE_MODE'].includes(m?.type))return false;
    enqueue(()=>handle(m,sender)).then(respond,e=>respond({ok:false,error:e.message}));return true;
  });
  chrome.tabs.onRemoved.addListener(id=>{enqueue(()=>end(id));});
  chrome.alarms.onAlarm.addListener(alarm=>{
    if(alarm.name.startsWith(PREFIX)) enqueue(async()=>remove((await chrome.declarativeNetRequest.getSessionRules()).filter(r=>r.id===Number(alarm.name.slice(PREFIX.length)))));
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='local' && changes.asinCollectorState?.newValue?.imagesEnabled===false)enqueue(()=>end());
  });
})();
