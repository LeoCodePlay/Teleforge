// 浏览器扩展配对接口:给扩展 popup 一次性取回配对 token 与 WS 地址。
//
// 为什么单独走 HTTP 而不是复用 RPC 通道:现有 /ws 通道完全没有鉴权,
// 而 WebSocket 不受同源策略限制 —— 任意本机网页都能连上并读走消息。
// token 是"谁能接管浏览器"的唯一凭证,绝不能放在那条通道上。
//
// 这里的安全性由三点共同保证:
//   1) 服务默认只监听 127.0.0.1(config.ts 的 HOST);
//   2) 响应不带任何 CORS 头 —— 网页 fetch 即使发出请求也读不到响应体;
//   3) 要求自定义请求头 X-Bridge-Pair: 1 —— 网页发自定义头会触发预检,
//      而本服务不处理 OPTIONS,预检失败后真实请求根本不会发出。
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { browserBridge } from '../../core/browser-bridge.ts';
import { PORT } from '../../config.ts';

export default async function registerBrowserBridgeHttp(app: FastifyInstance) {
  // 扩展 popup 点「连接」时调用:拿 token + WS 地址,然后建立 /ws/ext 长连接
  app.get('/api/browser-bridge/pair', (request: FastifyRequest, reply: FastifyReply) => {
    if (String(request.headers['x-bridge-pair'] || '') !== '1') {
      return reply.code(403).send({ error: '缺少 X-Bridge-Pair 请求头' });
    }
    const host = String(request.headers.host || `127.0.0.1:${PORT}`);
    const port = host.includes(':') ? host.slice(host.lastIndexOf(':') + 1) : String(PORT);
    return reply.send({
      token: browserBridge.token(),
      wsUrl: `ws://127.0.0.1:${port}/ws/ext`,
      status: browserBridge.status()
    });
  });

  // 「撤销已配对的浏览器」:换一份新 token,旧扩展立即掉线
  app.post('/api/browser-bridge/reset', (request: FastifyRequest, reply: FastifyReply) => {
    if (String(request.headers['x-bridge-pair'] || '') !== '1') {
      return reply.code(403).send({ error: '缺少 X-Bridge-Pair 请求头' });
    }
    return reply.send({ token: browserBridge.resetToken() });
  });
}
