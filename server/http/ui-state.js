// 「LLM 选择级配置」接口插件:当前选中提供方 / 各提供方模型 / Key / 自定义模型名 / 迭代上限
// 数据保存在 server/data/ui-state.json(与 ai-providers.json 同级)
import { uiState } from '../ui-state-store.js';

export default async function registerUiState(app) {
  app.get('/api/ui-state', () => ({ uiState: uiState.get() }));

  app.patch('/api/ui-state', (request) => {
    const b = request.body || {};
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
