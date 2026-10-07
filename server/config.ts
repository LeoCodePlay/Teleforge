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
// 「生图」成图在工作区根目录下的专用存放目录名(见 agent/image-gen.ts):
// 远程工作区优先,其次本地工作区;两者都没选时成图只留在会话附件里。
export const GENERATED_IMAGES_DIRNAME = 'generated-images';
export const AGENT_TOOLS_FILE   = process.env.AGENT_TOOLS_FILE   || path.join(DATA_DIR, 'agent-tools.json');
export const PROMPT_INJECT_FILE = process.env.PROMPT_INJECT_FILE || path.join(DATA_DIR, 'prompt-inject.md');
export const CHAT_HISTORY_FILE  = path.join(DATA_DIR, 'chat-history.json');
export const SESSIONS_FILE      = path.join(DATA_DIR, 'sessions.json');
export const SESSIONS_DIR       = path.join(DATA_DIR, 'sessions');
// 子代理运行记录(每次派发一个文件;面板按会话列出并回看其完整对话)
export const SUBAGENTS_DIR      = path.join(DATA_DIR, 'subagents');
export const SETTINGS_FILE      = path.join(DATA_DIR, 'settings.json');
// 自动化任务(定时把一句话投递进某个会话):任务表 + 运行记录,见 server/schedule/
export const SCHEDULES_FILE     = process.env.SCHEDULES_FILE     || path.join(DATA_DIR, 'schedules.json');
// 「上次是用户主动退出」的标记文件(见 store/clean-quit.ts):用来区分"进程崩了该自动接着做"
// 与"用户自己关了软件,下次打开只是看看,不该擅自继续"。
export const QUIT_FLAG_FILE     = process.env.QUIT_FLAG_FILE     || path.join(DATA_DIR, 'clean-quit.flag');

export const PORT = Number(process.env.PORT || 4000);
export const HOST = process.env.HOST || '127.0.0.1'; // 默认仅本机访问,避免暴露 ✓

// 是否跑在桌面端外壳里(由 src-tauri/src/backend.rs 注入 TELEFORGE_SHELL=desktop)。
// 只用来让浏览器扩展在服务端列表里标出「桌面端 / 网页端」,不影响任何连接行为。
export const IS_DESKTOP_SHELL = process.env.TELEFORGE_SHELL === 'desktop';

// 「不使用工作区」哨兵值:作为会话绑定值(SessionMeta.workspace / localWorkspace)与
// set_workspace / set_local_workspace 的 path 传入,表示该侧不绑定任何目录,
// 文件边界放宽到整台机器:本机 = 所有盘符(POSIX 为根目录 /),远程 = 整个远程文件系统。
// 与 null(未绑定/旧数据,回落连接级工作区)严格区分,因此不能用空串代替。
export const NO_WORKSPACE = 'no-workspace';

/** 该绑定值是否表示「不使用工作区」(全盘模式) */
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
  // 把超过 THRESHOLD_CHARS 的工具结果替换为头尾摘要,由 compactHistory 在窗口水位/爆窗
  // 合格后执行(不在每次请求里独立触发)。
  // 判定**只取决于消息内容**(pruneToolResults 是纯函数、没有"保留最近 N 条"的滑动窗口),
  // 所以模型可见面只能向后追加:提供方前缀缓存不会因为每请求重算折叠而中途失效。
  // 历史教训:曾有一遍"绝对地板"(预估请求 > 60k token 就按 保留 4 条 / 16k 字符 折叠一次),
  // 其折叠点是滑动窗口的函数,窗口每前进一格就改写一条历史中段消息,把该点之后的整段前缀
  // 缓存作废(实测单次 20k~300k token,长会话命中率被拖到 96~98%)。已删除。
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
  REPEAT_ARG_PREVIEW: 500,      // 重复调用提醒里引用的参数预览上限(字符,对齐 harness)
  // 子代理(subagent 工具,in-process 只读调研代理;见 agent/subagent.ts):
  SUBAGENT: {
    // 不设步数上限、也不设时长上限:子代理跑到模型自己收尾为止(只受父轮停止约束),
    // 长调研不会被硬截断成"达到上限后收敛"的半成品结论。
    RESULT_MAX_CHARS: 12_000,   // 回传父级的结论上限;超出截断(完整过程只存在于子代理自己的会话)
    // 结算通知上限:常驻子代理一轮跑完(Activation 空闲)时投递给父会话的那条消息
    // (harness 的 settlement notice 承担"不阻塞也能把结果带回来"),同样要防超长撑爆上下文
    NOTICE_MAX_CHARS: 6_000,
    // 工具级超时:0 = **不设超时**。子代理是"派发—等结果"的长任务,固定时限只会把长调研
    // 掐成半成品结论;需要提前结束时统一由父轮停止(AbortSignal)中止(见 registry.runWithTimeout)。
    TIMEOUT_MS: 0,
    // 提示词契约:父对话必须自己写清任务与边界;prompt 与 objective+scope 两条路径满足其一
    MIN_PROMPT_CHARS: 60,       // 只给 prompt 时,完整提示词的最小长度
    MIN_FIELD_CHARS: 6,         // 给结构化字段时,objective / scope 各自的最小长度
    // 面板:运行记录保留条数上限(超出按开始时间删最旧;见 store/subagent-store.ts)
    MAX_RUNS: 200
  }
};

export const WS_MAX_PAYLOAD = 32 * 1024 * 1024;