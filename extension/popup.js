// popup:连接状态、按端口/地址连接、多服务端列表。所有实际动作都交给 background.js。
const $ = (id) => document.getElementById(id);

async function ask(type, extra = {}) {
  try {
    return await chrome.runtime.sendMessage({ type, ...extra });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function kindLabel(kind) {
  if (kind === 'desktop') return ' · 桌面端';
  if (kind === 'web') return ' · 网页端';
  return '';
}

function stateOf(s) {
  if (s.connected) return '已连接';
  if (s.connecting) return '连接中…';
  return '未连接';
}

/** 一个服务端一行:状态点 + 地址(带桌面端/网页端标注) + 断开 */
function serverRow(s, onChange) {
  const wrap = document.createElement('div');

  const row = document.createElement('div');
  row.className = 'srv';

  const dot = document.createElement('span');
  dot.className = 'dot' + (s.connected ? ' on' : (s.connecting ? ' warn' : ''));

  const addr = document.createElement('span');
  addr.className = 'addr';
  addr.textContent = s.base.replace(/^https?:\/\//, '');
  const em = document.createElement('em');
  em.textContent = kindLabel(s.kind);
  if (em.textContent) addr.appendChild(em);
  addr.title = s.base;

  const st = document.createElement('span');
  st.className = 'st';
  st.textContent = stateOf(s);

  const btn = document.createElement('button');
  if (s.connected || s.connecting) {
    btn.textContent = '断开';
    btn.addEventListener('click', () => onChange('remove', { base: s.base }, btn));
  } else {
    btn.textContent = '重连';
    btn.addEventListener('click', () => onChange('reconnect', { base: s.base }, btn));
  }

  row.append(dot, addr, st, btn);
  wrap.appendChild(row);

  if (s.error && !s.connected) {
    const why = document.createElement('p');
    why.className = 'why';
    why.textContent = s.error;
    wrap.appendChild(why);
  }
  return wrap;
}

function render(status) {
  if (!status) return;
  const servers = status.servers || [];
  const online = status.online || 0;
  const connecting = servers.some((s) => s.connecting);
  $('dot').className = 'dot' + (online ? ' on' : (connecting ? ' warn' : ''));
  $('state').textContent = online
    ? `已连接 ${online} 个`
    : (servers.length ? (connecting ? '连接中…' : '未连接') : '未配对');
  $('ver').textContent = status.browser ? `${status.browser} · v${status.version}` : `v${status.version}`;
  $('paused').checked = status.paused === true;

  const list = $('list');
  list.textContent = '';
  if (!servers.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.style.margin = '2px 0 0';
    empty.textContent = '还没有连接任何服务端:点上面的「扫描全部」,或填端口后点「连接」。';
    list.appendChild(empty);
  } else {
    for (const s of servers) list.appendChild(serverRow(s, act));
  }

  if (status.attachedTabs && status.attachedTabs.length) {
    $('detachAll').textContent = `停止调试(去掉黄条 · ${status.attachedTabs.length})`;
  } else {
    $('detachAll').textContent = '停止调试(去掉黄条)';
  }
}

function showErr(msg) {
  $('err').textContent = msg || '';
}

async function refresh() {
  const r = await ask('status');
  if (r && r.ok) render(r.status);
  else showErr((r && r.error) || '读取状态失败');
}

async function withBusy(btn, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

/** 统一收口:任何动作回来都重新渲染,失败就落到错误行 */
async function act(type, extra, btn) {
  showErr('');
  const run = async () => {
    const r = await ask(type, extra);
    if (r && r.ok) {
      render(r.status);
      if (type === 'scan') {
        const n = (r.added || []).length;
        showErr(n ? `新连上 ${n} 个服务端` : `扫描完成,发现 ${(r.found || []).length} 个服务端(已在连接中)`);
        $('err').style.color = n ? '#22c55e' : '#7c828c';
      } else if (type === 'connect') {
        showErr(`已连接 ${String(r.base || '').replace(/^https?:\/\//, '')}`);
        $('err').style.color = '#22c55e';
      }
    } else {
      showErr((r && r.error) || '操作失败');
      $('err').style.color = '#f87171';
    }
    return r;
  };
  return btn ? withBusy(btn, run) : run();
}

document.addEventListener('DOMContentLoaded', async () => {
  await refresh();

  $('connect').addEventListener('click', () => act('connect', { serverBase: $('server').value.trim() }, $('connect'))
    .then((r) => { if (r && r.ok) $('server').value = ''; })
    .catch(() => {}));
  $('scan').addEventListener('click', () => act('scan', {}, $('scan')));
  $('disconnectAll').addEventListener('click', () => act('disconnectAll', {}, $('disconnectAll')));

  $('paused').addEventListener('change', async () => {
    const r = await ask('setPaused', { paused: $('paused').checked });
    if (r && r.ok) render(r.status);
    else showErr((r && r.error) || '切换失败');
  });

  $('detachAll').addEventListener('click', () => act('detachAll', {}, $('detachAll')));

  // 回车 = 直接连接(填完端口按一下就行)
  $('server').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('connect').click();
  });

  // popup 打开期间每 2s 刷新一次连接状态
  const timer = setInterval(refresh, 2000);
  window.addEventListener('unload', () => clearInterval(timer));
});
