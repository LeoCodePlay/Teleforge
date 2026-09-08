// 全局配置与常量
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 数据目录:会话/配置/附件等全部持久化落盘位置。
// - 桌面端:由 Tauri 外壳注入 App 数据目录(DATA_DIR 环境变量)
// - 独立部署/测试:用环境变量覆盖
export const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data'); // 项目根 data/

// 兼容迁移:旧版本把部分配置(ai-providers/ssh-profiles/ui-state/attachments/prompt-inject 等)
// 落在 server/data/,统一到 DATA_DIR 后首次启动把缺失文件拷过去,避免已有配置丢失(仅默认路径生效)
if (!process.env.DATA_DIR) {
  try {
    const legacyDir = path.resolve(__dirname, 'data'); // server/data
    if (fs.existsSync(legacyDir) && legacyDir !== DATA_DIR) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      for (const name of fs.readdirSync(legacyDir)) {
        const src = path.join(legacyDir, name);
        const dst = path.join(DATA_DIR, name);
        if (!fs.existsSync(dst)) {
          try { fs.cpSync(src, dst, { recursive: true }); } catch { /* 单个失败不阻塞 */ }
        }
      }
    }
  } catch { /* 迁移失败不影响启动 */ }
}

// 各持久化文件/目录的统一默认路径(均保留原有环境变量覆盖)
export const UI_STATE_FILE      = process.env.UI_STATE_FILE      || path.join(DATA_DIR, 'ui-state.json');
export const SSH_PROFILES_FILE  = process.env.SSH_PROFILES_FILE  || path.join(DATA_DIR, 'ssh-profiles.json');
export const AI_PROVIDERS_FILE  = process.env.AI_PROVIDERS_FILE  || path.join(DATA_DIR, 'ai-providers.json');
export const ATTACHMENTS_DIR    = process.env.ATTACHMENTS_DIR    || path.join(DATA_DIR, 'attachments');
export const AGENT_TOOLS_FILE   = process.env.AGENT_TOOLS_FILE   || path.join(DATA_DIR, 'agent-tools.json');
export const PROMPT_INJECT_FILE = process.env.PROMPT_INJECT_FILE || path.join(DATA_DIR, 'prompt-inject.md');
export const CHAT_HISTORY_FILE  = path.join(DATA_DIR, 'chat-history.json');
export const SESSIONS_FILE      = path.join(DATA_DIR, 'sessions.json');
export const SESSIONS_DIR       = path.join(DATA_DIR, 'sessions');
export const SETTINGS_FILE      = path.join(DATA_DIR, 'settings.json');

export const PORT = Number(process.env.PORT || 4000);
export const HOST = process.env.HOST || '127.0.0.1'; // 默认仅本机访问,避免暴露 ✓

// 「不在工作区对话」哨兵值:作为会话绑定值(SessionMeta.workspace / localWorkspace)与
// set_workspace / set_local_workspace 的 path 传入,表示该侧不绑定任何目录,
// 文件边界放宽到整台机器:本机 = 所有盘符(POSIX 为根目录 /),远程 = 整个远程文件系统。
// 与 null(未绑定/旧数据,回落连接级工作区)严格区分,因此不能用空串代替。
export const NO_WORKSPACE = 'no-workspace';

/** 该绑定值是否表示「不在工作区对话」(全盘模式) */
export function isNoWorkspace(v: unknown): boolean {
  return v === NO_WORKSPACE;
}

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
  // ABS_FLOOR_TOKENS:绝对地板——声明窗口虚高(前端兜底 1M)或未配置时,80% 水位永不
  // 触发,长会话会无治理增长(实测一次分析任务冲到 100k token);地板保证预估请求
  // (历史 + system + 工具 schema)超过该值就先做一轮"保最近"的折叠。设 0 关闭。
  // 地板路径独立阈值:水位路径按 harness 8192 保守折叠;地板路径目的是主动压体积,
  // 用更低阈值(2k)把旧的中等结果(一次 read 30k 默认即 30k 字符)也折叠掉。
  TOOL_RESULT_PRUNE: {
    THRESHOLD_CHARS: 8_192,
    HEAD_CHARS: 4_096,
    TAIL_CHARS: 1_024,
    ABS_FLOOR_TOKENS: 60_000,
    ABS_FLOOR_THRESHOLD_CHARS: 2_000,
    ABS_FLOOR_KEEP_RECENT: 6
  },
  CONCURRENT_TOOL_CALLS: true,  // 并行执行工具调用(agent-loop 的有界滚动池,设 false 回退串行)
  MAX_PARALLEL_TOOL_CALLS: 10,  // 并行工具调用并发上限(照搬 harness DEFAULT_MAX_PARALLEL_TOOL_CALLS)
  MAX_OVERFLOW_RECOVERIES: 1,   // 上下文爆窗时自动压缩后重试本步的最大次数(对齐 harness maxOverflowRetries)
  CHAT_ONLY_TTL_MS: 10 * 60 * 1000, // 工具降级纯对话的失效时间:超时后自动重试工具调用(避免网关临时故障把会话永久打成纯对话)
  REPEAT_REMIND_THRESHOLDS: [3, 5, 8], // 连续相同工具+参数调用达到该次数时注入提醒(repeat-tool-reminder)
  REPEAT_ARG_PREVIEW: 500       // 重复调用提醒里引用的参数预览上限(字符,对齐 harness)
};

export const WS_MAX_PAYLOAD = 32 * 1024 * 1024;