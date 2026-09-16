/* Shared, dependency-free utilities. */
(() => {
  'use strict';
  const domains = ['com','ca','com.mx','com.br','co.uk','de','fr','it','es','nl','com.be','ie','pl','se','co.jp','in','com.au','sg','ae','sa','com.tr','eg','co.za','cn'];
  const normalize = value => {
    const s = String(value ?? '').trim().toUpperCase();
    return /^[A-Z0-9]{10}$/.test(s) ? s : null;
  };
  const unique = values => [...new Set((Array.isArray(values) ? values : []).map(normalize).filter(Boolean))];
  const isAmazon = host => domains.some(d => host === `amazon.${d}` || host.endsWith(`.amazon.${d}`));
  function fromURL(value, base = 'https://www.amazon.com/') {
    let url;
    try { url = new URL(value, base); } catch { return null; }
    if (!isAmazon(url.hostname)) return null;
    let path = url.pathname;
    for (let i = 0; i < 3; i++) {
      const match = path.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?=[/?#]|$)/i);
      if (match) return normalize(match[1]);
      try { const next = decodeURIComponent(path); if (next === path) break; path = next; } catch { break; }
    }
    // Sponsored-product redirects carry the destination in a query parameter.
    for (const key of ['url','redirectUrl','redirect','u']) {
      let nested = url.searchParams.get(key);
      if (!nested) continue;
      for (let i = 0; i < 3; i++) {
        try {
          const dest = new URL(nested, url.origin);
          if (isAmazon(dest.hostname)) {
            const match = dest.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?=[/?#]|$)/i);
            if (match) return normalize(match[1]);
          }
          const decoded = decodeURIComponent(nested);
          if (decoded === nested) break;
          nested = decoded;
        } catch { break; }
      }
    }
    return null;
  }
  globalThis.ASINCollector = Object.freeze({ domains, normalize, unique, isAmazon, fromURL });
})();
