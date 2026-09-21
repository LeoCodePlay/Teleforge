// chrome.debugger(CDP)薄封装:attach / detach / sendCommand + 已连接标签集合。
//
// 为什么走 debugger 而不是 chrome.scripting 注入:
//   1) 输入走 Input.dispatch* 属于「可信事件」,与真人操作等价,不会被站点当成合成事件拒绝;
//   2) 快照/截图/evaluate 与内置预览(Playwright 也走 CDP)语义完全一致,
//      服务端能把同一份 SNAPSHOT_SCRIPT 下发下来复用,两边给 AI 的文本逐字一致;
//   3) 代价是浏览器会在被 attach 的标签顶部显示「正在调试此浏览器」,这是强制的,无法隐藏。
const CDP_VERSION = '1.3';

/** 已被我们 attach 的标签(用于避免重复 attach 报错) */
const attached = new Set();

export function isAttached(tabId) {
  return attached.has(tabId);
}

export function attachedTabs() {
  return [...attached];
}

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  // service worker 被回收再唤醒后,本进程内的 attached 集合会丢失(而调试会话还在)。
  // 先用 getTargets 问浏览器:这个标签已经挂着调试器,就不要再 attach 一次。
  try {
    const targets = await chrome.debugger.getTargets();
    const t = targets.find((x) => x.tabId === tabId);
    if (t && t.attached) {
      attached.add(tabId);
      return;
    }
  } catch { /* getTargets 不可用时继续走正常 attach */ }
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/Another debugger|already attached/i.test(msg)) {
      throw new Error('该标签已被开发者工具或其他调试器占用:请先关闭它的 DevTools,再让 AI 重试');
    }
    if (/No tab with given id|Cannot access|not allowed/i.test(msg)) {
      throw new Error(`无法调试标签 ${tabId}:标签可能已关闭,或是 chrome:// 等受保护页面`);
    }
    throw new Error(`调试器连接失败:${msg}`);
  }
  attached.add(tabId);
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* 标签已关等情况忽略 */ }
}

export async function sendCommand(tabId, method, params = {}) {
  await attach(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/Detached|not attached|Target closed|No target/i.test(msg)) {
      attached.delete(tabId);
      throw new Error('调试会话已断开(标签被关闭,或被 DevTools 抢占了调试器),请重试');
    }
    throw new Error(`${method} 执行失败:${msg}`);
  }
}

// 用户主动关 DevTools、关标签时浏览器会 detach:同步集合,避免后续误判成「还连着」
chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) attached.delete(source.tabId);
});
