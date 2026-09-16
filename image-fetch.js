// Privileged replacement for the userscript's GM_xmlhttpRequest.
// Requests run outside the ASIN write queue, keeping both switches independent.
(() => {
  function validateImageURL(value) {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      !(host === 'm.media-amazon.com' || host === 'ssl-images-amazon.com' || host.endsWith('.ssl-images-amazon.com')) ||
      !/^\/images\/[IGS]\/.+\.(jpg|jpeg|png|webp)$/i.test(url.pathname)) {
      throw new Error('只允许请求亚马逊图片 CDN 中的图片');
    }
    url.protocol = 'https:';
    return url.href;
  }
  async function loadImage(value) {
    const url = validateImageURL(value);
    const raw = (await chrome.storage.local.get('asinCollectorState')).asinCollectorState;
    if (!raw?.imagesEnabled) throw new Error('图片下载功能已关闭');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(url, { signal: controller.signal, credentials:'omit', redirect:'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (/text\/|application\/(json|xml)/i.test(contentType)) throw new Error('服务器返回了非图片内容');
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) throw new Error('图片内容为空');
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let offset=0;offset<bytes.length;offset+=32768) binary += String.fromCharCode(...bytes.subarray(offset,offset+32768));
      return {ok:true,base64:btoa(binary),contentType};
    } catch(error) {
      if (error.name === 'AbortError') throw new Error('timeout');
      throw error;
    } finally { clearTimeout(timer); }
  }
  chrome.runtime.onMessage.addListener((message,sender,respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'FETCH_AMAZON_IMAGE') return false;
    loadImage(message.url).then(respond,error => respond({ok:false,error:error.message || 'network error'}));
    return true;
  });
})();
