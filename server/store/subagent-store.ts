// 子代理运行记录:每次派发一个 JSON 文件(data/subagents/<runId>.json),落盘用原子写。
//
// 为什么单独存、而不是写进父会话的事件日志:
//   - 子代理是**独立会话**(不共享父对话历史、过程不回传父上下文),它的事件不属于父会话的
//     事件溯源序列;塞进父日志会改变 projectEvents / messageFaceIndexes 的"消息面下标一一对应"
//     不变量(回退、分支、删除全靠它),风险与收益不成比例。
//   - 面板要的是"这次派发干了什么":列表(轻)+ 详情(完整对话)。列表只读索引字段,详情按需读文件。
//
// 保留策略:最多 SUBAGENT.MAX_RUNS 条,超出按 startedAt 删最旧(含文件),避免无限增长。
// 内存缓存:进程内缓存已加载的运行记录,列表走缓存;文件是唯一真相(重启后仍可回看)。
import fs from 'node:fs';
import path from 'node:path';
import { SUBAGENTS_DIR, AGENT } from '../config.ts';
import { writeFileAtomic } from './atomic-write.ts';

// running = 正在跑某一轮;idle = 常驻但当前没在跑(等后续消息,可续聊/可暂停后继续);
// done/error/stopped = 一次性派发的终局(后台常驻子代理不会进这三个,它一直可继续)
export type SubagentStatus = 'running' | 'idle' | 'done' | 'error' | 'stopped';

/** 派发方式:one-shot = 前台等结果的一次性;continuable = 常驻后台、可续聊(默认) */
export type SubagentMode = 'one-shot' | 'continuable';

/** 子代理内部的一条对话消息(user=下发的提示词/后续消息,assistant=模型产出,tool=工具结果) */
export interface SubagentMessage {
  role: 'user' | 'assistant' | 'tool';
  /** 第几步(1-based);user 消息固定 0 */
  step: number;
  at: number;
  /** user 消息的来源:brief=初始任务,parent=主代理后续消息,human=人类在子会话里发的 */
  from?: 'brief' | 'parent' | 'human';
  /** user/assistant:正文 */
  text?: string;
  /** assistant:思考内容(模型返回 reasoning 时) */
  reasoning?: string;
  /** tool:调用 id / 工具名 / 入参 / 结果 */
  callId?: string;
  name?: string;
  args?: string;
  isError?: boolean;
  content?: string;
  ms?: number;
}

/** 列表用的轻量快照(不含 messages 正文) */
export interface SubagentRunInfo {
  runId: string;
  /** 归属父会话 id */
  sid: string | null;
  description: string;
  provider: string;
  /** 派发方式(缺省按 continuable 读:老记录没有这个字段) */
  mode?: SubagentMode;
  status: SubagentStatus;
  /** 还有多少条消息/轮次在排队(可续聊的子代理才有意义) */
  queued?: number;
  startedAt: number;
  endedAt: number | null;
  ms: number | null;
  steps: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** 父对话给的原始字段(回看"任务与边界是怎么写的") */
  brief: { objective?: string; scope?: string; deliverable?: string; context?: string; prompt?: string };
  /** 组装后真正下发的提示词 */
  prompt: string;
  /** 结束补充说明(达到步数上限 / 被停止 / 出错原因) */
  note?: string | null;
  /**
   * 活跃时长口径(移植 dsh 的 subagentTiming,见 subagent-runtime 的 foldTiming):
   * **只累计真正在跑的回合**,闲置时间不计 —— 所以常驻子代理停在"当前未运行"时,
   * 前端显示的时间是定住的,不会一直涨。
   */
  settledMs?: number;
  /** 当前开着的那一轮的起点(ms);没有开着的轮 = null(前端据此决定计时器还走不走) */
  activeSince?: number | null;
  /** 开着的这一轮里最后一个事件的时间(留档;前端只在还在跑时用 now 兜底) */
  activeThrough?: number | null;
  /** 最近一次关闭的轮是否正常完成(前端据此把行显示成「已完成」而不是「当前未运行」) */
  lastTurnCompleted?: boolean | null;
}

/** 详情 = 列表快照 + 完整对话 */
export interface SubagentRun extends SubagentRunInfo {
  messages: SubagentMessage[];
}

const ID_RE = /^sa_[0-9a-z]+$/;
const MAX_MSG_CHARS = 40_000; // 单条消息正文上限(工具输出可能很大;超出截断,只影响回看)

