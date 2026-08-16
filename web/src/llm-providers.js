// 预置 LLM 提供商清单(OpenAI 兼容端点)
// 说明:模型名随官方更新,这里列各提供商当前代表性模型;均可通过「自定义模型」手动输入最新名称
// 本地服务(ollama/vllm/lmstudio)需要先在本机/局域网启动对应服务

export const PROVIDERS = [
  {
    id: 'mock',
    name: '本地联调 · mock(免 Key)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: [],
    mock: true,
    note: '离线联调模式,可跑通完整 Agent 工具流程,无需任何 API Key'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 深度求索',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    note: 'deepseek-chat 为通用对话(V3.x),deepseek-reasoner 为推理模型(R1)'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o4-mini'],
    note: '国际区账号;o3/o4-mini 为推理模型,需较新 Key'
  },
  {
    id: 'moonshot',
    name: 'Moonshot · Kimi(月之暗面)',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0711-preview', 'kimi-k2-turbo-preview', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    note: 'K2 系列为 2025 年新模型;v1 系列需对应上下文长度'
  },
  {
    id: 'zhipu',
    name: '智谱 AI · GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5', 'glm-4.5-air', 'glm-4-plus', 'glm-4-flash', 'glm-4-long'],
    note: 'glm-4-flash 有免费额度'
  },
  {
    id: 'aliyun',
    name: '阿里云 · 通义千问(Qwen)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-max', 'qwen-plus', 'qwen-turbo', 'qwen3-coder-plus', 'qwen-long'],
    note: '兼容模式端点;qwen3-coder-plus 适合编程'
  },
  {
    id: 'volcengine',
    name: '火山引擎 · 豆包(Doubao)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-seed-1-6-flash-250615', 'doubao-1-5-pro-32k-250115'],
    note: '也可使用控制台创建的推理接入点 ID(ep-xxx)作为模型名'
  },
  {
    id: 'baidu',
    name: '百度 · 千帆(ERNIE)',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    models: ['ernie-4.5-turbo-250430', 'ernie-4.5-8k-250430', 'ernie-3.5-8k-0205'],
    note: 'v2 兼容 OpenAI 协议;Key 在千帆控制台申请'
  },
  {
    id: 'tencent',
    name: '腾讯云 · 混元(Hunyuan)',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-turbos-latest', 'hunyuan-turbo-latest', 'hunyuan-large'],
    note: 'turbos 为 2025 年新版'
  },
  {
    id: 'siliconflow',
    name: '硅基流动 · SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat'],
    note: '聚合多家开源模型,模型名为 组织/模型 格式'
  },
  {
    id: 'lingyi',
    name: '零一万物 · Yi',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    models: ['yi-lightning'],
    note: ''
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 · Step',
    baseUrl: 'https://api.stepfun.com/v1',
    models: ['step-2-16k', 'step-2-mini', 'step-1-8k'],
    note: ''
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    models: ['MiniMax-Text-01', 'abab6.5s-chat'],
    note: ''
  },
  {
    id: 'xai',
    name: 'xAI · Grok',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-3', 'grok-3-mini'],
    note: ''
  },
  {
    id: 'groq',
    name: 'Groq(极速推理)',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    note: '开源模型托管,速度快'
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest'],
    note: ''
  },
  {
    id: 'openrouter',
    name: 'OpenRouter(多模型聚合)',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [],
    note: '模型名如 deepseek/deepseek-chat-v3.1 或 gpt-4o,可在 openrouter.ai/models 查看'
  },
  {
    id: 'ollama',
    name: 'Ollama(本地)',
    baseUrl: 'http://localhost:11434/v1',
    models: [],
    note: '需本机已 ollama pull 对应模型,如 qwen2.5 / llama3.1'
  },
  {
    id: 'vllm',
    name: 'vLLM(本地)',
    baseUrl: 'http://localhost:8000/v1',
    models: [],
    note: '需本地已启动 vLLM OpenAI 兼容服务'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio(本地)',
    baseUrl: 'http://localhost:1234/v1',
    models: [],
    note: '需在 LM Studio 中加载模型并开启本地服务'
  }
];

// 用户自行添加的提供商存于 localStorage(ConnectPanel 管理):
// {id, name, baseUrl, models[], apiKey, note}

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

export const DEFAULT_PROVIDER = 'deepseek';
