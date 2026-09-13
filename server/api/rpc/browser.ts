// 浏览器预览 RPC:打开 / 导航 / 前进后退 / 刷新 / 调整视口 / 关闭。
// 页面画面帧与鼠标键盘输入走独立的 /ws/browser 通道(见 core/ws.ts);
// 这里只处理控制类命令,避免高频输入占用 RPC 请求/应答通道。
import { browserManager } from '../../core/browser-manager.ts';
import { resolvePreviewUrl } from '../../core/port-tunnel.ts';
import type { RpcModule } from './router.ts';

export function registerBrowser(rpc: RpcModule) {
  rpc.register('browser_list', async (_msg, { reply }) => {
    reply({ type: 'browser_list', sessions: browserManager.list() });
  });

  rpc.register('browser_open', async (msg, { reply }) => {
    const tunnel = msg.tunnel === true ? true : msg.tunnel === false ? false : undefined;
    const target = await resolvePreviewUrl(msg.url, { tunnel });
    const state = await browserManager.open({
      id: msg.id || 'main',
      url: target.url,
      width: msg.width,
      height: msg.height
    });
    reply({
      type: 'browser_opened', ...state,
      direct: target.direct, tunneled: target.tunneled, note: target.note || null
    });
  });

  rpc.register('browser_navigate', async (msg, { reply }) => {
    const target = await resolvePreviewUrl(msg.url, { tunnel: msg.tunnel === undefined ? undefined : !!msg.tunnel });
    const state = await browserManager.navigate(msg.id || 'main', target.url);
    reply({ type: 'browser_state', ...state, direct: target.direct, tunneled: target.tunneled, note: target.note || null });
  });

  rpc.register('browser_back', async (msg, { reply }) => {
    reply({ type: 'browser_state', ...(await browserManager.goBack(msg.id || 'main')) });
  });

  rpc.register('browser_forward', async (msg, { reply }) => {
    reply({ type: 'browser_state', ...(await browserManager.goForward(msg.id || 'main')) });
  });

  rpc.register('browser_reload', async (msg, { reply }) => {
    reply({ type: 'browser_state', ...(await browserManager.reload(msg.id || 'main')) });
  });

  rpc.register('browser_resize', async (msg, { reply }) => {
    reply({ type: 'browser_state', ...(await browserManager.resize(msg.id || 'main', { width: msg.width, height: msg.height })) });
  });

  rpc.register('browser_info', async (msg, { reply }) => {
    reply({ type: 'browser_state', ...(browserManager.state(msg.id || 'main') || { id: msg.id || 'main', closed: true }) });
  });

  // 读取远程页面选中的文字:预览是图像,「复制」必须回远程页面取文本
  rpc.register('browser_selection', async (msg, { reply }) => {
    const { text } = await browserManager.selection(msg.id || 'main');
    reply({ type: 'browser_selection', id: msg.id || 'main', text });
  });

  rpc.register('browser_close', async (msg, { reply }) => {
    await browserManager.close(msg.id || 'main');
    reply({ type: 'browser_closed', id: msg.id || 'main' });
  });

  rpc.register('browser_close_all', async (_msg, { reply }) => {
    await browserManager.closeAll();
    reply({ type: 'browser_closed', id: '*' });
  });
}
