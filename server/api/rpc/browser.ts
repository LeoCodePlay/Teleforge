// 浏览器预览 RPC:打开 / 导航 / 前进后退 / 刷新 / 调整视口 / 关闭。
// 页面画面帧与鼠标键盘输入走独立的 /ws/browser 通道(见 core/ws.ts);
// 这里只处理控制类命令,避免高频输入占用 RPC 请求/应答通道。
//
// 归属:前端每个预览标签都对应一个会话(id 形如 s_xxx:1),请求里的 sid = 用户当前所在会话。
// 内核按 id 里编入的归属 + 请求 sid 双重校验,非归属会话的请求一律拒绝(见 core/browser-manager.ts)。
import { browserManager } from '../../core/browser-manager.ts';
import { resolvePreviewUrl } from '../../core/port-tunnel.ts';
import { nativeAvailable, nativeOpsFor } from '../../agent/browser-backends.ts';
import type { RpcModule } from './router.ts';

export function registerBrowser(rpc: RpcModule) {
  rpc.register('browser_list', async (_msg, { reply }) => {
    reply({ type: 'browser_list', sessions: browserManager.list() });
  });

  rpc.register('browser_open', async (msg, { reply }) => {
    const tunnel = msg.tunnel === true ? true : msg.tunnel === false ? false : undefined;
    let target;
    try {
      target = await resolvePreviewUrl(msg.url, { tunnel });
    } catch (e: any) {
      // 地址解析阶段就能确定失败(例如远程与本机都没监听该端口):回一句可操作的说明,
      // 让面板直接显示原因,而不是让浏览器去撞一个空响应(ERR_EMPTY_RESPONSE 那种黑箱错误)。
      reply({ type: 'browser_opened', id: msg.id || 'main', url: String(msg.url || ''), title: '', loading: false, error: e?.message || String(e) });
      return;
    }
    const state = await browserManager.open({
      id: msg.id || 'main',
      url: target.url,
      width: msg.width,
      height: msg.height,
      ownerSid: msg.sid || null
    });
    reply({
      type: 'browser_opened', ...state,
      direct: target.direct, tunneled: target.tunneled, note: target.note || null
    });
  });

  // 前端点链接 / 工具卡「在真实浏览器打开」:扩展在线时丢给真机浏览器,而不是内置预览。
  //
  // 为什么不能只走 browser_open:内置预览是 Playwright headless,带登录态的站点
  // (x.com 这类有前置风控的)会直接 403 —— 用户点消息里的 x.com 链接永远打不开。
  // 只有真机浏览器能带上用户自己的 cookie。扩展不在线时回 ok:false,由前端回落预览标签。
  rpc.register('browser_open_native', async (msg, { reply }) => {
    const raw = String(msg.url || '');
    if (!nativeAvailable()) {
      reply({ type: 'browser_opened_native', ok: false, reason: 'offline', url: raw });
      return;
    }
    // 先过隧道解析:远程项目里的 localhost 地址要映射成本机可达的隧道地址,
    // 真机浏览器才连得上;公网地址原样返回,不受影响。
    let target = raw;
    try {
      target = (await resolvePreviewUrl(raw, {})).url;
    } catch (e: any) {
      reply({ type: 'browser_opened_native', ok: false, reason: e?.message || String(e), url: raw });
      return;
    }
    try {
      const state = await nativeOpsFor(null).openUrl(target);
      reply({ type: 'browser_opened_native', ok: true, url: state.url, title: state.title });
    } catch (e: any) {
      reply({ type: 'browser_opened_native', ok: false, reason: e?.message || String(e), url: target });
    }
  });

  rpc.register('browser_navigate', async (msg, { reply }) => {
    let target;
    try {
      target = await resolvePreviewUrl(msg.url, { tunnel: msg.tunnel === undefined ? undefined : !!msg.tunnel });
    } catch (e: any) {
      reply({ type: 'browser_state', id: msg.id || 'main', url: String(msg.url || ''), title: '', loading: false, error: e?.message || String(e) });
      return;
    }
    const state = await browserManager.navigate(msg.id || 'main', target.url, msg.sid);
    reply({ type: 'browser_state', ...state, direct: target.direct, tunneled: target.tunneled, note: target.note || null });
  });

  rpc.register('browser_back', async (msg, { reply }) => {
    reply({ type: 'browser_state', ...(await browserManager.goBack(msg.id || 'main', msg.sid)) });
  });

  rpc.register('browser_forward', async (msg, { reply }) => {
    reply({ type: 'browser_state', ...(await browserManager.goForward(msg.id || 'main', msg.sid)) });
  });

  rpc.register('browser_reload', async (msg, { reply }) => {
    reply({ type: 'browser_state', ...(await browserManager.reload(msg.id || 'main', msg.sid)) });
  });

  rpc.register('browser_resize', async (msg, { reply }) => {
    reply({ type: 'browser_state', ...(await browserManager.resize(msg.id || 'main', { width: msg.width, height: msg.height })) });
  });

  rpc.register('browser_info', async (msg, { reply }) => {
    reply({ type: 'browser_state', ...(browserManager.state(msg.id || 'main') || { id: msg.id || 'main', closed: true }) });
  });

  // 读取远程页面选中的文字:预览是图像,「复制」必须回远程页面取文本
  rpc.register('browser_selection', async (msg, { reply }) => {
    const { text } = await browserManager.selection(msg.id || 'main', msg.sid);
    reply({ type: 'browser_selection', id: msg.id || 'main', text });
  });

  rpc.register('browser_close', async (msg, { reply }) => {
    await browserManager.close(msg.id || 'main', msg.sid);
    reply({ type: 'browser_closed', id: msg.id || 'main' });
  });

  rpc.register('browser_close_all', async (_msg, { reply }) => {
    await browserManager.closeAll();
    reply({ type: 'browser_closed', id: '*' });
  });
}
