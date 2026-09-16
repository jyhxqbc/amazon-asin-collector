(() => {
  'use strict';
  if (globalThis.__asinCollectorLoaded || !ASINCollector.isAmazon(location.hostname)) return;
  globalThis.__asinCollectorLoaded = true;
  const { normalize, fromURL } = ASINCollector;
  const HOST = 'asin-collector-ui';
  const CARD = '[data-component-type="s-search-result"],.s-result-item[data-asin],.zg-grid-general-faceout,.zg-item-immersion,[id="gridItemRoot"],li.a-carousel-card,.p13n-sc-uncoverable-faceout,.p13n-sc-completable-faceout';
  const ATTR = '[data-asin],[data-csa-c-asin],[data-p13n-asin],[data-csa-c-item-id],[data-p13n-asin-metadata]';
  const LINK = 'a[href*="/dp/"],a[href*="/gp/product/"],a[href*="/gp/aw/d/"],a[href*="%2Fdp%2F"],a[href*="%2fdp%2f"],a[href*="/sspa/click"],a[href*="/slredirect/"]';
  const mounted = new Map();
  const pending = new Set();
  let state = { enabled:false, asins:[], revision:-1 }, collected = new Set();
  let observer, timer, poller;
  let lastError = '';
  const uiCSS = `
    :host{all:initial!important;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif!important;color-scheme:light!important}
    *{box-sizing:border-box}button{font-family:inherit;cursor:pointer;border:1px solid #cddfd9;border-radius:6px;background:#fff;color:#275448;font-size:12px;line-height:18px;padding:4px 9px;white-space:nowrap;box-shadow:0 1px 2px #1232}
    button:hover{background:#eaf6f1;border-color:#0b8069}button:focus-visible{outline:2px solid #0b8069;outline-offset:2px}button:disabled{opacity:.55;cursor:wait}
    .bar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:4px 0 6px;text-align:left;line-height:normal}
    .collect{background:#0b8069;color:#fff;border-color:#0b8069}.collect:hover{background:#096c58}.collect.saved{background:#eaf6f1;color:#08604e;border-color:#a8cebd}
    .error{color:#b42318;font-size:11px;line-height:1.4}
  `;
  function uiHost() {
    const host = document.createElement(HOST);
    host.dataset.mode = 'card';
    host.style.setProperty('display','block','important');
    host.style.setProperty('position','relative','important');
    host.style.setProperty('z-index','5','important');
    host.style.setProperty('width','100%','important');
    host.style.setProperty('clear','both','important');
    const root = host.attachShadow({mode:'open'});
    const style = document.createElement('style'); style.textContent = uiCSS; root.append(style);
    // Avoid the card's delegated navigation and add-to-cart handlers.
    for (const type of ['click','dblclick','mousedown','pointerdown','keydown','keyup']) host.addEventListener(type, event => event.stopPropagation());
    return {host,root};
  }
  function button(text, className, action) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = className;
    b.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(); });
    return b;
  }
  async function request(message) {
    try {
      const result = await chrome.runtime.sendMessage(message);
      if (!result?.ok) throw new Error(result?.error || '保存失败，请重试');
      apply(result.state); return result.state;
    } catch(e) {
      lastError = /context invalidated|receiving end/i.test(e.message) ? '插件已更新，请刷新当前网页。' : `操作未保存：${e.message}`;
      for (const info of mounted.values()) { info.error.textContent = lastError; }
      throw e;
    }
  }
  function refreshUI() {
    for (const info of mounted.values()) {
      const saved = collected.has(info.asin);
      info.collect.textContent = saved ? '取消收集' : '收集';
      info.collect.classList.toggle('saved', saved);
      info.collect.setAttribute('aria-pressed',String(saved));
      info.collect.title = `${saved ? '取消收集' : '收集'} ${info.asin}`;
      info.collect.disabled = pending.has(info.asin);
      info.list.textContent = `已收集 (${collected.size})`;
    }
  }
  function ownASIN(el) {
    for (const attr of ['data-asin','data-csa-c-asin','data-p13n-asin']) {
      const asin = normalize(el.getAttribute(attr)); if (asin) return asin;
    }
    const item = el.getAttribute('data-csa-c-item-id') || '';
    const match = item.match(/(?:^|\.)([A-Z0-9]{10})$/i);
    if (match) return normalize(match[1]);
    try {
      const data = JSON.parse(el.getAttribute('data-p13n-asin-metadata') || 'null');
      if (data && normalize(data.asin || data.ASIN)) return normalize(data.asin || data.ASIN);
    } catch {}
    return null;
  }
  function linkASINs(el) {
    const result = new Set();
    for (const link of el.querySelectorAll(LINK)) {
      const asin = fromURL(link.getAttribute('href'),location.href);
      if (asin) result.add(asin);
      if (result.size > 1) break;
    }
    return result;
  }
  function infer(el) {
    const direct = ownASIN(el); if (direct) return direct;
    const links = linkASINs(el);
    if (links.size === 1) return [...links][0];
    if (links.size > 1) return null;
    const attrs = new Set([...el.querySelectorAll(ATTR)].map(ownASIN).filter(Boolean));
    return attrs.size === 1 ? [...attrs][0] : null;
  }
  function discover() {
    const candidates = new Map();
    const blocked = el => !!el.closest(`${HOST},#nav-main,#nav-belt,#navFooter,header,footer`);
    // Outer product containers are preferred, avoiding duplicate bars on inner nodes.
    for (const el of document.querySelectorAll(CARD)) {
      if (blocked(el) || el.tagName === 'A') continue;
      if ([...candidates.keys()].some(parent => parent.contains(el))) continue;
      const asin = infer(el);
      if (asin) candidates.set(el,{asin});
    }
    for (const el of document.querySelectorAll(ATTR)) {
      if (blocked(el) || !['DIV','LI','ARTICLE','SECTION'].includes(el.tagName)) continue;
      if ([...candidates.keys()].some(parent => parent.contains(el) || el.contains(parent))) continue;
      const asin = ownASIN(el);
      if (!asin || (!el.querySelector('img') && !el.querySelector(LINK))) continue;
      // Broad recommendation widgets are not single product cards.
      const links = linkASINs(el);
      if (links.size > 1 || (links.size === 1 && !links.has(asin))) continue;
      candidates.set(el,{asin});
    }
    // Fallback for cards without data-asin: only a small image-bearing container
    // whose product links all resolve to the same ASIN is eligible.
    for (const link of document.querySelectorAll(LINK)) {
      if (blocked(link) || [...candidates.keys()].some(parent => parent.contains(link))) continue;
      const asin = fromURL(link.getAttribute('href'),location.href);
      if (!asin) continue;
      let el = link.parentElement;
      for (let depth=0; el && depth<5; depth++,el=el.parentElement) {
        if (['BODY','HTML','MAIN'].includes(el.tagName) || /^(dp|ppd|centerCol|rightCol|leftCol|search|zg|zg-ordered-list)$/.test(el.id)) break;
        if (!['DIV','LI','ARTICLE'].includes(el.tagName) || !el.querySelector('img')) continue;
        if (el.closest('a') || [...candidates.keys()].some(parent => parent.contains(el) || el.contains(parent))) break;
        const asins = linkASINs(el);
        if (asins.size > 1) break;
        if (asins.size === 1 && asins.has(asin)) { candidates.set(el,{asin}); break; }
      }
    }
    const title = document.querySelector('#productTitle,#title_feature_div h1');
    if (title) {
      const asin = normalize(document.querySelector('#ASIN')?.value)
        || normalize(document.querySelector('form input[name="ASIN"]')?.value)
        || fromURL(location.href);
      const owner = title.closest('#title_feature_div') || title.parentElement;
      if (asin && owner) {
        for (const el of candidates.keys()) if (el === owner || el.contains(owner) || owner.contains(el)) candidates.delete(el);
        candidates.set(owner,{asin,main:true});
      }
    }
    return candidates;
  }
  function mount(owner,data) {
    const {host,root} = uiHost();
    const bar = document.createElement('div'); bar.className='bar';
    const info={...data,host};
    host.dataset.asin = data.asin;
    if (data.main) host.dataset.main='true';
    info.collect=button('收集','collect',async () => {
      if (pending.has(info.asin)) return;
      pending.add(info.asin); refreshUI();
      info.error.textContent='';
      try { await request({type:'SET_COLLECTED',asin:info.asin,selected:!collected.has(info.asin)}); }
      catch {} finally { pending.delete(info.asin); refreshUI(); }
    });
    info.error=document.createElement('span'); info.error.className='error'; info.error.setAttribute('role','status');
    info.list=button('已收集 (0)','',() => {});
    info.list.title='已收集的 ASIN 总数；点击浏览器工具栏的插件图标查看完整列表';
    bar.append(info.collect,info.list,info.error); root.append(bar);
    owner.prepend(host); mounted.set(owner,info);
  }
  function scan() {
    timer=null; if (!state.enabled) return;
    const candidates=discover();
    for (const [owner,info] of mounted) {
      if (!owner.isConnected || !info.host.isConnected || !candidates.has(owner) || candidates.get(owner).asin !== info.asin) {
        info.host.remove(); mounted.delete(owner);
      }
    }
    for (const [owner,data] of candidates) if (!mounted.has(owner)) mount(owner,data);
    refreshUI();
  }
  function schedule() { if (!timer && state.enabled) timer=setTimeout(scan,160); }
  function start() {
    if (observer) return;
    observer=new MutationObserver(records => {
      const relevant=records.some(record => {
        if (record.target.nodeType === 1 && record.target.closest(HOST)) return false;
        if (record.type === 'attributes') return true;
        return [...record.addedNodes,...record.removedNodes].some(node => node.nodeType === 1 && node.localName !== HOST);
      });
      if (relevant) schedule();
    });
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-asin','data-csa-c-asin','data-p13n-asin','data-csa-c-item-id','data-p13n-asin-metadata','href','value']});
    // Some variant pickers update input.value without an attribute mutation.
    poller=setInterval(() => { if (!document.hidden) schedule(); },2500);
    scan();
  }
  function stop() {
    observer?.disconnect(); observer=null; clearTimeout(timer); timer=null; clearInterval(poller);
    for (const info of mounted.values()) info.host.remove(); mounted.clear();
  }
  function apply(next) {
    if (!next || next.revision < state.revision) return;
    const wasEnabled=state.enabled;
    state={...next,asins:ASINCollector.unique(next.asins)}; collected=new Set(state.asins);
    if (state.enabled && !wasEnabled) start();
    if (!state.enabled && wasEnabled) stop();
    refreshUI();
  }
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area === 'local' && changes.asinCollectorState?.newValue) apply(changes.asinCollectorState.newValue);
  });
  request({type:'GET_STATE'}).catch(() => {});
})();
