// popup:连接状态、配对、暂停开关。所有实际动作都交给 background.js。
const $ = (id) => document.getElementById(id);

async function ask(type, extra = {}) {
  try {
    return await chrome.runtime.sendMessage({ type, ...extra });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function render(status) {
  if (!status) return;
  const dot = $('dot');
  dot.className = 'dot' + (status.connected ? ' on' : (status.connecting ? ' warn' : ''));
  $('state').textContent = status.connected
    ? '已连接'
    : (status.connecting ? '连接中…' : (status.hasToken ? '未连接' : '未配对'));
  $('ver').textContent = status.browser ? `${status.browser} · v${status.version}` : `v${status.version}`;
  $('paused').checked = status.paused === true;
  $('err').textContent = status.error || '';
  if (status.serverBase && !$('server').value) $('server').value = status.serverBase;
  if (status.attachedTabs && status.attachedTabs.length) {
    $('detachAll').textContent = `停止调试(去掉黄条 · ${status.attachedTabs.length})`;
  } else {
    $('detachAll').textContent = '停止调试(去掉黄条)';
  }
}

async function refresh() {
  const r = await ask('status');
  if (r && r.ok) render(r.status);
  else $('err').textContent = (r && r.error) || '读取状态失败';
}

async function withBusy(btn, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

document.addEventListener('DOMContentLoaded', async () => {
  await refresh();

  $('pair').addEventListener('click', () => withBusy($('pair'), async () => {
    const r = await ask('pair', { serverBase: $('server').value.trim() || 'http://127.0.0.1:4000' });
    if (r && r.ok) render(r.status);
    else $('err').textContent = (r && r.error) || '配对失败';
  }));

  $('disconnect').addEventListener('click', () => withBusy($('disconnect'), async () => {
    const r = await ask('disconnect');
    if (r && r.ok) render(r.status);
    else $('err').textContent = (r && r.error) || '断开失败';
  }));

  $('paused').addEventListener('change', async () => {
    const r = await ask('setPaused', { paused: $('paused').checked });
    if (r && r.ok) render(r.status);
    else $('err').textContent = (r && r.error) || '切换失败';
  });

  $('detachAll').addEventListener('click', () => withBusy($('detachAll'), async () => {
    const r = await ask('detachAll');
    if (r && r.ok) render(r.status);
    else $('err').textContent = (r && r.error) || '操作失败';
  }));

  // popup 打开期间每 2s 刷新一次连接状态
  const timer = setInterval(refresh, 2000);
  window.addEventListener('unload', () => clearInterval(timer));
});
