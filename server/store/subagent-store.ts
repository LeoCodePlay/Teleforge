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

export type SubagentStatus = 'running' | 'done' | 'error' | 'stopped';

/** 子代理内部的一条对话消息(user=下发的提示词,assistant=模型产出,tool=工具结果) */
export interface SubagentMessage {
  role: 'user' | 'assistant' | 'tool';
  /** 第几步(1-based);user 消息固定 0 */
  step: number;
  at: number;
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
  status: SubagentStatus;
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
  brief: SubagentRunInfo['brief']; prompt: string;
}): SubagentRun {
  const run: SubagentRun = {
    runId: input.runId,
    sid: input.sid ?? null,
    description: input.description,
    provider: input.provider,
    status: 'running',
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
