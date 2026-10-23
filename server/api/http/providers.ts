// 「我的 AI 模型提供商」配置文件操作插件(增删改查 + 代理拉取模型列表)
// 数据保存在 ai-providers.json(首次运行初始为空,由用户在界面自行添加)
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { aiProviders, type AiProvider } from '../../store/ai-providers-store.ts';
import { uiState } from '../../store/ui-state-store.ts';
import { IMAGE_QUALITIES, IMAGE_SIZE_OPTIONS } from '../../store/settings-store.ts';
import { imageProviders } from '../../store/image-providers-store.ts';
import { describeFetchError, outboundFetch } from '../../core/net.ts';
import { authHeaders, modelsEndpoint, normalizeProtocol, parseModelList } from '../../agent/llm.ts';

// modelConfig 白名单净化:每模型只保留 contextWindow/maxTokens(正数)与 multimodal/imageGen(布尔)
function sanitizeModelConfig(mc: unknown): Record<string, any> | null {
  if (!mc || typeof mc !== 'object' || Array.isArray(mc)) return null;
  const out: Record<string, any> = {};
  for (const [m, v] of Object.entries(mc as Record<string, any>)) {
    if (!m || !v || typeof v !== 'object') continue;
    const e: Record<string, any> = {};
    const win = Math.floor(Number(v.contextWindow));
    const max = Math.floor(Number(v.maxTokens));
    if (Number.isFinite(win) && win > 0) e.contextWindow = win;
    if (Number.isFinite(max) && max > 0) e.maxTokens = max;
    if (v.multimodal === true) e.multimodal = true;
    if (v.imageGen === true) e.imageGen = true;
    if (Object.keys(e).length > 0) out[m] = e;
  }
  return out;
}

