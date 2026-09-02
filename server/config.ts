// @ts-nocheck
// 全局配置与常量
export const PORT = Number(process.env.PORT || 4000);
export const HOST = process.env.HOST || '127.0.0.1'; // 默认仅本机访问,避免暴露 ✓

export const SSH = {
  KEEPALIVE_INTERVAL: 10000,   // 10s 心跳,保持连接
  KEEPALIVE_COUNT_MAX: 3,      // 连续丢 3 次心跳判定断开
  READY_TIMEOUT: 20000,
  RECONNECT_BASE_MS: 2000,     // 自动重连退避
  RECONNECT_MAX_MS: 30000
};

export const EXEC = {
  DEFAULT_TIMEOUT_MS: 300_000,
  MAX_TIMEOUT_MS: 600_000,
  MAX_OUTPUT_CHARS: 100_000,   // 截断策略:前 60k + 后 40k
  HEAD_OUTPUT_CHARS: 60_000
};

export const LOCAL_EXEC = {
  DEFAULT_TIMEOUT_MS: 300_000,
  MAX_TIMEOUT_MS: 600_000,
  MAX_OUTPUT_CHARS: 100_000
};

export const FILE = {
  READ_MAX_BYTES: 100_000,     // UI 查看器单次读取上限
  AGENT_READ_MAX_BYTES: 30_000,// agent 工具默认读取上限
  WRITE_MAX_BYTES: 2 * 1024 * 1024,
  DISCARD_BYTES: 8192          // 二进制探测采样长度
};

export const AGENT = {
  MAX_ITERS: 500,              // 单轮对话最大工具迭代次数(全局默认;前端不再单独编辑覆盖)
  TOOL_RESULT_MAX_CHARS: 60_000,
  HISTORY_BUDGET_CHARS: 180_000,
  CONCURRENT_TOOL_CALLS: false, // 串行执行,便于观察
  // 自动续推(移植自 deepseek-harness 的 goal-round-driver + tool-goal authority):
  GOAL_BLOCKED_AFTER: 3,       // 连续"模型宣称完成但任务计划仍有未完成项"达到该次数即停止续推,防死循环
  GOAL_ROUND_MAX: 64,          // 单轮内自动续推次数硬上限(防失控,超限按 max-iters 结束)
  CONTINUE_TRUNCATED: true,    // 模型输出因 max_tokens 被截断时自动注入续推消息继续,而非误判为完成
  CHAT_ONLY_TTL_MS: 10 * 60 * 1000, // 工具降级纯对话的失效时间:超时后自动重试工具调用(避免网关临时故障把会话永久打成纯对话)
  REPEAT_REMIND_THRESHOLDS: [3, 5, 8], // 连续相同工具+参数调用达到该次数时注入提醒(移植 harness repeat-tool-reminder)
  REPEAT_ARG_PREVIEW: 200      // 重复调用提醒里引用的参数预览上限(字符),防超大参数膨胀
};

export const WS_MAX_PAYLOAD = 32 * 1024 * 1024;