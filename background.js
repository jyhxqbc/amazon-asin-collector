importScripts('common.js', 'image-fetch.js');
'use strict';
const KEY = 'asinCollectorState';
let queue = Promise.resolve();
async function readState() {
  const raw = (await chrome.storage.local.get(KEY))[KEY] || {};
  return { enabled: raw.enabled === true, imagesEnabled: raw.imagesEnabled === true, asins: ASINCollector.unique(raw.asins), revision: Number(raw.revision) || 0 };
}
async function badge(state) {
  await chrome.action.setBadgeBackgroundColor({ color: state.enabled ? '#0b8069' : '#64748b' });
  await chrome.action.setBadgeText({ text: state.asins.length ? String(state.asins.length) : '' });
}
async function handle(message) {
  const state = await readState();
  if (message.type === 'GET_STATE') return { ok: true, state };
  if (message.type === 'SET_ENABLED') state.enabled = message.enabled === true;
  else if (message.type === 'SET_IMAGES_ENABLED') state.imagesEnabled = message.enabled === true;
  else if (message.type === 'SET_COLLECTED') {
    const asin = ASINCollector.normalize(message.asin);
    if (!asin) throw new Error('ASIN 格式无效');
    if (message.selected === true && !state.asins.includes(asin)) state.asins.push(asin);
    if (message.selected === false) state.asins = state.asins.filter(x => x !== asin);
  } else if (message.type !== 'DEDUPE') throw new Error('未知操作');
  state.revision++;
  // All writes are serialized here, preventing lost updates across tabs.
  await chrome.storage.local.set({ [KEY]: state });
  await badge(state).catch(() => {});
  return { ok: true, state };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !['GET_STATE','SET_ENABLED','SET_IMAGES_ENABLED','SET_COLLECTED','DEDUPE'].includes(message?.type)) return false;
  const job = queue.then(() => handle(message));
  queue = job.catch(() => {});
  job.then(respond, error => respond({ ok: false, error: error.message || '保存失败，请重试' }));
  return true;
});
chrome.runtime.onInstalled.addListener(() => { queue = queue.then(async () => badge(await readState())).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { queue = queue.then(async () => badge(await readState())).catch(() => {}); });
