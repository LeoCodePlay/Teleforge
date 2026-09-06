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

// Agent 常量:阈值与策略照搬 deepseek-harness(compaction-basic / tool-result-pruner /
// spill-policy / bash-local / tool-fs read / agent-loop / repeat-tool-reminder)。
export const AGENT = {
  HISTORY_BUDGET_CHARS: 180_000, // 窗口未配置时的兜底字符裁剪预算(harness 无此项;作为最后防线保留)
  // 环境快照/技能目录进入"运行时上下文"消息的字符预算(防大目录树撑爆历史)
  ENV_SNAPSHOT_MAX_CHARS: 6_000,
  // read 工具上限(照搬 harness tool-fs:READ_LIMIT / READ_MAX_LINE_LENGTH / READ_MAX_BYTES):
  // 行号窗口语义——offset/limit 按行,单行超长截断,选中行总字节超限即停并提示续读位置
  READ: {
    LIMIT: 2_000,          // 单次返回的最大行数(也是 limit 参数上限)
    MAX_LINE_LENGTH: 2_000,// 单行最大字符数,超出截断
    MAX_BYTES: 50 * 1024   // 选中行内容的总字节上限
  },
  // 命令输出上限(照搬 harness bash-local maxOutputBytes):单流 64,000 字节,保留尾部
  BASH_MAX_OUTPUT_BYTES: 64_000,
  // spill 策略(照搬 harness spill-policy maxInlineBytes):工具结果入历史前,
  // 纯文本超过该字节数即替换为头尾对半预览 + 完整内容落盘提示;read 工具豁免
  SPILL_MAX_BYTES: 50_000,
  // 历史工具结果折叠(照搬 harness compaction-tool-result-pruner 默认值):
  // 压缩水位触发时,把 surface 上所有超过 THRESHOLD_CHARS 的工具结果替换为头尾摘要。
  TOOL_RESULT_PRUNE: {
    THRESHOLD_CHARS: 8_192,
    HEAD_CHARS: 4_096,
    TAIL_CHARS: 1_024
  },
  CONCURRENT_TOOL_CALLS: true,  // 并行执行工具调用(agent-loop 的有界滚动池,设 false 回退串行)
  MAX_PARALLEL_TOOL_CALLS: 10,  // 并行工具调用并发上限(照搬 harness DEFAULT_MAX_PARALLEL_TOOL_CALLS)
  MAX_OVERFLOW_RECOVERIES: 1,   // 上下文爆窗时自动压缩后重试本步的最大次数(对齐 harness maxOverflowRetries)
  CHAT_ONLY_TTL_MS: 10 * 60 * 1000, // 工具降级纯对话的失效时间:超时后自动重试工具调用(避免网关临时故障把会话永久打成纯对话)
  REPEAT_REMIND_THRESHOLDS: [3, 5, 8], // 连续相同工具+参数调用达到该次数时注入提醒(repeat-tool-reminder)
  REPEAT_ARG_PREVIEW: 500       // 重复调用提醒里引用的参数预览上限(字符,对齐 harness)
};

export const WS_MAX_PAYLOAD = 32 * 1024 * 1024;