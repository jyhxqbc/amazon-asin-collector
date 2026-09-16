'use strict';
const $ = id => document.getElementById(id);
let revision = -1;
function render(state) {
  if (!state || state.revision < revision) return;
  revision = state.revision;
  $('enabled').checked = state.enabled;
  $('images-enabled').checked = state.imagesEnabled === true;
  $('images-status').textContent = state.imagesEnabled ? '已开启 · 详情页显示下载按钮' : '已关闭 · 独立于 ASIN 收集';
  $('status').textContent = state.enabled ? '已开启 · 商品卡显示收集按钮' : '已关闭 · 开启后开始收集';
  $('count').textContent = `${state.asins.length} 个`;
  const value = state.asins.join('\n');
  if ($('asins').value !== value) $('asins').value = value;
}
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '无法连接插件，请关闭弹窗后重试');
  render(result.state);
}
function error(e) { $('notice').textContent = e.message; }
$('enabled').addEventListener('change', async () => {
  $('enabled').disabled = true;
  try { await request({ type:'SET_ENABLED', enabled:$('enabled').checked }); }
  catch(e) { $('enabled').checked = !$('enabled').checked; error(e); }
  finally { $('enabled').disabled = false; }
});
$('images-enabled').addEventListener('change', async () => {
  $('images-enabled').disabled = true;
  try { await request({type:'SET_IMAGES_ENABLED',enabled:$('images-enabled').checked}); }
  catch(e) { $('images-enabled').checked = !$('images-enabled').checked; error(e); }
  finally { $('images-enabled').disabled = false; }
});
$('dedupe').addEventListener('click', async () => {
  try { await request({type:'DEDUPE'}); $('notice').textContent = '已去重，同一 ASIN 仅保留一次。'; } catch(e) { error(e); }
});
$('copy').addEventListener('click', async () => {
  if (!$('asins').value) { $('notice').textContent = '还没有收集 ASIN。'; return; }
  try { await navigator.clipboard.writeText($('asins').value); $('notice').textContent = '已复制全部 ASIN。'; }
  catch { $('asins').focus(); $('asins').select(); $('notice').textContent = '请按 Ctrl+C（Mac：⌘C）复制。'; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.asinCollectorState?.newValue) render(changes.asinCollectorState.newValue);
});
request({type:'GET_STATE'}).then(() => { $('enabled').disabled = false; $('images-enabled').disabled = false; }).catch(error);
