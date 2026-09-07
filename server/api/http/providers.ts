// 「我的 AI 模型提供商」配置文件操作插件(增删改查 + 代理拉取模型列表)
// 数据保存在 server/data/ai-providers.json(首次启动自动从 openclaw 导入种子)
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { aiProviders, type AiProvider } from '../../store/ai-providers-store.ts';
import { uiState } from '../../store/ui-state-store.ts';

// modelConfig 白名单净化:每模型只保留 contextWindow/maxTokens(正数)与 multimodal(布尔)
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
    if (Object.keys(e).length > 0) out[m] = e;
  }
  return out;
}

export default async function registerProviders(app: FastifyInstance) {
  app.get('/api/providers', () => ({ userProviders: aiProviders.list() }));

  // 代理获取某端点的模型列表(浏览器直连外部 API 会被 CORS 拦截,故由服务端转发)
  // OpenAI 兼容端点均为 GET {baseUrl}/models → { data: [{ id }] }
  app.post('/api/providers/fetch-models', async (request: FastifyRequest, reply: FastifyReply) => {
    const baseUrl = String((request.body as any)?.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String((request.body as any)?.apiKey || '').trim();
    if (!/^https?:\/\//i.test(baseUrl)) return reply.code(400).send({ error: 'Base URL 需以 http:// 或 https:// 开头' });
    try {
      const r = await fetch(baseUrl + '/models', {
        headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) return reply.code(502).send({ error: `提供商返回 HTTP ${r.status},请检查 Base URL 与 API Key` });
      const j: any = await r.json();
      const raw = Array.isArray(j?.data) ? j.data.map((m: any) => m?.id)
        : Array.isArray(j?.models) ? j.models.map((m: any) => m?.id ?? m)
        : [];
      const models = [...new Set(raw.map((m: any) => String(m || '').trim()).filter(Boolean))].sort();
      return { models };
    } catch (e: any) {
      return reply.code(502).send({ error: '获取模型列表失败:' + e.message });
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
      models: Array.isArray(b.models) ? b.models.map((m: any) => String(m)).filter(Boolean) : [],
      apiKey: String(b.apiKey || ''),
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
    if (typeof b.apiKey === 'string') patch.apiKey = b.apiKey;
    if (b.modelConfig !== undefined) patch.modelConfig = sanitizeModelConfig(b.modelConfig) || {};
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: '没有可更新的字段' });
    if (!aiProviders.update(String((request.params as any)?.id), patch)) return reply.code(404).send({ error: '提供商不存在' });
    return { userProviders: aiProviders.list() };
  });

  app.delete('/api/providers/:id', (request: FastifyRequest, reply: FastifyReply) => {
    if (!aiProviders.remove(String((request.params as any)?.id))) return reply.code(404).send({ error: '提供商不存在' });
    uiState.remove(String((request.params as any)?.id)); // 联动清理该提供方的选择级状态
    return { userProviders: aiProviders.list() };
  });
}
