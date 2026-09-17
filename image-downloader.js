// Adapted from the user-supplied Amazon Detail Image Downloader 2026-08-11.2.
(function () {
  'use strict';
  if (globalThis.__amazonImageDownloaderLoaded || !ASINCollector.isAmazon(location.hostname)) return;
  globalThis.__amazonImageDownloaderLoaded = true;
  let featureEnabled=false, stateRevision=-1, lifecycle=0, busy=false, observer=null, scanTimer=null, autoTimer=null;
  const WRAPPER_ID='ac-amazon-image-downloader-wrapper';

  const BUTTON_ID = 'ac-amazon-image-downloader-button';
  const APLUS_BUTTON_ID = 'ac-amazon-aplus-reload-button';
  const PANEL_ID = 'ac-amazon-image-downloader-panel';
  const AUTO_APLUS_ONLY_KEY = 'ac-amazon-image-downloader-auto-aplus-only';
  const DOWNLOAD_CONCURRENCY = 3;
  const REQUEST_TIMEOUT_MS = 20000;
  const INCLUDE_BRAND_STORY = false;
  const INCLUDE_COMPARISON_TABLE = false;

  const AMAZON_IMAGE_URL_RE = /https?:\/\/(?:m\.media-amazon\.com|(?:[^/"']+\.)?ssl-images-amazon\.com)\/images\/(?:I|G|S)\/[^\s"'<>)]*?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>)]*)?/gi;

  function isProductPage() {
    return /\/gp\/aw\/d\/[A-Z0-9]{10}/i.test(location.pathname) || /\/dp\/[A-Z0-9]{10}/i.test(location.pathname) ||
      /\/gp\/product\/[A-Z0-9]{10}/i.test(location.pathname) ||
      document.querySelector('#dp, #ppd, #centerCol, #landingImage');
  }

  function getAsin() {
    return ASINCollector.normalize(document.querySelector('#ASIN, input[name="ASIN"]')?.value)
      || ASINCollector.fromURL(location.href) || 'amazon-detail';
  }

  function decodeAmazonText(value) {
    return String(value || '')
      .trim()
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/\\u002F/gi, '/')
      .replace(/\\\//g, '/');
  }

  function cleanImageUrl(url) {
    if (!url) return '';
    const cleaned = decodeAmazonText(url)
      .replace(/^url\((['"]?)(.*?)\1\)$/i, '$2')
      .replace(/^\/\//, `${location.protocol}//`)
      .replace(/^['"]|['"]$/g, '');
    return cleaned.split(/[?#]/)[0];
  }

  function extractAmazonImageUrls(value) {
    const text = decodeAmazonText(value);
    return Array.from(text.matchAll(AMAZON_IMAGE_URL_RE), (match) => cleanImageUrl(match[0]));
  }

  function parseAmazonImageUrl(rawUrl) {
    const displayUrl = cleanImageUrl(rawUrl);
    if (!displayUrl) return null;

    const match = displayUrl.match(
      /^(https?:\/\/(?:m\.media-amazon\.com|(?:[^/]+\.)?ssl-images-amazon\.com)\/images\/([IGS])\/)(.+?)\.(jpg|jpeg|png|webp)$/i,
    );
    if (!match) return null;

    const [, prefix, bucket, pathAndFile, ext] = match;
    const slashIndex = pathAndFile.lastIndexOf('/');
    const dir = slashIndex === -1 ? '' : `${pathAndFile.slice(0, slashIndex + 1)}`;
    const filenameStem = slashIndex === -1 ? pathAndFile : pathAndFile.slice(slashIndex + 1);
    const transformIndex = filenameStem.indexOf('._');
    const baseId = transformIndex === -1 ? filenameStem : filenameStem.slice(0, transformIndex);
    const transform = transformIndex === -1 ? '' : filenameStem.slice(transformIndex + 1);
    const sourceUrl = `${prefix}${dir}${baseId}.${ext}`;

    return {
      bucket,
      image_id: bucket === 'I' ? baseId : `${bucket}/${dir}${baseId}`,
      source_url: sourceUrl,
      display_url: displayUrl,
      transform,
      ext: ext.toLowerCase().replace('jpeg', 'jpg'),
    };
  }

  function isUsefulAmazonImage(parsed) {
    if (!parsed) return false;
    const url = parsed.display_url.toLowerCase();
    return !/grey-pixel|transparent-pixel|spacer|sprite|loading|blank|icon|logo|sash\//.test(url);
  }

  function isLikelyProductMainImage(item) {
    if (item.bucket !== 'I') return false;
    if (/SS125|PKplay|play-button|video/i.test(item.display_url)) return false;
    if (/variant|twister|swatch|payment|warranty|insurance|rufus|sprite|extension/i.test(item.source)) return false;
    return true;
  }

  function isAPlusContentImage(item) {
    if (!['I','S','G'].includes(item.bucket)) return false;
    if (/brandStory|brand-story|apm-brand-story/i.test(item.source) && !INCLUDE_BRAND_STORY) return false;
    if (/comparison|compare-table|comparison-table/i.test(item.source) && !INCLUDE_COMPARISON_TABLE) return false;
    return true;
  }

  function scoreCandidate(item) {
    let score = 0;
    if (!item.transform) score += 30;
    if (/hires|old-hires|dynamic-image|colorimages|imageblock/i.test(item.source)) score += 20;
    if (/currentSrc|srcset|data-src/i.test(item.source)) score += 10;
    if (item.bucket === 'S' || item.display_url.includes('/aplus-media-library-service-media/')) score += 8;
    const width = item.transform.match(/(?:SX|UX|US|SR|QL|_)(\d{3,4})/i)?.[1];
    if (width) score += Math.min(Number(width) / 100, 20);
    return score;
  }

  function addCandidate(list, type, rawUrl, source) {
    const parsed = parseAmazonImageUrl(rawUrl);
    if (!isUsefulAmazonImage(parsed)) return;

    list.push({
      type,
      image_id: parsed.image_id,
      source_url: parsed.source_url,
      display_url: parsed.display_url,
      transform: parsed.transform,
      bucket: parsed.bucket,
      ext: parsed.ext,
      source,
    });
  }

  function addUrlsFromValue(list, type, value, source) {
    extractAmazonImageUrls(value).forEach((url) => addCandidate(list, type, url, source));
  }

  function addElementImages(list, type, element, sourcePrefix) {
    if (element.currentSrc) addCandidate(list, type, element.currentSrc, `${sourcePrefix} currentSrc`);
    if (element.src) addCandidate(list, type, element.src, `${sourcePrefix} src`);
    if (element.srcset) addUrlsFromValue(list, type, element.srcset, `${sourcePrefix} srcset`);

    Array.from(element.attributes || []).forEach((attr) => {
      if (/src|image|href|style|data/i.test(attr.name)) {
        addUrlsFromValue(list, type, attr.value, `${sourcePrefix} ${attr.name}`);
      }
    });
  }

  function uniqueByImageId(items) {
    const byId = new Map();
    items.forEach((item) => {
      const key = item.image_id;
      const current = byId.get(key);
      if (!current || scoreCandidate(item) > scoreCandidate(current)) {
        byId.set(key, item);
      }
    });
    return Array.from(byId.values());
  }

  // Read JSON data only; never execute Amazon's inline scripts.
  function readLiteral(text,start) {
    const quote=text[start]; let value='';
    for(let i=start+1;i<text.length;i++) {
      const c=text[i]; if(c===quote)return {value,end:i+1};
      if(c!=='\\'){value+=c;continue;}
      const n=text[++i];
      if(n==='u' || n==='x') {const count=n==='u'?4:2;const hex=text.slice(i+1,i+1+count);if(!new RegExp(`^[0-9a-f]{${count}}$`,'i').test(hex))return null;value+=String.fromCharCode(parseInt(hex,16));i+=count;}
      else value+=({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'}[n] ?? n);
    }
    return null;
  }
  function jsonAt(text,start) {
    while(/\s/.test(text[start]||'') && start<text.length)start++;
    if(text[start]==="'" || text[start]==='"'){const literal=readLiteral(text,start);if(!literal)return null;try{return JSON.parse(literal.value);}catch{return null;}}
    const open=text[start],close=open==='['?']':'}';if(!['[','{'].includes(open))return null;
    let depth=0;
    for(let i=start;i<text.length;i++){
      if(text[i]==='"' || text[i]==="'"){const literal=readLiteral(text,i);if(!literal)return null;i=literal.end-1;continue;}
      if(text[i]===open)depth++;
      if(text[i]===close && --depth===0){try{return JSON.parse(text.slice(start,i+1));}catch{return null;}}
    }
    return null;
  }
  function galleryRecords() {
    const current=getAsin();
    const landing=document.querySelector('#landingImage,#main-image,#imgBlkFront');
    const landingId=parseAmazonImageUrl(landing?.getAttribute('data-old-hires')||landing?.getAttribute('src'))?.image_id;
    const matchesLanding=arr=>!landingId || arr.some(r=>[r.hiRes,r.large,r.thumb,...Object.keys(r.main||{})].some(u=>parseAmazonImageUrl(u)?.image_id===landingId));
    for(const script of document.querySelectorAll('script')){
      const text=script.textContent||'';if(!/colorImages|imageGalleryData/.test(text))continue;
      const sourceAsin=text.match(/["']asin["']\s*:\s*["']([A-Z0-9]{10})["']/i)?.[1];
      if(sourceAsin && sourceAsin!==current)continue;
      const initial=/["']initial["']\s*:\s*(?:A\.\$\.parseJSON\s*\(\s*)?/g;
      let match;while((match=initial.exec(text))){const data=jsonAt(text,initial.lastIndex);if(Array.isArray(data)&&data.length&&matchesLanding(data))return data;}
      const keys=/["'](?:colorImages|imageGalleryData)["']\s*:\s*/g;
      while((match=keys.exec(text))){const data=jsonAt(text,keys.lastIndex);if(!data)continue;
        if(Array.isArray(data)&&data.length&&matchesLanding(data))return data;
        if(typeof data==='object' && landingId){for(const group of Object.values(data))if(Array.isArray(group)&&group.length&&matchesLanding(group))return group;}
      }
    }
    return [];
  }
  function mergeGallery(domItems) {
    const records=galleryRecords(), aliases=new Set(), gallery=[];
    for(const record of records){
      if(record.isVideo || /video/i.test(record.mediaType||''))continue;
      const best=record.hiRes || Object.keys(record.main||{}).sort((a,b)=>(record.main[b]?.[0]||0)-(record.main[a]?.[0]||0))[0] || record.large || record.lowRes;
      if(!best)continue;
      addCandidate(gallery,'main',best,'main colorImages hires');
      for(const u of [record.hiRes,record.large,record.thumb,record.lowRes,...Object.keys(record.main||{})]){const id=parseAmazonImageUrl(u)?.image_id;if(id)aliases.add(id);}
    }
    // Explicit gallery order wins. Thumbnail aliases are not additional images.
    return uniqueByImageId([...gallery,...domItems.filter(item=>!aliases.has(item.image_id))]).filter(isLikelyProductMainImage);
  }
  async function prepareImageQueue(mode,runLifecycle) {
    const asin=getAsin();let latest=buildImageQueue(mode),lastKey='',stable=0;
    const x=window.scrollX,y=window.scrollY;let userMoved=false,scrolled=false;
    const moved=()=>{userMoved=true;};window.addEventListener('wheel',moved,{passive:true});window.addEventListener('touchstart',moved,{passive:true});window.addEventListener('keydown',moved);
    try {
      for(let i=0;i<16;i++){
        if(!featureEnabled || lifecycle!==runLifecycle)break;
        if(getAsin()!==asin)throw new Error('扫描时商品变体发生变化，请在目标变体上重新下载');
        if(mode.includeAPlus&&!scrolled){const root=document.querySelector('#aplus_feature_div,#aplus,#aplus3p_feature_div,#aplus-mweb_feature_div');if(root){root.scrollIntoView({block:'start',behavior:'instant'});scrolled=true;}}
        await new Promise(resolve=>setTimeout(resolve,500));latest=buildImageQueue(mode);
        const key=latest.allImages.map(x=>x.image_id).join('|');stable=key===lastKey?stable+1:0;lastKey=key;
        setStatus(`正在识别：主图 ${latest.mainImages.length}，A+ ${latest.aplusImages.length}…`);
        if(stable>=3 && (!mode.includeMain||latest.mainImages.length) && (!mode.includeAPlus||latest.aplusImages.length))break;
      }
    } finally {
      window.removeEventListener('wheel',moved);window.removeEventListener('touchstart',moved);window.removeEventListener('keydown',moved);
      if(scrolled&&!userMoved)window.scrollTo(x,y);
    }
    return latest;
  }

  function collectMainImages() {
    const items = [];

    document.querySelectorAll('#landingImage, #imgBlkFront, .imgTagWrapper img, #main-image, #image-block img, #imageBlock_feature_div img, #imageBlock img, #main-image-container img, #imageBlockThumbs img, #altImages img, #imgTagWrapperId img').forEach((element) => {
      if (element.closest('.videoThumbnail, [class*=swatch], #twister, [id*=variation], [data-video-url]')) return;
      addElementImages(items, 'main', element, 'main landing image');
    });

    document.querySelectorAll('#altImages li.imageThumbnail:not(.videoThumbnail) img, #imageBlockThumbs li.imageThumbnail:not(.videoThumbnail) img').forEach((element) => {
      addElementImages(items, 'main', element, 'main thumbnail');
    });

    document.querySelectorAll('#main-image-container li.image:not(.videoThumbnail) img.a-dynamic-image, #imageBlock li.image:not(.videoThumbnail) img.a-dynamic-image').forEach((element) => {
      addElementImages(items, 'main', element, 'main media carousel');
    });

    return mergeGallery(items);
  }

  function collectAPlusImages() {
    const items = [];
    const roots = [
      ...document.querySelectorAll('#aplus_feature_div, #aplus, #aplus3p_feature_div, #aplus-mweb_feature_div, #productDescription .aplus-v2'),
      ...(INCLUDE_BRAND_STORY ? Array.from(document.querySelectorAll('#aplusBrandStory_feature_div .aplus-v2, #aplusBrandStory_feature_div')) : []),
    ];
    const uniqueRoots = roots.filter((root, index) => roots.indexOf(root) === index);

    uniqueRoots.forEach((root) => {
      root.querySelectorAll('img, source, [style], [data-src], [data-a-hires], [data-old-hires], [data-srcset], noscript').forEach((element) => {
        if (!INCLUDE_BRAND_STORY && element.closest('#aplusBrandStory_feature_div, .apm-brand-story-card, .apm-brand-story-hero')) return;
        if (!INCLUDE_COMPARISON_TABLE && element.closest('[class*="comparison"], [id*="comparison"], [class*="compare-table"], [id*="compare-table"]')) return;
        if (element.tagName === 'NOSCRIPT') { addUrlsFromValue(items,'aplus',element.textContent,'A+ noscript'); return; }
        const module = element.closest('.aplus-module, [data-cel-widget], .celwidget');
        addElementImages(items, 'aplus', element, `A+ node ${module?.className || module?.id || ''}`);
      });
    });

    return uniqueByImageId(items).filter(isAPlusContentImage);
  }

  function getDownloadUrls(image) {
    const mainDisplay1600 = image.type === 'main' ? toMainImage1600Url(image.display_url) : '';
    const mainSource1600 = image.type === 'main' ? toMainImage1600Url(image.source_url) : '';
    const preferred = image.type === 'main'
      ? [image.display_url, mainDisplay1600, mainSource1600, image.source_url]
      : [image.display_url, image.source_url];
    return Array.from(new Set(preferred.filter(Boolean)));
  }

  function toMainImage1600Url(url) {
    const clean = cleanImageUrl(url);
    if (!clean || !/\/images\/I\//i.test(clean)) return '';
    return clean
      .replace(/(_AC_SX)\d+(_)/i, '$11600$2')
      .replace(/(_AC_SY)\d+(_)/i, '$11600$2');
  }

  function guessExtension(url, contentType) {
    const type = (contentType || '').toLowerCase();
    if (type.includes('png')) return 'png';
    if (type.includes('webp')) return 'webp';
    if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
    return cleanImageUrl(url).match(/\.(jpg|jpeg|png|webp)$/i)?.[1].toLowerCase().replace('jpeg', 'jpg') || 'jpg';
  }

  async function fetchArrayBuffer(url) {
    if (!featureEnabled) throw new Error('图片下载已关闭');
    const response = await chrome.runtime.sendMessage({type:'FETCH_AMAZON_IMAGE',url});
    if (!response?.ok) throw new Error(response?.error || '图片请求失败');
    // Chrome message passing is JSON-based; reconstruct the binary image exactly.
    const binary = atob(response.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
    return {buffer:bytes.buffer,contentType:response.contentType,url};
  }

  async function fetchWithFallback(urls) {
    const errors=[];
    for(const url of urls){
      for(let attempt=0;attempt<2;attempt++){
        if(!featureEnabled)throw new Error('图片下载已关闭');
        try{return await fetchArrayBuffer(url);}catch(error){
          errors.push(`${url}: ${error.message || error}`);
          if(attempt===0 && /timeout|network|fetch|HTTP 5\d\d/i.test(error.message||'')){
            await new Promise(resolve=>setTimeout(resolve,350));continue;
          }
          break;
        }
      }
    }
    throw new Error(errors.join(' | '));
  }

  async function runPool(items, limit, worker) {
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(items[index], index);
      }
    });
    await Promise.all(workers);
  }

  function setStatus(text) {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.textContent = text;
  }

  function triggerDownload(blob, filename) {
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
  }

  function buildManifestEntry(image, file, status, extra) {
    return {
      file,
      type: image.type,
      image_id: image.image_id,
      source_url: image.source_url,
      display_url: image.display_url,
      transform: image.transform,
      page_source: image.source,
      status,
      ...extra,
    };
  }

  function createCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  }

  const CRC_TABLE = createCrcTable();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(dateValue) {
    const date = dateValue ? new Date(dateValue) : new Date();
    const year = Math.max(date.getFullYear(), 1980);
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  function writeU16(view, offset, value) {
    view.setUint16(offset, value & 0xffff, true);
  }

  function writeU32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function createZipInPage(files, onProgress) {
    const encoder = new TextEncoder();
    const normalizedFiles = files.map((file) => ({
      name: encoder.encode(file.name),
      data: new Uint8Array(file.buffer),
      date: file.date,
    }));
    const centralRecords = [];
    const chunks = [];
    let offset = 0;

    normalizedFiles.forEach((file, index) => {
      const crc = crc32(file.data);
      const { time, day } = dosDateTime(file.date);
      const local = new Uint8Array(30 + file.name.length);
      const localView = new DataView(local.buffer);
      writeU32(localView, 0, 0x04034b50);
      writeU16(localView, 4, 20);
      writeU16(localView, 6, 0x0800);
      writeU16(localView, 8, 0);
      writeU16(localView, 10, time);
      writeU16(localView, 12, day);
      writeU32(localView, 14, crc);
      writeU32(localView, 18, file.data.length);
      writeU32(localView, 22, file.data.length);
      writeU16(localView, 26, file.name.length);
      local.set(file.name, 30);
      chunks.push(local, file.data);

      centralRecords.push({
        crc,
        compressedSize: file.data.length,
        uncompressedSize: file.data.length,
        localOffset: offset,
        name: file.name,
        time,
        day,
      });
      offset += local.length + file.data.length;
      onProgress(Math.round(((index + 1) / normalizedFiles.length) * 80));
    });

    const centralStart = offset;
    centralRecords.forEach((record) => {
      const central = new Uint8Array(46 + record.name.length);
      const view = new DataView(central.buffer);
      writeU32(view, 0, 0x02014b50);
      writeU16(view, 4, 20);
      writeU16(view, 6, 20);
      writeU16(view, 8, 0x0800);
      writeU16(view, 10, 0);
      writeU16(view, 12, record.time);
      writeU16(view, 14, record.day);
      writeU32(view, 16, record.crc);
      writeU32(view, 20, record.compressedSize);
      writeU32(view, 24, record.uncompressedSize);
      writeU16(view, 28, record.name.length);
      writeU16(view, 30, 0);
      writeU16(view, 32, 0);
      writeU16(view, 34, 0);
      writeU16(view, 36, 0);
      writeU32(view, 38, 0);
      writeU32(view, 42, record.localOffset);
      central.set(record.name, 46);
      chunks.push(central);
      offset += central.length;
    });

    const centralSize = offset - centralStart;
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    writeU32(endView, 0, 0x06054b50);
    writeU16(endView, 4, 0);
    writeU16(endView, 6, 0);
    writeU16(endView, 8, centralRecords.length);
    writeU16(endView, 10, centralRecords.length);
    writeU32(endView, 12, centralSize);
    writeU32(endView, 16, centralStart);
    writeU16(endView, 20, 0);
    chunks.push(end);
    onProgress(95);
    return new Blob(chunks, { type: 'application/zip' });
  }

  function createZipInWorker(files, onProgress) {
    return new Promise((resolve, reject) => {
      const workerSource = `
        const crcTable = (() => {
          const table = new Uint32Array(256);
          for (let n = 0; n < 256; n += 1) {
            let c = n;
            for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
          }
          return table;
        })();

        function crc32(bytes) {
          let crc = 0xffffffff;
          for (let i = 0; i < bytes.length; i += 1) {
            crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
          }
          return (crc ^ 0xffffffff) >>> 0;
        }

        function dosDateTime(dateValue) {
          const date = dateValue ? new Date(dateValue) : new Date();
          const year = Math.max(date.getFullYear(), 1980);
          const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
          const day = (year - 1980) << 9 | ((date.getMonth() + 1) << 5) | date.getDate();
          return { time, day };
        }

        function writeU16(view, offset, value) {
          view.setUint16(offset, value & 0xffff, true);
        }

        function writeU32(view, offset, value) {
          view.setUint32(offset, value >>> 0, true);
        }

        self.onmessage = (event) => {
          try {
            const encoder = new TextEncoder();
            const files = event.data.files.map((file) => ({
              name: encoder.encode(file.name),
              nameText: file.name,
              data: new Uint8Array(file.buffer),
              date: file.date,
            }));
            const centralRecords = [];
            const chunks = [];
            let offset = 0;

            files.forEach((file, index) => {
              const crc = crc32(file.data);
              const { time, day } = dosDateTime(file.date);
              const local = new Uint8Array(30 + file.name.length);
              const localView = new DataView(local.buffer);
              writeU32(localView, 0, 0x04034b50);
              writeU16(localView, 4, 20);
              writeU16(localView, 6, 0x0800);
              writeU16(localView, 8, 0);
              writeU16(localView, 10, time);
              writeU16(localView, 12, day);
              writeU32(localView, 14, crc);
              writeU32(localView, 18, file.data.length);
              writeU32(localView, 22, file.data.length);
              writeU16(localView, 26, file.name.length);
              local.set(file.name, 30);
              chunks.push(local, file.data);

              centralRecords.push({
                crc,
                compressedSize: file.data.length,
                uncompressedSize: file.data.length,
                localOffset: offset,
                name: file.name,
                time,
                day,
              });
              offset += local.length + file.data.length;
              self.postMessage({ type: 'progress', percent: Math.round(((index + 1) / files.length) * 80) });
            });

            const centralStart = offset;
            centralRecords.forEach((record) => {
              const central = new Uint8Array(46 + record.name.length);
              const view = new DataView(central.buffer);
              writeU32(view, 0, 0x02014b50);
              writeU16(view, 4, 20);
              writeU16(view, 6, 20);
              writeU16(view, 8, 0x0800);
              writeU16(view, 10, 0);
              writeU16(view, 12, record.time);
              writeU16(view, 14, record.day);
              writeU32(view, 16, record.crc);
              writeU32(view, 20, record.compressedSize);
              writeU32(view, 24, record.uncompressedSize);
              writeU16(view, 28, record.name.length);
              writeU16(view, 30, 0);
              writeU16(view, 32, 0);
              writeU16(view, 34, 0);
              writeU16(view, 36, 0);
              writeU32(view, 38, 0);
              writeU32(view, 42, record.localOffset);
              central.set(record.name, 46);
              chunks.push(central);
              offset += central.length;
            });

            const centralSize = offset - centralStart;
            const end = new Uint8Array(22);
            const endView = new DataView(end.buffer);
            writeU32(endView, 0, 0x06054b50);
            writeU16(endView, 4, 0);
            writeU16(endView, 6, 0);
            writeU16(endView, 8, centralRecords.length);
            writeU16(endView, 10, centralRecords.length);
            writeU32(endView, 12, centralSize);
            writeU32(endView, 16, centralStart);
            writeU16(endView, 20, 0);
            chunks.push(end);
            self.postMessage({ type: 'progress', percent: 95 });
            self.postMessage({ type: 'done', blob: new Blob(chunks, { type: 'application/zip' }) });
          } catch (error) {
            self.postMessage({ type: 'error', message: String(error && error.message ? error.message : error) });
          }
        };
      `;
      const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      const worker = new Worker(workerUrl);
      worker.onmessage = (event) => {
        const message = event.data || {};
        if (message.type === 'progress') {
          onProgress(message.percent);
          return;
        }
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        if (message.type === 'done') {
          resolve(message.blob);
        } else {
          reject(new Error(message.message || 'ZIP worker failed'));
        }
      };

      worker.onerror = (error) => {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        reject(new Error(error.message || 'ZIP worker error'));
      };

      worker.postMessage({ files });
    });
  }

  function getButtons() {
    return [
      document.getElementById(BUTTON_ID),
      document.getElementById(APLUS_BUTTON_ID),
    ].filter(Boolean);
  }

  function setButtonsDisabled(disabled) {
    getButtons().forEach((button) => {
      button.disabled = disabled;
      button.style.cursor = disabled ? 'wait' : 'pointer';
      button.style.opacity = disabled ? '.72' : '1';
    });
  }

  function buildImageQueue(options) {
    const mainImages = options.includeMain ? collectMainImages() : [];
    const aplusImages = options.includeAPlus ? collectAPlusImages() : [];
    const allImages = [
      ...mainImages.map((item, index) => ({ ...item, filenamePrefix: `main_${String(index + 1).padStart(2, '0')}` })),
      ...aplusImages.map((item, index) => ({ ...item, filenamePrefix: `aplus_${String(index + 1).padStart(2, '0')}` })),
    ];
    return { mainImages, aplusImages, allImages };
  }

  async function downloadImages(options = {}) {
    if (!featureEnabled || busy || !isProductPage()) return;
    const runLifecycle=lifecycle;
    const downloadAsin=getAsin();
    const mode = {
      includeMain: options.includeMain !== false,
      includeAPlus: options.includeAPlus !== false,
      filenameSuffix: options.filenameSuffix || 'detail_images',
    };

    busy=true;
    setButtonsDisabled(true);
    setStatus('正在等待图片并扫描主图／A+，请稍候…');
    let prepared;
    try { prepared = await prepareImageQueue(mode,runLifecycle); }
    catch(error) { if(options.mobileTask) chrome.runtime.sendMessage({type:'END_MOBILE_MODE'}).catch(()=>{}); busy=false; setButtonsDisabled(false); setStatus(`扫描失败：${error.message}`); return; }
    if (!featureEnabled || lifecycle!==runLifecycle) { busy=false; setButtonsDisabled(false); return; }
    const {mainImages,aplusImages,allImages}=prepared;
    if (!allImages.length) {
      busy=false; setButtonsDisabled(false);
      setStatus(`未识别到图片。主图 ${mainImages.length}，A+ ${aplusImages.length}。页面可能尚未加载、没有 A+ 或当前布局尚不支持；可尝试下方手机端按钮。`);
      if (options.mobileTask) chrome.runtime.sendMessage({type:'END_MOBILE_MODE'}).catch(()=>{});
      return;
    }

    setButtonsDisabled(true);
    const mainButton = document.getElementById(BUTTON_ID);
    if (mainButton) mainButton.textContent = '正在打包…';

    const zipFiles = [];
    const manifest = new Array(allImages.length);
    let doneCount = 0;
    let okCount = 0;

    try {
      setStatus(`Queue ready: main ${mainImages.length}, A+ ${aplusImages.length}. Downloading 0/${allImages.length}...`);
      const queue = allImages.map((image, index) => ({
        index: index + 1,
        filenamePrefix: image.filenamePrefix,
        type: image.type,
        image_id: image.image_id,
        source_url: image.source_url,
        display_url: image.display_url,
        transform: image.transform,
        attempted_urls: getDownloadUrls(image),
        page_source: image.source,
      }));

      await runPool(allImages, DOWNLOAD_CONCURRENCY, async (image, index) => {
        try {
          if (!featureEnabled || lifecycle !== runLifecycle) throw new Error('图片下载已关闭');
          const urls = getDownloadUrls(image);
          const result = await fetchWithFallback(urls);
          const ext = guessExtension(result.url, result.contentType);
          const filename = `${image.filenamePrefix}.${ext}`;

          zipFiles.push({
            name: filename,
            buffer: result.buffer,
            date: new Date().toISOString(),
          });
          manifest[index] = buildManifestEntry(image, filename, 'ok', {
            download_url: result.url,
            attempted_urls: urls,
            bytes: result.buffer.byteLength,
          });
          okCount += 1;
        } catch (error) {
          manifest[index] = buildManifestEntry(image, image.filenamePrefix, 'failed', {
            attempted_urls: getDownloadUrls(image),
            error: String(error.message || error),
          });
        } finally {
          doneCount += 1;
          setStatus(`Queue main ${mainImages.length}, A+ ${aplusImages.length}. Downloaded ${doneCount}/${allImages.length}, ok ${okCount}.`);
        }
      });

      if (!featureEnabled || lifecycle !== runLifecycle) return;
      zipFiles.push({name:'diagnostics.json',buffer:new TextEncoder().encode(JSON.stringify({asin:downloadAsin,page:location.href,mainCount:mainImages.length,aplusCount:aplusImages.length,missingMain:mode.includeMain&&!mainImages.length,missingAPlus:mode.includeAPlus&&!aplusImages.length},null,2)).buffer});
      zipFiles.push({
        name: 'queue.json',
        buffer: new TextEncoder().encode(JSON.stringify(queue, null, 2)).buffer,
        date: new Date().toISOString(),
      });
      zipFiles.push({
        name: 'manifest.json',
        buffer: new TextEncoder().encode(JSON.stringify(manifest, null, 2)).buffer,
        date: new Date().toISOString(),
      });
      setStatus('Generating ZIP 0%...');

      let zipBlob;
      try {
        zipBlob = await createZipInWorker(
          zipFiles,
          (percent) => setStatus(`Generating ZIP ${percent}%...`),
        );
      } catch (error) {
        setStatus(`Worker ZIP failed, using fallback... ${error.message || error}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        zipBlob = createZipInPage(
          zipFiles,
          (percent) => setStatus(`Generating ZIP ${percent}%...`),
        );
      }
      if (!featureEnabled || lifecycle !== runLifecycle) return;
      triggerDownload(zipBlob, `${downloadAsin}_amazon_${mode.filenameSuffix}.zip`);

      const failCount = manifest.filter((item) => item.status !== 'ok').length;
      setStatus(`完成：主图 ${mainImages.length}，A+ ${aplusImages.length}；成功 ${okCount}，失败 ${failCount}。${mode.includeMain&&!mainImages.length?'【未识别到主图】':''}${mode.includeAPlus&&!aplusImages.length?'【未识别到 A+】':''}`);
    } catch (error) {
      setStatus(`Failed: ${error.message || error}`);
    } finally {
      if(options.mobileTask) chrome.runtime.sendMessage({type:'END_MOBILE_MODE'}).catch(()=>{});
      busy=false;
      setButtonsDisabled(false);
      if (mainButton) mainButton.textContent = '下载主图＋A+';
    }
  }

  async function reloadThenDownloadAPlusOnly() {
    if (!featureEnabled || busy) return;
    const asin=getAsin();
    if (!ASINCollector.normalize(asin)) { setStatus('无法识别当前商品 ASIN。'); return; }
    try {
      setButtonsDisabled(true);
      sessionStorage.setItem(AUTO_APLUS_ONLY_KEY, '1');
      const result=await chrome.runtime.sendMessage({type:'START_MOBILE_MODE',asin});
      if (!result?.ok) throw new Error(result?.error || '手机端切换失败');
      setStatus('已启用本标签页手机端请求，正在跳转并准备 A+…');
      location.assign(result.url);
    } catch(error) {
      sessionStorage.removeItem(AUTO_APLUS_ONLY_KEY);
      chrome.runtime.sendMessage({type:'END_MOBILE_MODE'}).catch(()=>{});
      setButtonsDisabled(false); setStatus(`切换失败：${error.message}`);
    }
  }

  function injectButton() {
    if (!featureEnabled) return;
    if (!isProductPage()) { document.getElementById(WRAPPER_ID)?.remove(); return; }
    if (document.getElementById(BUTTON_ID)) return;

    const wrapper = document.createElement('div');
    wrapper.id=WRAPPER_ID;
    wrapper.style.cssText = [
      'position:fixed',
      'right:18px',
      'top:120px',
      'z-index:2147483647',
      'display:flex',
      'flex-direction:column',
      'align-items:flex-end',
      'gap:6px',
      'font-family:Arial, sans-serif',
    ].join(';');

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '下载主图＋A+';
    button.style.cssText = [
      'border:1px solid #8a5a00',
      'background:#ffd814',
      'color:#111',
      'border-radius:8px',
      'padding:10px 14px',
      'font-size:14px',
      'font-weight:700',
      'box-shadow:0 2px 8px rgba(0,0,0,.22)',
      'cursor:pointer',
    ].join(';');

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.textContent = '仅主图与 A+ 正文，不含品牌故事和对比表。';
    panel.style.cssText = [
      'max-width:300px',
      'padding:6px 8px',
      'border-radius:6px',
      'background:rgba(17,17,17,.82)',
      'color:#fff',
      'font-size:12px',
      'line-height:1.35',
      'box-shadow:0 2px 8px rgba(0,0,0,.18)',
    ].join(';');

    const aplusButton = document.createElement('button');
    aplusButton.id = APLUS_BUTTON_ID;
    aplusButton.type = 'button';
    aplusButton.textContent = '切换手机端刷新下载A+';
    aplusButton.style.cssText = [
      'border:1px solid #5f6368',
      'background:#fff',
      'color:#111',
      'border-radius:8px',
      'padding:8px 12px',
      'font-size:12px',
      'font-weight:700',
      'box-shadow:0 2px 8px rgba(0,0,0,.18)',
      'cursor:pointer',
    ].join(';');

    button.addEventListener('click', () => downloadImages({
      includeMain: true,
      includeAPlus: true,
      filenameSuffix: 'detail_images',
    }));
    aplusButton.addEventListener('click', reloadThenDownloadAPlusOnly);
    wrapper.append(button, aplusButton, panel);
    document.body.appendChild(wrapper);
    setButtonsDisabled(busy);
  }

  function applyState(state) {
    if (!state || state.revision < stateRevision) return;
    stateRevision=state.revision;
    const enabled=state.imagesEnabled === true;
    if (enabled === featureEnabled) return;
    featureEnabled=enabled;
    lifecycle++;
    if (!enabled) {
      observer?.disconnect(); observer=null;
      clearTimeout(scanTimer); scanTimer=null;
      clearTimeout(autoTimer); autoTimer=null;
      document.getElementById(WRAPPER_ID)?.remove();
      chrome.runtime.sendMessage({type:'END_MOBILE_MODE'}).catch(()=>{});
      try { sessionStorage.removeItem(AUTO_APLUS_ONLY_KEY); } catch {}
      return;
    }
    injectButton();
    observer=new MutationObserver(records => {
      if (records.every(r => r.target.nodeType===1 && r.target.closest('#'+WRAPPER_ID))) return;
      if (!scanTimer) scanTimer=setTimeout(() => {scanTimer=null;injectButton();},150);
    });
    observer.observe(document.documentElement,{childList:true,subtree:true});
    try {
      if (sessionStorage.getItem(AUTO_APLUS_ONLY_KEY)==='1') {
        sessionStorage.removeItem(AUTO_APLUS_ONLY_KEY);
        autoTimer=setTimeout(() => downloadImages({includeMain:false,includeAPlus:true,filenameSuffix:'aplus_only',mobileTask:true}),2500);
      }
    } catch {}
  }
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area==='local' && changes.asinCollectorState?.newValue) applyState(changes.asinCollectorState.newValue);
  });
  chrome.runtime.sendMessage({type:'GET_STATE'}).then(result => {
    if (result?.ok) applyState(result.state);
  }).catch(() => {});
})();