/** 运行 id:时间戳 + 随机后缀,与父会话 id 前缀区分(s_ / sa_) */
export function newRunId(): string {
  return 'sa_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const cache = new Map<string, SubagentRun>();

function fileFor(runId: string): string {
  if (!ID_RE.test(runId)) throw new Error(`非法子代理 id: ${runId}`);
  return path.join(SUBAGENTS_DIR, runId + '.json');
}

function clip(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.length > MAX_MSG_CHARS ? s.slice(0, MAX_MSG_CHARS) + '\n…[过长,已截断]' : s;
}

function persist(run: SubagentRun): void {
  try {
    fs.mkdirSync(SUBAGENTS_DIR, { recursive: true });
    writeFileAtomic(fileFor(run.runId), JSON.stringify({ version: 1, ...run }));
  } catch (e: any) {
    // 落盘失败不该打断正在跑的模型循环:面板这一次拿不到,下一次变更会再写一遍
    console.warn(`[subagent-store] 落盘失败(${run.runId}): ${e?.message ?? e}`);
  }
}

/** 开始一次派发:建记录并立即落盘(面板可能在子代理还没跑完时就打开) */
export function beginRun(input: {
  runId: string; sid?: string | null; description: string; provider: string;
  brief: SubagentRunInfo['brief']; prompt: string; mode?: SubagentMode;
}): SubagentRun {
  const run: SubagentRun = {
    runId: input.runId,
    sid: input.sid ?? null,
    description: input.description,
    provider: input.provider,
    mode: input.mode ?? 'continuable',
    status: 'running',
    queued: 0,
    startedAt: Date.now(),
    endedAt: null,
    ms: null,
    steps: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    brief: input.brief,
    prompt: clip(input.prompt) || '',
    note: null,
    messages: []
  };
  cache.set(run.runId, run);
  persist(run);
  trim();
  return run;
}

/** 追加一条对话消息(每步落盘一次;列表/详情随即能看到最新进度) */
export function appendMessage(runId: string, msg: SubagentMessage): SubagentRun | null {
  const run = cache.get(runId);
  if (!run) return null;
  const next: SubagentMessage = { ...msg, content: clip(msg.content), text: clip(msg.text) };
  run.messages.push(next);
  persist(run);
  return run;
}

/** 收尾:写状态与统计(被停止/出错时带 note) */
export function finishRun(runId: string, patch: {
  status: SubagentStatus; steps: number; toolCalls: number;
  promptTokens: number; completionTokens: number; note?: string | null;
}): SubagentRun | null {
  const run = cache.get(runId);
  if (!run) return null;
  run.status = patch.status;
  run.steps = patch.steps;
  run.toolCalls = patch.toolCalls;
  run.promptTokens = patch.promptTokens;
  run.completionTokens = patch.completionTokens;
  run.note = patch.note ?? null;
  run.endedAt = Date.now();
  run.ms = run.endedAt - run.startedAt;
  persist(run);
  return run;
}

/**
 * 中途更新(不写 endedAt):常驻子代理每一步落一次进度,跑完一轮停在 idle 也走这里——
 * 它不是"结束",后面还能被 send_message 唤醒接着跑。
 */
export function updateRun(runId: string, patch: {
  status?: SubagentStatus; steps?: number; toolCalls?: number;
  promptTokens?: number; completionTokens?: number; note?: string | null; queued?: number;
  settledMs?: number; activeSince?: number | null; activeThrough?: number | null;
  lastTurnCompleted?: boolean | null;
}): SubagentRun | null {
  const run = cache.get(runId);
  if (!run) return null;
  if (patch.status !== undefined) run.status = patch.status;
  if (patch.steps !== undefined) run.steps = patch.steps;
  if (patch.toolCalls !== undefined) run.toolCalls = patch.toolCalls;
  if (patch.promptTokens !== undefined) run.promptTokens = patch.promptTokens;
  if (patch.completionTokens !== undefined) run.completionTokens = patch.completionTokens;
  if (patch.note !== undefined) run.note = patch.note;
  if (patch.queued !== undefined) run.queued = patch.queued;
  // 活跃时长(只累计真正在跑的回合):与状态一起落盘,刷新/切回后口径一致
  if (patch.settledMs !== undefined) run.settledMs = patch.settledMs;
  if (patch.activeSince !== undefined) run.activeSince = patch.activeSince;
  if (patch.activeThrough !== undefined) run.activeThrough = patch.activeThrough;
  if (patch.lastTurnCompleted !== undefined) run.lastTurnCompleted = patch.lastTurnCompleted;
  persist(run);
  return run;
}

/** 详情(带完整对话);内存没有则读盘。非法/缺失 id 返回 null */
export function get(runId: string): SubagentRun | null {
  const id = String(runId || '');
  const hit = cache.get(id);
  if (hit) return hit;
  if (!ID_RE.test(id)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.messages)) return null;
    const run = raw as SubagentRun;
    cache.set(id, run);
    return run;
  } catch { return null; }
}

/** 列表(不含对话正文),按开始时间倒序;传 sid 只列该父会话派发的 */
export function list(sid?: string | null): SubagentRunInfo[] {
  loadAll();
  const want = sid ? String(sid) : null;
  return [...cache.values()]
    .filter((r) => (want ? r.sid === want : true))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(({ messages: _messages, ...info }) => info);
}

/** 进程内已加载条数(测试/诊断用) */
export function size(): number { return cache.size; }

function loadAll(): void {
  let names: string[];
  try { names = fs.readdirSync(SUBAGENTS_DIR); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (cache.has(id)) continue;
    get(id);
  }
}

/** 超出上限时删最旧的若干条(内存 + 文件) */
function trim(): void {
  const limit = AGENT.SUBAGENT.MAX_RUNS;
  loadAll();
  const all = [...cache.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const run of all.slice(0, Math.max(0, all.length - limit))) {
    cache.delete(run.runId);
    try { fs.unlinkSync(fileFor(run.runId)); } catch { /* 文件可能已不在 */ }
  }
}