export default async function registerProviders(app: FastifyInstance) {
  app.get('/api/providers', () => ({ userProviders: aiProviders.list() }));

  // 代理获取某端点的模型列表(浏览器直连外部 API 会被 CORS 拦截,故由服务端转发)
  // 端点与鉴权头按协议给出:OpenAI 兼容 GET {base}/models(Bearer)、
  // Anthropic GET {base}/v1/models(x-api-key)、Gemini GET {base}/v1beta/models(x-goog-api-key)。
  // 三者的 URL 拼接 / 鉴权头 / 列表解析口径与对话链路共用(见 agent/llm.ts),避免两处走偏。
  app.post('/api/providers/fetch-models', async (request: FastifyRequest, reply: FastifyReply) => {
    const baseUrl = String((request.body as any)?.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String((request.body as any)?.apiKey || '').trim();
    const protocol = normalizeProtocol((request.body as any)?.protocol);
    if (!/^https?:\/\//i.test(baseUrl)) return reply.code(400).send({ error: 'Base URL 需以 http:// 或 https:// 开头' });
    try {
      const r = await outboundFetch(modelsEndpoint(protocol, baseUrl), {
        headers: authHeaders(protocol, apiKey),
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) return reply.code(502).send({ error: `提供商返回 HTTP ${r.status},请检查 Base URL 与 API Key` });
      const j: any = await r.json();
      return { models: parseModelList(protocol, j) };
    } catch (e: any) {
      return reply.code(502).send({ error: '获取模型列表失败:' + describeFetchError(e) });
    }
  });

  app.post('/api/providers', (request: FastifyRequest, reply: FastifyReply) => {
    const b = (request.body as any) || {};
    const name = String(b.name || '').trim();
    const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '');
    if (!name) return reply.code(400).send({ error: '请填写提供商名称' });
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return reply.code(400).send({ error: 'Base URL 需以 http:// 或 https:// 开头' });
    const entry: AiProvider = {
      id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      baseUrl,
      // 协议(openai | anthropic | gemini):归一后落盘,未知值按 openai 处理
      protocol: normalizeProtocol(b.protocol),
      models: Array.isArray(b.models) ? b.models.map((m: any) => String(m)).filter(Boolean) : [],
      apiKey: String(b.apiKey || ''),
      // 多个 API Key(轮询用):apiKey 由 store 对齐为 apiKeys[0]
      ...(Array.isArray(b.apiKeys) ? { apiKeys: b.apiKeys.map((k: any) => String(k ?? '')).filter(Boolean) } : {}),
      note: '由用户添加'
    };
    const mc = sanitizeModelConfig(b.modelConfig);
    if (mc) entry.modelConfig = mc;
    aiProviders.add(entry);
    return { userProviders: aiProviders.list() };
  });

  // 更新某个提供商的字段(名称/地址/模型清单/API Key)
  app.patch('/api/providers/:id', (request: FastifyRequest, reply: FastifyReply) => {
    const b = (request.body as any) || {};
    const patch: Record<string, any> = {};
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
    if (typeof b.baseUrl === 'string') {
      const u = b.baseUrl.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(u)) return reply.code(400).send({ error: 'Base URL 需以 http:// 或 https:// 开头' });
      patch.baseUrl = u;
    }
    if (Array.isArray(b.models)) patch.models = b.models.map((m: any) => String(m)).filter(Boolean);
    if (b.protocol !== undefined) patch.protocol = normalizeProtocol(b.protocol);
    if (typeof b.apiKey === 'string') patch.apiKey = b.apiKey;
    // 多 Key 列表(权威):给了它就以它为准,apiKey 由 store 对齐为首项
    if (Array.isArray(b.apiKeys)) patch.apiKeys = b.apiKeys.map((k: any) => String(k ?? '').trim()).filter(Boolean);
    if (b.modelConfig !== undefined) patch.modelConfig = sanitizeModelConfig(b.modelConfig) || {};
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: '没有可更新的字段' });
    if (!aiProviders.update(String((request.params as any)?.id), patch)) return reply.code(404).send({ error: '提供商不存在' });
    return { userProviders: aiProviders.list() };
  });

  // 清除某 Key(或全部 Key)的「无余额」标记:充值后点「重置」,
  // 下次重试轮询该 Key 时会再次尝试它(否则余额不足的 Key 会被一直跳过)
  app.post('/api/providers/:id/reset-key', (request: FastifyRequest, reply: FastifyReply) => {
    const id = String((request.params as any)?.id || '');
    const key = String((request.body as any)?.key || '').trim();
    if (key) aiProviders.resetKey(id, key);
    else aiProviders.resetAllKeys(id); // 未指定 Key = 全部重置
    return { userProviders: aiProviders.list() };
  });

  app.delete('/api/providers/:id', (request: FastifyRequest, reply: FastifyReply) => {
    if (!aiProviders.remove(String((request.params as any)?.id))) return reply.code(404).send({ error: '提供商不存在' });
    uiState.remove(String((request.params as any)?.id)); // 联动清理该提供方的选择级状态
    return { userProviders: aiProviders.list() };
  });

  // ---- 「生图模型商」独立配置(generate_image 工具与生图端点的来源)----
  // 与对话提供商解耦:可以像 AI 配置那样添加多条图像端点,activeId 指向当前使用中的一条。
  // (imageGen 纯图像端点模型走的是 AI 提供商自己的端点配置,不吃这里。)
  const imageProvidersPayload = () => ({
    providers: imageProviders.list(),
    activeId: imageProviders.activeId()
  });

  app.get('/api/image-providers', () => ({
    ...imageProvidersPayload(),
    // 尺寸直接下发 {value,label}:标签是给人看的口径(1K 方图…),避免前端再抄一份枚举
    options: { qualities: IMAGE_QUALITIES, sizes: IMAGE_SIZE_OPTIONS }
  }));

  // 新增一条。默认切换为使用中(「保存并使用」);body.activate=false 用于复制这类不抢焦点的场景。
  app.post('/api/image-providers', (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const b = (request.body as any) || {};
      imageProviders.add(b, { activate: b.activate !== false });
      return imageProvidersPayload();
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.patch('/api/image-providers/:id', (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const updated = imageProviders.update(String((request.params as any)?.id || ''), (request.body as any) || {});
      if (!updated) return reply.code(404).send({ error: '生图模型商不存在' });
      return imageProvidersPayload();
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // 切换使用中(界面点卡片 / 点「使用」)
  app.post('/api/image-providers/:id/use', (request: FastifyRequest, reply: FastifyReply) => {
    if (!imageProviders.setActive(String((request.params as any)?.id || ''))) {
      return reply.code(404).send({ error: '生图模型商不存在' });
    }
    return imageProvidersPayload();
  });

  // 清除某 Key(或全部 Key)的不可用标记:充值 / 换好 Key 后点「重置」
  app.post('/api/image-providers/:id/reset-key', (request: FastifyRequest, reply: FastifyReply) => {
    const id = String((request.params as any)?.id || '');
    if (!imageProviders.find(id)) return reply.code(404).send({ error: '生图模型商不存在' });
    const key = String((request.body as any)?.key || '').trim();
    if (key) imageProviders.resetKey(id, key);
    else imageProviders.resetAllKeys(id); // 未指定 Key = 全部重置
    return imageProvidersPayload();
  });

  // 删除一条;若删的是使用中的那条,store 会自动落到第一条
  app.delete('/api/image-providers/:id', (request: FastifyRequest, reply: FastifyReply) => {
    if (!imageProviders.remove(String((request.params as any)?.id || ''))) {
      return reply.code(404).send({ error: '生图模型商不存在' });
    }
    return imageProvidersPayload();
  });

  // 用当前填写的端点做一次连通性自检(拉图像模型列表,顺带验证 key):生图端点没有 /models
  // 也能工作,所以这里失败只作提示、不阻断保存。
  app.post('/api/image-providers/test', async (request: FastifyRequest, reply: FastifyReply) => {
    const b = (request.body as any) || {};
    const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(b.apiKey || '').trim();
    if (!/^https?:\/\//i.test(baseUrl)) return reply.code(400).send({ error: 'Base URL 需以 http:// 或 https:// 开头' });
    try {
      const r = await outboundFetch(baseUrl + '/models', {
        headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) return reply.code(502).send({ error: `端点返回 HTTP ${r.status},请检查 Base URL 与 API Key` });
      const j: any = await r.json();
      const raw = Array.isArray(j?.data) ? j.data.map((m: any) => m?.id) : [];
      return { ok: true, models: [...new Set(raw.map((m: any) => String(m || '').trim()).filter(Boolean))].sort() };
    } catch (e: any) {
      return reply.code(502).send({ error: '连接失败:' + describeFetchError(e) });
    }
  });
}
