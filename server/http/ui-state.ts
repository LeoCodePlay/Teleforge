// 「LLM 选择级配置」接口插件:当前选中提供方 / 各提供方模型 / Key / 自定义模型名 / 迭代上限
// 数据保存在 server/data/ui-state.json(与 ai-providers.json 同级)
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { uiState } from '../ui-state-store.ts';

export default async function registerUiState(app: FastifyInstance) {
  app.get('/api/ui-state', () => ({ uiState: uiState.get() }));

  app.patch('/api/ui-state', (request: FastifyRequest) => {
    const b = (request.body as any) || {};
    uiState.patch({
      providerId: typeof b.providerId === 'string' ? b.providerId : undefined,
      customModel: typeof b.customModel === 'string' ? b.customModel : undefined,
      models: b.models,
      keys: b.keys,
      maxIters: b.maxIters
    });
    return { uiState: uiState.get() };
  });
}
