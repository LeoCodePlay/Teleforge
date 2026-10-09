import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api';
import { useLlm } from '../../context/llm-context';
import type { ChatMessage, MsgSegment, ToolCallInfo, TodoItem, FileChangeItem, TokenUsageTotals, SessionStatsInfo } from '../../types';
import { rollbackPartialSegments } from '../../utils/rollbackPartial';
import { NO_WORKSPACE, WHOLE_LABEL } from '../../types';
import DirBrowser from '../DirBrowser/DirBrowser';
import LocalDirBrowser from '../DirBrowser/LocalDirBrowser';
import ModelMenu from '../ModelMenu/ModelMenu';
import ContextMeter, { type ContextUsage } from '../ContextMeter/ContextMeter';
import StatsPills, { TurnUsagePill } from '../StatsPills/StatsPills';
import TodoPanel from '../TodoPanel/TodoPanel';
import SlashMenu, { rankSlashItems, rankByName, SLASH_MENU_MAX } from '../SlashMenu/SlashMenu';
import type { SlashItem } from '../SlashMenu/SlashMenu';
import AtMenu, { AT_MENU_MAX } from '../AtMenu/AtMenu';
import type { AtCandidate } from '../AtMenu/AtMenu';
import { useFeedback } from '../../context/feedback';
import AskPanel from '../AskPanel/AskPanel';
import QueuePanel, { QueueItem } from '../QueuePanel/QueuePanel';
import PermissionSelect, { isPermissionMode } from '../PermissionSelect/PermissionSelect';
import type { PermissionMode } from '../PermissionSelect/PermissionSelect';
// 一次性子智能体的输入位:用 dsh 的只读说明框顶掉输入卡(而不是给一个禁用的输入框让人猜)
import { SubagentReadOnlyComposer } from '../SessionHeader/SubagentReadOnlyComposer';
import { ToolCallList } from '../ToolCallList/ToolCallList';
import { ProcessGroup } from '../ProcessGroup/ProcessGroup';
import { ProcessFold } from '../ProcessGroup/ProcessFold';
import { planGroups, isGroupLive, groupedFor, TRANSCRIPT_MODE, formatRunDuration } from '../../utils/processGroups';
// 非人类消息(子代理结算 / 自动化任务 / 目标续跑)的「触发本轮」通知行:照搬 dsh 的 TurnTriggerNodeView
import TurnTriggerRow from './TurnTriggerRow';
import { AssistantSegment, ReasoningSegment } from './assistantText';
import { CompactionRow } from './CompactionRow';
import { FilesChangedCard } from './FilesChangedCard';
import DeliverablesCard from '../DeliverablesCard/DeliverablesCard';
import { CommandCard } from './CommandCard';
import GoalBar from '../GoalBar/GoalBar';
import { LoadedSkillsRow } from './LoadedSkillsRow';
import { matchSlashCommand } from '../../utils/slashCommand';
import { atTokenAt, displayMentionText, restoreMentionInput, serializeMention, splitMentions } from '../../utils/mentionRefs';
import { mergeTrailingCommandCards } from '../../utils/commandCard';
import { tailAssistantIndex, applyRetryNotice, isRealUserRow } from '../../utils/compactionOrder';
import { mergeAttachments, mergeDeliverables } from '../../utils/mergeAttachments';
import { refreshOverlayScrollbar, setScrollbarHost } from '../../utils/scrollbar-ui';
import { StateDot } from '../StateDot/StateDot';
import { IconChevronDownOutline14, IconCloud16, IconDesktop16, IconFolder16, IconHome16, IconLock16, IconSend16, IconServer16, IconStop16, IconTrashOutline14 } from '../icons/icons';
import { AttachRail, MessageAttachments, Lightbox, classifyKind } from '../Attachments/Attachments';
import type { ComposerAttachment, LightboxSrc } from '../Attachments/Attachments';
import type { AttachmentInfo } from '../../types';
import type { GoalInfo } from '../../types';
import type { PresentedFile } from '../../types';
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path';
import './ChatPanel.scss';

// 新会话(尚未创建服务端会话)的前端占位 sid:用于"草稿式"新建——
// 点击「新建」只进入空对话的草稿态,不创建服务端会话、不进入历史列表;
// 发送首条消息时才真正 session_create,创建后按会话内容出现在历史会话列表。
export const NEW_SESSION_ID = '__new__';

// 会话级 RPC 的目标会话参数:草稿态(占位 sid)不传,由服务端回落当前活跃会话。
// 必须显式带上正在查看的会话 id——服务端「活跃会话」会随切服务器/新建会话静默改变,
// 不带 sid 的停止/清空/队列操作会落到另一个会话上(含另一台服务器上后台跑的会话)。
const sidArg = (v: string | null | undefined): string | undefined =>
  (v && v !== NEW_SESSION_ID ? v : undefined);

// 输入草稿缓存:按会话(或"新会话")保存输入框内容,切走再切回可恢复;
// 存 localStorage,刷新/切换标签页不丢。键 = 会话 id,新会话(尚未创建)用固定键。
const DRAFT_STORE_KEY = 'sshai.drafts.v1';
const NEW_DRAFT_KEY = NEW_SESSION_ID;
function loadDrafts(): Record<string, string> {
  try {
    const o = JSON.parse(localStorage.getItem(DRAFT_STORE_KEY) || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}
function saveDrafts(d: Record<string, string>) {
  try { localStorage.setItem(DRAFT_STORE_KEY, JSON.stringify(d)); } catch {}
}

// 只取路径最后一段(文件夹名)用于工作区 chip 显示:兼容 / 与 \ 分隔,
// 忽略末尾分隔符;根目录 / 或盘符根等无上级的路径原样返回。
function lastPathSegment(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i >= 0 ? t.slice(i + 1) : p;
}

// 正则元字符转义:按名称拼 RegExp(技能名/@文件名 去重判断)时使用
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
}

// 推理等级定义与选择器已迁移到 ModelMenu.tsx(REASONING_LEVELS + 二级菜单)。

// 用户消息时间戳格式化(按天粒度):
// - 今天:仅显示 HH:MM
// - 昨天:显示「昨天 HH:MM」
// - 前天及更早:显示「M月D日 HH:MM」;跨年时补上「YYYY年」
function formatMsgTime(ts?: number) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (dayDiff <= 0) return hm; // 今天(或未来的异常时间戳)
  if (dayDiff === 1) return `昨天 ${hm}`;
  const date = d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  return `${date} ${hm}`;
}

// 消息操作栏(照搬 deepseek-harness 的 MessageIconActions):
// - 复制:复制该条回复的全文,成功后图标短暂换成 ✓(1s)
// - 分支:从这条回复处开启新会话继续——作用于任意一条历史消息,不只最新一条;
//   新会话克隆到该条回复为止的事件日志,后续对话从分支点另起炉灶(原会话保留)
// - 统计行(dsh 的 turn-tail):图标簇之后跟「用量胶囊 + 本轮用时」——
//   一轮跑完看到「⟨数据仓〉用量 31.2M tok  2分19秒」,点胶囊展开本轮用量明细
//
// 用时取的是**本轮权威耗时**(服务端 turn/end 的 turnElapsedMs,与折叠行
// 「已完成,用时 2分19秒」同一个字段、同一个格式化器),而不是消息时钟,
// 也不用前端本地推算 —— 刷新/切会话后历史回放与实时显示同一个值。
/** 本轮用时的纯文本(显示与 title 共用一份,避免两处口径漂移) */
function runDurationText(ms: number): string {
  return formatRunDuration(ms).map((p) => p.text).join('');
}
/** 本轮运行的起点(ms):视图末尾挂着流式回复,说明本轮已上屏,取本轮那条真实 user 消息的
 *  时间(start 事件写入的发送时刻);视图里还没有本轮内容(刚点发送、消息尚未渲染)时返回 0,
 *  由调用方用"现在"起算 —— 绝不拿上一轮的旧时间戳兜底,那会让时长一开始就是几十秒。 */
function liveTurnStartMs(msgs: ChatMessage[], now: number): number {
  const tail = msgs[msgs.length - 1];
  if (!tail || tail.role !== 'assistant' || !tail.streaming) return 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!isRealUserRow(msgs[i])) continue;
    const t = msgs[i].time;
    return typeof t === 'number' && t > 0 && t <= now && now - t < 24 * 3600_000 ? t : 0;
  }
  return 0;
}
const IconCopy = () => (
  <svg width={15} height={15} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
const IconCheck = () => (
  <svg width={15} height={15} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IconBranch = () => (
  <svg width={15} height={15} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="4.5" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="11.5" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="8" cy="12.5" r="1.8" stroke="currentColor" strokeWidth="1.2" />
    <path d="M4.5 5.3v1.2c0 1 .8 1.8 1.8 1.8h3.4c1 0 1.8-.8 1.8-1.8V5.3M8 8.3v2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

function MessageActions({ text, onBranch, elapsedMs, usage }: {
  text: string;
  onBranch?: () => void;
  /** 本轮用时(ms,服务端权威下发):统计行右端显示「此次回复用时」 */
  elapsedMs?: number;
  /** 本轮 token 用量;缺省(网关不报用量)时只显示用时,不显示用量胶囊 */
  usage?: TokenUsageTotals;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current); }, []);
  const onCopy = async () => {
    if (copied) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      timerRef.current = setTimeout(() => { timerRef.current = null; setCopied(false); }, 1000);
    } catch { /* 剪贴板不可用时静默 */ }
  };
  const dur = elapsedMs === undefined ? null : runDurationText(elapsedMs);
  return (
    <div className="msg-actions">
      <button type="button" className="msg-action action-icon" aria-label="复制" onClick={onCopy}>
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
      {onBranch && (
        <button type="button" className="msg-action action-icon" aria-label="在新对话中分支"
          data-tip="在新对话中分支"
          onClick={onBranch}>
          <IconBranch />
        </button>
      )}
      {/* 统计行(照搬 dsh turn-tail 的排布:图标簇之后接统计信息)。
          用时就是本轮的权威耗时(与折叠行「已完成,用时 X」同字段同格式化器),
          所以历史回放与实时显示同一个值;用量缺失(网关不报)时只留用时,
          整行不渲染"0 tok"的假数字 */}
      {(usage || dur) && (
        <span className="msg-actions-stats" data-turn-tail-stats>
          {usage && <TurnUsagePill usage={usage} />}
          {dur && <span className="msg-actions-time" data-tip="本轮用时">{dur}</span>}
        </span>
      )}
    </div>
  );
}

const IconTrash = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2.5 4h11M6.5 4V2.8c0-.4.3-.8.8-.8h1.4c.4 0 .8.4.8.8V4M4 4l.6 8.2c.04.5.45.8.95.8h4.9c.5 0 .9-.3.95-.8L12 4M6.5 7v4M9.5 7v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IconRewind = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M7 3 3 7l4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4.5 7H11c1.1 0 2 .9 2 2v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 用户消息操作栏(位于用户气泡下方,与 AI 回复的操作栏呼应):
// 纯图标钮,说明文案走悬停 tip:
// - 复制:复制该条用户消息原文,成功后短暂显示 ✓
// - 删除:删除这条消息及其对应的整轮回复
// - 回到本轮对话发起前:把对话回退到这条消息之前(移除它及其之后的所有内容)
function UserMessageActions({ text, onDelete, onRewind }: {
  text: string;
  /** 删除这条消息(缺省不渲染:子智能体会话不支持改历史,见 ChatPanel 的 childMode) */
  onDelete?: () => void;
  /** 回到本轮对话发起前(缺省不渲染) */
  onRewind?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current); }, []);
  const onCopy = async () => {
    if (copied) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      timerRef.current = setTimeout(() => { timerRef.current = null; setCopied(false); }, 1000);
    } catch { /* 剪贴板不可用时静默 */ }
  };
  return (
    <div className="msg-actions user-msg-actions">
      <button type="button" className="msg-action action-icon" aria-label="复制" onClick={onCopy}>
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
      {onDelete && (
        <button type="button" className="msg-action action-icon danger" aria-label="删除消息" onClick={onDelete}>
          <IconTrash />
        </button>
      )}
      {onRewind && (
        <button type="button" className="msg-action action-icon" aria-label="回到本轮对话发起前"
          data-tip="回到本轮对话发起前" onClick={onRewind}>
          <IconRewind />
        </button>
      )}
    </div>
  );
}

// 区段合并辅助:文本/思考/工具组按到达顺序交替追加;
// 连续同类合并(连续工具调用并为一组,连续思考增量并成一段)
function appendSeg(msg: ChatMessage, seg: MsgSegment) {
  if (!msg.segments) msg.segments = [];
  const last = msg.segments[msg.segments.length - 1];
  if (last && last.kind === seg.kind) {
    if (seg.kind === 'tools') last.tools!.push(...(seg.tools || []));
    else last.text = (last.text || '') + (seg.text || '');
  } else {
    msg.segments.push(seg);
  }
}
function appendText(msg: ChatMessage, text?: string) {
  if (text) appendSeg(msg, { kind: 'text', text: String(text) });
}
// 思考段:对齐 dsh 的 ReasoningRow 逐块渲染,穿插在文本/工具组之间
function appendReasoning(msg: ChatMessage, text?: string) {
  if (text) appendSeg(msg, { kind: 'reasoning', text: String(text) });
}
function appendTools(msg: ChatMessage, tools?: ToolCallInfo[]) {
  if (tools && tools.length) appendSeg(msg, { kind: 'tools', tools });
}
function segText(msg: ChatMessage) {
  return (msg.segments || []).filter((s) => s.kind === 'text').reduce((a, s) => a + (s.text || ''), '');
}

// 注:本步半成品的回滚规则见 utils/rollbackPartial(纯函数,便于单测覆盖)。

// ---- 文件变更汇总:从消息的工具调用 meta 聚合「N 个文件已更改」卡片数据 ----
// 文件类工具(write/edit/delete × 远程/本地)在 tool_result 附加 card='diff' 的改动卡
// (path/kind/addLines/delLines);同文件多次操作按路径合并增删行数,kind 删除优先。
const FILE_CHANGE_KINDS = new Set(['create', 'write', 'edit', 'delete']);
// 本机文件变更工具(远程侧对应 write_file/edit_file/delete_path):
// 点击卡片条目打开文件时据此选择「本机文件查看」通道(FileViewer 的 local: 前缀),与文件管理器的打开方式一致
const LOCAL_FILE_TOOLS = new Set(['write_local_file', 'edit_local_file', 'delete_local_path']);
function collectFileChanges(msg: ChatMessage): FileChangeItem[] {
  const byPath = new Map<string, FileChangeItem>();
  for (const seg of msg.segments || []) {
    if (seg.kind !== 'tools') continue;
    for (const t of seg.tools || []) {
      const m = t.meta;
      if (!m || m.card !== 'diff' || typeof m.path !== 'string' || !m.path) continue;
      const kind: FileChangeItem['kind'] = FILE_CHANGE_KINDS.has(m.kind ?? '') ? (m.kind as FileChangeItem['kind']) : 'edit';
      const add = typeof m.addLines === 'number' && Number.isFinite(m.addLines) ? m.addLines : 0;
      const del = typeof m.delLines === 'number' && Number.isFinite(m.delLines) ? m.delLines : null;
      const local = LOCAL_FILE_TOOLS.has(t.tool);
      // 同一路径字符串可能来自远程/本机两侧,按来源分桶避免错误合并;展示路径仍用 m.path
      const key = (local ? 'local:' : 'remote:') + m.path;
      const cur = byPath.get(key);
      if (!cur) { byPath.set(key, { path: m.path, kind, addLines: add, delLines: del, local }); continue; }
      cur.addLines += add;
      cur.delLines = del !== null ? (cur.delLines ?? 0) + del : cur.delLines;
      if (kind === 'delete') cur.kind = 'delete'; // 删除是文件的最终状态
    }
  }
  // 按路径排序,展示顺序稳定
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
// 运行态压缩行(compaction_start 插入)的收尾兜底:会话已空闲却还挂着「正在压缩…」,
// 只可能是 compaction_done 在断线/切会话期间漏收(补发窗口有限)。原地摘掉它,
// 避免界面永远停在一个不会结束的状态;重开会话时由 compaction/done 投影出完成态行。
function dropStaleCompaction(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.some((m) => m.compaction?.running) ? msgs.filter((m) => !m.compaction?.running) : msgs;
}

// 收尾时清掉「重试提示行紧跟的、还没来得及产出内容的空气泡」。
// 重试在等待期间被用户停止 / 本轮直接失败时,失败点分界出来的新气泡可能一个字符都没流出来,
// 留着会在对话末尾多出一块空白。
function dropEmptyRetryBubble(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.filter((m, i) => {
    if (m.role !== 'assistant' || m.streaming) return true;
    if ((m.segments && m.segments.length) || (m.attachments && m.attachments.length)) return true;
    const prev = msgs[i - 1];
    return !(prev && prev.role === 'notice' && prev.retry);
  });
}

// 本轮收尾时把文件变更汇总挂到 assistant 消息上。
// 一轮回复可能被重试提示拆成多段(见 live 的 retry 分支与 turnsToMessages):只统计收尾段
// 会漏掉重试之前的改动,所以这里把「本轮(最后一条 user 之后)所有片段的工具调用」合并后再聚合。
function attachTurnFileChanges(msgs: ChatMessage[], lastIdx: number) {
  if (lastIdx < 0 || lastIdx >= msgs.length) return;
  let start = 0;
  for (let i = lastIdx; i >= 0; i--) {
    if (isRealUserRow(msgs[i])) { start = i + 1; break; }
  }
  const merged: ChatMessage = {
    role: 'assistant',
    segments: msgs.slice(start, lastIdx + 1).flatMap((m) => m.segments || [])
  };
  msgs[lastIdx].filesChanged = collectFileChanges(merged);
}

// 把服务端持久化的 turns 转成渲染消息数组:
// 一次 run 的多轮 assistant/tool 在渲染上合并为一条回复,按「思考 / 文本 / 连续工具组」实际发生顺序分段
function turnsToMessages(turns: any[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // 当前连续失败阶段的重试行下标:恢复 assistant 输出或分组变化后不再覆盖旧记录。
  let lastRetryOutIdx = -1;
  // 记录每个 turns 下标对应到 out 里的投影下标:服务端原位投影后,压缩标记行的
  // compaction.retainedFrom 是 turns 下标(保留区首条消息面在 turns 里的位置)。
  // 由于 tool 被折叠、assistant 多轮合并,out 的长度不等于 turns 的长度,
  // 必须通过这张映射把 turns 下标换算成 out 下标,才能给 modelFaceMessages 正确切片。
  const turnToOut = new Array(turns.length).fill(-1);
  // 先扫一遍把工具结果聚齐:历史 turns 的顺序是 assistant(含 tool_calls)在前、
  // tool(执行结果)在后,若边循环边查 map,处理 assistant 时结果还没写入,
  // 会漏配导致工具永远显示"执行中"。预扫后无论顺序如何都能配对成功。
  const toolById = new Map<string, ToolCallInfo>(); // tool_call_id -> {tool, ok, ms?, result}
  for (const t of turns) {
    if (t && t.role === 'tool' && t.tool_call_id) {
      const id = String(t.tool_call_id);
      toolById.set(id, { tool: t.tool_name, args: t.tool_args, ok: t.ok ?? true, ms: t.ms, result: t.content || '', meta: t.meta, attachments: t.attachments });
    }
  }
  for (let ti = 0; ti < turns.length; ti++) {
    const t = turns[ti];
    if (t.role === 'tool') {
      // 工具结果并入所在回复,该消息的分支点随之推进到这条 turn
      const last = out[out.length - 1];
      if (last) last.forkTail = ti;
      if (last) turnToOut[ti] = out.length - 1;
      continue; // tool 消息本身不渲染,只作为结果并入上游工具组
    }
    if (t.role === 'user') {
      // 新一轮开始:上一轮的重试行不再参与合并。压缩标记行(compaction)的 role 也是 'user',
      // 但它不是新一轮对话 —— 把它当分界会让压缩之后的每次重试都另起一行(长会话必踩)。
      if (!t.compaction) lastRetryOutIdx = -1;
      const pushBack = () => {
        const idx = out.length;
        out.push({
          role: 'user', content: t.content || '', forkTail: ti, time: t.time,
          // 附件元数据随历史回放,用户气泡内渲染缩略图/文件 chip
          ...(Array.isArray(t.attachments) && t.attachments.length ? { attachments: t.attachments } : {}),
          // 手动调用技能(`/技能名`)的记录随历史回放,用户气泡下方恢复「已加载技能」行
          ...(Array.isArray(t.skillsInjected) && t.skillsInjected.length ? { skillsInjected: t.skillsInjected } : {}),
          // 目标自动续跑轮:气泡渲染成「🎯 目标第 N 轮」而不是一段像用户说的话
          ...(t.goalRound ? { goalRound: t.goalRound } : {}),
          // 非人类消息的来源归属(通知行据此渲染:标题/时间/展开正文,而不是用户气泡)
          ...(t.source ? { source: t.source, ...(t.inline ? { inline: true } : {}) } : {}),
          ...(t.compaction ? { compaction: t.compaction } : {})
        });
        turnToOut[ti] = idx;
      };
      if (t.compaction) {
        // 压缩标记行:compaction.retainedFrom 是保留区首条消息面的 turns 下标,
        // 换算成 out 下标后删除原字段,供 utils/tokens 的 modelFaceMessages 切片。
        // 原位投影下标记行跟在保留区之后(压缩发生那一刻最后一条消息后面),刷新后位置不变。
        const cp = t.compaction as any;
        let fromIdx = typeof cp.retainedFrom === 'number' && cp.retainedFrom >= 0
          ? turnToOut[cp.retainedFrom]
          : undefined;
        // 保留区首条在渲染数组里的下标;取不到(无保留消息 / 该 turn 未投影)时落在末尾,
        // 此时模型面只剩摘要标记行本身。
        if (typeof fromIdx !== 'number' || fromIdx < 0) fromIdx = out.length;
        cp.modelFaceFrom = fromIdx;
        delete cp.retainedFrom;
      }
      pushBack();
      continue;
    }
    if (t.role === 'assistant') {
      const calls = t.tool_calls_json ? JSON.parse(t.tool_calls_json) : (t.tool_calls || []);
      if (t.content || t.reasoning_content || calls.length || t.attachments?.length) lastRetryOutIdx = -1;
      const tools: ToolCallInfo[] = (Array.isArray(calls) ? calls : [])
        .filter((c: any) => c && c.id && c.function?.name)
        .map((c: any): ToolCallInfo => {
          const r = toolById.get(String(c.id));
          if (r) return { ...r };
          let args = '';
          try { args = JSON.stringify(JSON.parse(c.function.arguments || '{}'), null, 2); } catch {}
          return { tool: c.function.name, args, ok: undefined, ms: undefined, result: undefined };
        });
      // 合并到上一条 assistant 消息(同一场 run 的多轮迭代)
      const prev = out[out.length - 1];
      if (prev && prev.role === 'assistant') {
        // 思考内容按轮次插入对应位置(先于该轮正文),不再整体堆到消息开头
        if (t.reasoning_content) appendReasoning(prev, t.reasoning_content);
        appendText(prev, t.content);
        appendTools(prev, tools);
        // 生图成图(image/generated 投影)并入上一条摘要消息:摘要文本 + 成图同处一个气泡;
        // 同一次 run 里多次生图会分多条投影到达,这里必须逐批累加(mergeAttachments)而不是覆盖
        if (Array.isArray(t.attachments) && t.attachments.length) prev.attachments = mergeAttachments(prev.attachments, t.attachments);
        // 回合耗时/结束原因:折叠行「已完成,用时 X」用(服务端在 turn/end 时回填到本轮各行)
        if (t.turnElapsedMs !== undefined) prev.turnElapsedMs = t.turnElapsedMs;
        if (t.turnEndReason !== undefined) prev.turnEndReason = t.turnEndReason;
        // 本轮用量:统计行「用量 X tok + 用时」用(同一轮回填值相同,合并时后者覆盖即可)
        if (t.turnUsage) prev.turnUsage = t.turnUsage;
        // 成果物交付声明:同一轮里可能多次 present,逐批累加而不是覆盖
        if (Array.isArray(t.deliverables) && t.deliverables.length) {
          prev.deliverables = mergeDeliverables(prev.deliverables, t.deliverables);
        }
        if (t.imageJob) prev.imageJob = t.imageJob;
        prev.forkTail = ti;
        turnToOut[ti] = out.length - 1;
      } else {
        const nm: ChatMessage = { role: 'assistant', segments: [], streaming: false, forkTail: ti };
        if (t.reasoning_content) appendReasoning(nm, t.reasoning_content);
        appendText(nm, t.content);
        appendTools(nm, tools);
        if (Array.isArray(t.attachments) && t.attachments.length) nm.attachments = t.attachments;
        if (t.turnElapsedMs !== undefined) nm.turnElapsedMs = t.turnElapsedMs;
        if (t.turnEndReason !== undefined) nm.turnEndReason = t.turnEndReason;
        if (t.turnUsage) nm.turnUsage = t.turnUsage;
        if (Array.isArray(t.deliverables) && t.deliverables.length) nm.deliverables = t.deliverables;
        if (t.imageJob) nm.imageJob = t.imageJob;
        const idx = out.length;
        out.push(nm);
        turnToOut[ti] = idx;
      }
      continue;
    }
    if (t.role === 'notice') {
      // 提示行(⚠ 中断原因 / 截断披露)与重试记录:服务端已把它们作为「显示面」事件持久化,
      // 这里必须原样渲染 —— 它们不进模型上下文,但要留在对话里发生的位置上。
      // 日志中每次重试各占一条,只有连续失败阶段内的记录原地合并。
      // retryGroup 也能区分曾恢复输出但半成品已回滚、没有 assistant 落盘的情况。
      if (t.retry) {
        const previousRetry = lastRetryOutIdx >= 0 ? out[lastRetryOutIdx]?.retry : undefined;
        const sameGroup = previousRetry && (!t.retry.retryGroup || !previousRetry.retryGroup
          || t.retry.retryGroup === previousRetry.retryGroup);
        if (sameGroup) {
          out[lastRetryOutIdx] = {
            ...out[lastRetryOutIdx], content: '', retry: t.retry, time: t.time, forkTail: ti
          };
          turnToOut[ti] = lastRetryOutIdx;
          continue;
        }
        const idx = out.length;
        out.push({
          role: 'notice', content: '', retry: t.retry,
          level: t.level, kind: t.kind, time: t.time, forkTail: ti
        });
        lastRetryOutIdx = idx;
        turnToOut[ti] = idx;
        continue;
      }
      const idx = out.length;
      out.push({
        role: 'notice', content: t.content || '',
        level: t.level, kind: t.kind, time: t.time, forkTail: ti
      });
      turnToOut[ti] = idx;
      continue;
    }
    // 其余角色跳过
  }
  // 标记行保持原位投影(服务端 projectEvents 已经按事件日志顺序投影,不复排)。
  // 文件变更汇总:历史回放的工具 meta 已随 tool/result 持久化,按轮聚合挂载。
  // 一轮回复可能被重试提示拆成多段:每段各挂「本轮到目前为止」的汇总,只有收尾那段会显示
  // (中间片段在渲染层被当作 fragments 静默),于是卡片仍统计整轮改动,不会因重试而漏文件。
  {
    let runStart = 0;
    for (let i = 0; i < out.length; i++) {
      if (isRealUserRow(out[i])) { runStart = i + 1; continue; }
      if (out[i].role !== 'assistant') continue;
      const merged: ChatMessage = {
        role: 'assistant',
        segments: out.slice(runStart, i + 1).flatMap((m) => m.segments || [])
      };
      out[i].filesChanged = collectFileChanges(merged);
    }
  }
  return out;
}

// ---- 输入区:单一可编辑文本 + 高亮叠加层 ----
// 不再用"冻结文本段 + 技能 tag"分段输入(会导致布局错乱且冻结文本不可编辑);
// 输入框始终是普通 textarea,内容完整可编辑。叠加层按后端同款规则
// (行首/空白后的 /word 或 @word,其后跟空白或结尾)把 /技能名 与 @文件名 高亮显示;
// 退格时光标紧邻完整 /技能名 或 @文件名 时整词删除(连同其后单个空格)。
type OverlaySeg = { t: 'text' | 'skill' | 'mention'; v: string };

function tokenizeInput(text: string): OverlaySeg[] {
  const out: OverlaySeg[] = [];
  // 同时识别 /技能 与 @文件名 两类 token;@ 是引用标记,与 / 共用词边界规则
  const re = /(?:^|\s)((?:\/[a-z0-9][a-z0-9-]*)|(?:@[a-zA-Z0-9_.\-/\\]+))(?=\s|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      // 前导空白归入文本段(不高亮),只高亮 token 本身
      out.push({ t: 'text', v: text.slice(last, m.index + (m[0].length - m[1].length)) });
    }
    out.push({ t: m[1].startsWith('/') ? 'skill' : 'mention', v: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

// 用户消息正文渲染:上行正文里 @ 引用是 @source:完整路径(给模型按路径读文件用),
// 气泡里折叠成 @文件名,避免一长串绝对路径把消息撑得又长又难看;悬停 title 给出完整路径。
// 折叠发生在渲染期,历史消息(落盘的就是带路径的正文)无需迁移。
function MentionText({ text }: { text: string }) {
  return (
    <>
      {splitMentions(text).map((s, i) => s.t === 'mention'
        ? <span className="bubble-mention" key={i} data-tip={s.path}>{s.v}</span>
        : <React.Fragment key={i}>{s.v}</React.Fragment>)}
    </>
  );
}

interface ChatPanelProps {
  connected: boolean;
  workspace: string | null;
  /** 本地工作区(未连接服务器时可据此在本地模式对话) */
  localWorkspace?: string | null;
  /** 远程文件面板当前打开的目录:@ 引用候选以此(而非工作区根)为遍历起点 */
  remoteCwd?: string;
  /** 本地文件面板当前打开的目录:@ 引用候选以此(而非工作区根)为遍历起点 */
  localCwd?: string;
  busy: boolean;
  sessionSeq?: number;
  sid?: string | null;
  home?: string | null;
  savedWs?: string[];
  /** 本机家目录(本地工作区下拉/浏览默认起点) */
  localHome?: string | null;
  /** 本机保存过的本地工作区历史 */
  savedLocalWs?: string[];
  /** 远程侧处于「不在工作区对话」(全盘模式):边界 = 整台服务器,workspace 必为 null */
  noWorkspace?: boolean;
  /** 本地侧处于「不在工作区对话」(全盘模式):边界 = 整台电脑,localWorkspace 必为 null */
  localNoWorkspace?: boolean;
  /** 当前会话远程工作区已锁定(会话已开始对话):远程 chip 禁用 */
  remoteLocked?: boolean;
  /** 当前会话本地工作区已锁定(本地会话已开始对话):本地 chip 禁用 */
  localLocked?: boolean;
  onWorkspaceSet: (ws: string) => void;
  /** 选择/切换本地工作区;sid = 当前会话 id(草稿态为 null,服务端不绑定会话) */
  onLocalWorkspaceSet?: (p: string, sid?: string | null) => void;
  /** 从当前服务器的工作区历史中删除一条记录(仅删快捷记录,不影响远程目录) */
  onDeleteWs?: (ws: string) => void;
  /** 从本地工作区历史中删除一条记录 */
  onDeleteLocalWs?: (p: string) => void;
  /** 在新对话中分支:由 App 执行 session_fork 并刷新会话(at 为 turns 索引,-1 表示从尾部;缺省时隐藏分支按钮) */
  onFork?: (at: number) => void;
  /** 新会话草稿态发送首条消息:ChatPanel 先创建服务端会话,成功后回调让 App 刷新会话列表/active/sessionSeq */
  onSessionCreated?: (r: any) => void;
  /**
   * 「新会话草稿」占位会话 id(d_…):草稿期开的浏览器预览绑在它名下,
   * 创建真实会话时随 session_create 一起提交,服务端把预览归属改名继承过去(否则预览成了没人认领的孤儿)。
   */
  draftSid?: string;
  /** 会话发送了首条消息(发送那一刻即回调):App 据此立即锁定会话工作区,不必等服务端 msgCount 落盘回传 */
  onSessionTouched?: (sid: string | null) => void;
  /** 移动端(手机)布局:Enter 改为换行(发送只点按钮),提示文案同步切换 */
  compact?: boolean;
  /** 打开远程文件(复用 App 的文件标签页);「N 个文件已更改」卡片条目点击时调用 */
  onOpenFile?: (path: string) => void;
  /** 打开子智能体会话(runId 来自子智能体 tool/result 的 meta):主对话区只读回看 */
  onOpenSubagent?: (runId: string) => void;
  /** 打开本机文件(内部自动加 local: 前缀,走本机读取通道) */
  onOpenLocalFile?: (path: string) => void;
  /** 在右侧栏打开远程文件(对照阅读;未提供则卡片上的「侧栏」入口不出现) */
  onOpenFileAside?: (path: string) => void;
  /** 在右侧栏打开本机文件 */
  onOpenLocalFileAside?: (path: string) => void;
  /** 查看某文件的改动对比(右侧栏 changes-review 标签;与「打开文件」是两条链路) */
  onOpenChanges?: (path: string) => void;
  /**
   * 子智能体会话模式:同一个 ChatPanel,只是把**父会话专属**的控件收起来 ——
   * 工作区选择、权限/模型选择、附件与 @ / 技能菜单、消息删除/回退。
   * 历史、发送、停止、排队这些全部走同一套 RPC(服务端按 sid 前缀分流到子代理运行时),
   * 所以子会话的呈现与父会话完全一样(同一套回合折叠、工具行、操作栏、统计)。
   */
  childMode?: boolean;
}

// 模型请求失败进入重试的状态行(照搬 deepseek-harness 的 ModelRetryItem):
// 单行折叠行,不占大块警示横幅——收起时只显示「等待/已重试模型请求(N/M) · Xs」实时倒计时,
// 展开可看重试延迟与失败原因。等待中文字带扫光动画,同一失败重试原地更新不堆叠。
function RetryRow({ data }: { data: NonNullable<ChatMessage['retry']> }) {
  const { retry, maxRetries, delayMs, error, state, discard, kind } = data;
  // 换 Key(kind='switch')是立即重发,没有"等待"这回事:不做倒计时、也不显示"重试延迟"
  const isKeySwitch = kind === 'switch';
  const scheduledSeconds = Math.max(1, Math.ceil(delayMs / 1000));
  const [seconds, setSeconds] = useState(scheduledSeconds);

  useEffect(() => {
    // 仅"等待重试"阶段走实时倒计时;开始/取消后定格为该次的计划等待秒数
    if (isKeySwitch || state !== 'scheduled') { setSeconds(scheduledSeconds); return; }
    // 倒计时锚定浏览器时钟(事件时间与 Date.now() 可能不同钟),每秒校准
    const deadline = Date.now() + delayMs;
    const tick = () => setSeconds(Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    if (Math.max(1, Math.ceil(delayMs / 1000)) <= 1) return;
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [delayMs, retry, state, scheduledSeconds, isKeySwitch]);

  const label = isKeySwitch
    ? (state === 'scheduled' ? '正在切换 API Key' : '已切换 API Key')
    : state === 'started' ? '已重试模型请求'
      : state === 'cancelled' ? '模型请求重试已取消'
        : '等待重试模型请求';

  return (
    <details className={`retry-msg${state === 'scheduled' ? ' active' : ''}`}>
      <summary>
        <span className="retry-text">
          {isKeySwitch
            ? `${label}(第 ${retry}/${maxRetries} 个 Key)`
            : `${label}(${retry}/${maxRetries}) · ${seconds}s`}
        </span>
      </summary>
      <div className="retry-details">
        {isKeySwitch
          ? <div><span className="retry-detail-label">切换：</span>该 Key 不可用,已改用第 {retry} 个可用 Key(共 {maxRetries} 个);立即重新发送这一步,不等待</div>
          : <div><span className="retry-detail-label">重试延迟：</span>{delayMs}ms</div>}
        <div><span className="retry-detail-label">失败原因：</span>{error}</div>
        {discard ? (
          <div><span className="retry-detail-label">已回滚：</span>这一步已输出的半成品作废,重试后重新生成</div>
        ) : null}
      </div>
    </details>
  );
}

// 把最近的「等待重试」提示标记为「已开始重试」:模型流恢复(text/reasoning/tool 到达)后,
// 对齐 harness llm/retry-started 语义;多次到达幂等(状态已非 scheduled 时不动)。
function markRetryStarted(msgs: ChatMessage[]): ChatMessage[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const rt = msgs[i]?.retry;
    if (rt && rt.state === 'scheduled') {
      msgs[i] = { ...msgs[i], retry: { ...rt, state: 'started' } };
      break;
    }
  }
  return msgs;
}

// 轮次导轨预览用的纯文本投影(照搬 harness 预览只给纯文本摘要的口径):
// 截断后再剥掉代码围栏/markdown 标记并压缩空白,长回复在流式期间也不至于反复跑整段正则。
function railPreviewText(raw: string): string {
  const s = raw.length > 600 ? raw.slice(0, 600) : raw;
  return s
    .replace(/```[\s\S]*?```/g, ' ')          // 代码块(含 ```thinking 推理块)
    .replace(/`([^`]*)`/g, '$1')              // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')     // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // 链接取标签
    .replace(/^[ \t]{0,3}(#{1,6}|>)[ \t]*/gm, '') // 标题/引用前缀
    .replace(/[*_~]/g, '')                    // 强调标记
    .replace(/\s+/g, ' ')
    .trim();
}

/** 导轨预览的字符预算(照搬 harness turn-navigation.ts:一行提问 50、最多三行回复 120) */
const RAIL_PROMPT_LIMIT = 50;
const RAIL_RESPONSE_LIMIT = 120;

/**
 * 照搬 harness turn-navigation.ts 的 preview():拼接文本块 → 压缩空白 → 超预算截断并补省略号;
 * 单块本身超预算时同样补省略号。dsh 在 host 侧对渲染后的文本块做这件事,这里输入是已剥标记的纯文本。
 */
function railPreview(parts: string[], limit: number): string {
  let text = '';
  let unread = false;
  for (const part of parts) {
    if (text.length >= limit * 2) { unread = true; break; }
    const clipped = part.length > limit * 2;
    const chunk = clipped ? part.slice(0, limit * 2) : part;
    text += text === '' ? chunk : ` ${chunk}`;
    if (clipped) { unread = true; break; }
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`;
  return unread ? `${normalized}…` : normalized;
}

export default function ChatPanel({ connected, workspace, localWorkspace, remoteCwd, localCwd, busy, sessionSeq = 0, sid = null, home = null, savedWs = [], localHome = null, savedLocalWs = [], noWorkspace = false, localNoWorkspace = false, remoteLocked = false, localLocked = false, onWorkspaceSet, onLocalWorkspaceSet, onDeleteWs, onDeleteLocalWs, onFork, onSessionCreated, draftSid, onSessionTouched, onOpenFile, onOpenLocalFile, onOpenFileAside, onOpenLocalFileAside, onOpenChanges, onOpenSubagent, compact = false, childMode = false }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // 渲染期同步最新消息:运行状态行的时长计时器要读历史里最新一条消息的时间
  // (切回一个本视图没跑过的运行中会话时,本地没有本轮打戳,只能靠它兜底起点)
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  // 屏幕上的 messages 属于哪个会话:新会话的历史是**异步回载**的,回载完成前视图里挂着的还是
  // 上一个会话的内容。运行状态行的计时器据此判断"能不能拿这段消息当本会话本轮起点"——
  // 认错了会话,两个会话后面就会跟着同一个已跑时长(运行中的 A 切到后开跑的 B,B 显示 A 的时长)。
  // 与 setMessages 在同一个 effect 里同批更新:状态一起提交,计时器 effect 依据它重新认领起点。
  const [msgsSid, setMsgsSid] = useState<string | null>(sid);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [input, setInput] = useState('');
  // 输入草稿:切换会话时保存当前输入、恢复目标会话输入(见 [sessionSeq, sid] effect);
  // 实时写入 draftsRef 内存 + 防抖落盘 localStorage,发送成功后清除。
  const draftsRef = useRef<Record<string, string>>(loadDrafts());
  const inputValueRef = useRef(input); // 渲染期同步,供 effect 读取最新输入
  inputValueRef.current = input;
  // 当前输入归属的草稿键:仅显式新建的草稿态(sid='__new__')用固定键,真实会话用 sid;
  // sid==null(App 初次加载尚未定向会话)时不算草稿键,不读写草稿
  const currentDraftKey = sid === NEW_SESSION_ID ? NEW_DRAFT_KEY : sid;
  const prevDraftKeyRef = useRef<string | null>(currentDraftKey); // 上一次 effect 运行的草稿键(即"旧会话")
  const firstDraftRunRef = useRef(true); // 挂载首帧只恢复草稿,不把空输入写进 localStorage
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistDrafts = () => {
    if (persistTimer.current) { clearTimeout(persistTimer.current); persistTimer.current = null; }
    saveDrafts(draftsRef.current);
  };
  const schedulePersist = () => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => saveDrafts(draftsRef.current), 400);
  };
  // 统一更新输入 + 同步当前会话草稿(发送/斜杠命令/撤回编辑等程序化写入也走这里)
  const updateInput = (v: string) => {
    setInput(v);
    if (currentDraftKey) {
      if (v.trim()) draftsRef.current[currentDraftKey] = v;
      else delete draftsRef.current[currentDraftKey];
      schedulePersist();
    }
  };
  // / 命令菜单(照搬 harness 的行内命令交互):slashOpen=true 时输入以 / 开头,
  // slashQuery 为斜杠后的过滤词;技能候选来自 skills_list(未连接时仍返回内置+本机技能)
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashActive, setSlashActive] = useState(-1);
  const [slashSkills, setSlashSkills] = useState<SlashItem[]>([]);
  // @ 引用菜单(与 / 并行):atOpen=true 时输入以 @ 开头(行首或空白后),
  // atQuery 为 @ 后的过滤词;候选来自 ref_candidates(远程+本地工作区扁平化遍历)
  const [atOpen, setAtOpen] = useState(false);
  const [atQuery, setAtQuery] = useState('');
  const [atActive, setAtActive] = useState(-1);
  const [atCandidates, setAtCandidates] = useState<AtCandidate[]>([]);
  // @ 候选拉取中(首次 @ 时异步加载,菜单显示"正在列出工作区文件…")
  const [atLoading, setAtLoading] = useState(false);
  // 名称 -> 引用解析:选中 @文件名 时记录其完整路径与来源,发送时据此替换为 @source:path。
  // 文本区始终只显示 @名称(普通可编辑文本),路径不进入输入框。
  const atMapRef = useRef<Map<string, { path: string; source: 'remote' | 'local' }>>(new Map());
  // 光标处正在编辑的 @词 区间(菜单打开时记录):选中候选按该区间替换,
  // 这样在已有文字中间补全引用也不会动到光标后面的内容。
  const atTokenRef = useRef<{ start: number; end: number } | null>(null);
  // 把带路径的正文(回退的历史消息 / 撤回编辑的队列消息)还原到输入框:
  // 只显示 @文件名,并把 名称->{路径,来源} 重新登记,再次发送时才能序列化回完整路径。
  const restoreInputMentions = (raw: string) => {
    const r = restoreMentionInput(raw || '');
    for (const ref of r.refs) atMapRef.current.set(ref.name, { path: ref.path, source: ref.source });
    updateInput(r.text);
  };
  // 候选只拉取一次(避免每次输入 @ 都请求;工作区切换后重新拉取)
  const atLoadedRef = useRef(false);
  // 候选拉取令牌:工作区切换时递增,使在途的旧工作区候选失效(避免晚到的响应覆盖新工作区)
  const atFetchTokenRef = useRef(0);
  const [agentState, setAgentState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  // 会话切换加载指示:切换期间保留上一会话内容 + 顶部提示,历史到达后再整体替换,避免空白闪烁
  const [switching, setSwitching] = useState(false);
  // 子智能体会话的运行记录信息(mode/resident):一次性派发要把输入位换成只读说明,
  // 不常驻(服务重启过)要在输入卡上方提示"再发一条会把它冷恢复过来"
  const [childInfo, setChildInfo] = useState<{ mode: string; resident: boolean } | null>(null);
  const refreshChildInfo = useCallback(() => {
    const target = activeRef.current;
    if (!childMode || !target || target === NEW_SESSION_ID) return;
    api.request('subagent_get', { runId: target }, 8000, 'subagent_run')
      .then((r: any) => setChildInfo(r?.run ? { mode: String(r.run.mode ?? 'continuable'), resident: r.run.resident !== false } : null))
      .catch(() => { /* 拉不到就按"可继续"处理,发送失败时服务端会给出确切原因 */ });
  }, [childMode]);
  // 抑制入场动画:历史整表载入(挂载/切换会话/后台刷新)时给 .chat 加 no-anim,
  // 连最新一条消息的 msg-in 淡入也不播——切换瞬间就该是静止的成品画面;
  // 只有用户实时发送(start 追加新消息)才解除,让新消息保留浮现动效
  const [suppressIn, setSuppressIn] = useState(true);
  // 会话历史缓存:切回已加载过的会话时秒开(零网络),后台静默刷新保持最新
  const histCache = useRef(new Map<string, { msgs: ChatMessage[]; todos: TodoItem[] }>());
  // 模型提问挂起(ask_user_question):未作答前锁定输入框与停止按钮
  const [askPending, setAskPending] = useState(false);
  // 启动检查期(刷新后 AskPanel 拉取挂起提问期间):期间输入区先不渲染,
  // 避免有挂起提问时"输入框先出现、面板恢复后再整体替换"的一瞬间抖动
  const [askChecking, setAskChecking] = useState(true);
  // 新会话草稿态发送成功后:跳过随后 sid 变化触发的历史回载(首条消息由事件流渲染)
  const skipHistoryOnceRef = useRef(false);
  // 待执行消息队列(工作中发送的消息,显示在输入框上方,当前轮结束后按 FIFO 自动执行)
  const [queue, setQueue] = useState<QueueItem[]>([]);
  // 服务端 context_usage 事件:实际请求 token(provider 上报)/ 折叠后预估 / 窗口。
  // 仪表盘优先显示该口径;切换会话后清空,回退到前端估算直到下一个事件到达。
  const [ctxUsage, setCtxUsage] = useState<ContextUsage | null>(null);
  // 回合过程折叠行的展开状态,按消息下标记。默认收起(与 dsh 一致:完成对话后过程是收起来的)。
  // 纯 UI 瞬时状态,不持久化;切换会话/重载历史时按新下标自然复位。
  const [procFoldOpen, setProcFoldOpen] = useState<Record<number, boolean>>({});
  // 本轮开始时刻(毫秒)。与结束事件一起算出「已完成,用时 X」的折叠行文案。
  // 实时路径自己打戳、历史路径用服务端 turn/start→turn/end 的耗时 —— 两者口径一致:
  // 都取"至少 1 秒"(服务端 max(1000, …)),所以刷新前后不会显示成不同的时长。
  const turnStartRef = useRef(0);
  /** 给末条 assistant 打上本轮的耗时与结束原因(与 attachTurnFileChanges 同一处收尾) */
  const stampTurnEnd = (msg: any, reason: string) => {
    const t0 = turnStartRef.current || Date.now();
    msg.turnElapsedMs = Math.max(1000, Date.now() - t0);
    msg.turnEndReason = reason;
  };
  // 统计栏数据:服务端 fold 整个会话事件日志得出(get_history 回填 + session_stats 事件增量更新)。
  // 与 ctxUsage 分开:ctxUsage 是"本步请求"的口径,这里是"整个会话累计"的口径。
  const [sessionUsage, setSessionUsage] = useState<TokenUsageTotals | null>(null);
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [reasoning, setReasoning] = useState(() => {
    // 迁移旧设置:以前独立存的 thinkingMode=off 等价于现在的推理等级 off;其余回落到 high/默认
    const tm = localStorage.getItem('sshai.thinkingMode');
    const saved = localStorage.getItem('sshai.reasoning') || localStorage.getItem('sshai.thinking') || '';
    if (tm === 'off' || saved === 'off') return 'off';
    if (saved === 'max' || saved === 'low' || saved === 'xhigh') return saved;
    return 'default';
  });
  // 访问权限模式(变更前确认/自动编辑/计划模式/完全访问):会话级开关,服务端权威。
  // 初值/切会话后由 get_history 的 permissionMode 回填,运行中的切换经 permission_changed 广播同步;
  // 新会话草稿态先取全局默认(permission_default_get),发送时随 session_create 落地
  const [permMode, setPermMode] = useState<PermissionMode>('confirm');
  const permTouchedRef = useRef(false); // 草稿态用户是否手动改过权限档位(避免把服务端默认误当"用户选择"提交)
  // 会话级长期目标(移植自 harness 的 goal 投影):get_history 的 goal 字段回填,
  // goal_changed 事件实时同步;目标条据此渲染,命令卡由 /目标 的 RPC 结果驱动。
  const [goal, setGoal] = useState<GoalInfo | null>(null);
  const [goalPending, setGoalPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // ---- 自动触底(吸附底部)控制 ----
  // stick=true 时流式更新/消息变化跟随触底;用户手动上滑离开底部即暂停(方便回看上下文),
  // 重新滚回底部、发送消息或切换会话时恢复。程序化 scrollTop 赋值同样会触发 scroll 事件,
  // 用 progRef 标记本次滚动来自代码(只在确实改变 scrollTop 时置位,防止残留标志吞掉真实手势)。
  const stickRef = useRef(true);
  const progRef = useRef(false);
  // 真实用户滚动输入的"有效期"(performance.now() 时间戳):滚轮、触摸滑动、键盘滚动键、
  // 拖动自绘滚动条拇指、点击跳转点都会续期。只有落在有效期内的滚动才被当作"用户上滑离底"。
  // 为什么不能只看 scroll 事件:滚动事件本身分不清来源——切会话时内容整段替换,
  // .msg 的 content-visibility 占位高度与真实高度不一致,浏览器会自行钳制 scrollTop
  // (旧 scrollTop 超出新内容高度)或调整滚动锚定,这些都会发 scroll 事件,而且因为
  // 本组件那次程序化赋值并没有真正改变 scrollTop,progRef 挡不住它们。旧实现把这类
  // 引擎驱动的滚动误判成用户上滑 → stick=false → 切换会话的触底兜底(chip 与常驻
  // ResizeObserver 都以 stick 为前提)立刻放弃,界面就停在中间/顶部(实测距真实底部
  // 2000~8000px,并亮出「回到底部」按钮),这就是"切会话经常没落到底部"的根因。
  const userScrollUntilRef = useRef(0);
  // 离开底部时显示"回到底部"悬浮按钮(流式期间内容持续增长,靠按钮一键返回)
  const [showJump, setShowJump] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null); // chatwrap:聊天滚动条拇指的宿主(整列高度,含输入区区域)
  const taRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null); // 高亮叠加层(与 textarea 滚动同步)
  const composerBoxRef = useRef<HTMLDivElement>(null); // 输入卡锚点:供 Slash/At 菜单 portal 到 body 后做 fixed 定位
  const userMsgRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [activeDot, setActiveDot] = useState(-1);
  // 轮次导轨(照搬 harness TurnNavigator 的手感):previewDot = 指针/键盘焦点所在刻度的下标,
  // dotPreviewCenter = 该刻度中心相对导轨顶部的 y(预览卡据此定位,在刻度间平滑迁移);
  // dotScrollTop/dotFade 驱动导轨自身的端点渐隐遮罩。
  const [previewDot, setPreviewDot] = useState<number | null>(null);
  const [dotPreviewCenter, setDotPreviewCenter] = useState(0);
  const [dotScrollTop, setDotScrollTop] = useState(0);
  const [dotFade, setDotFade] = useState({ top: false, bottom: false });
  const dotScrollerRef = useRef<HTMLDivElement | null>(null); // 导轨内部滚动容器
  const dotRefs = useRef<(HTMLButtonElement | null)[]>([]);   // 每条刻度:预览定位读它的 offsetTop
  const dotPointerInsideRef = useRef(false);                  // 指针在导轨内时不做自动跟随(harness 同款)
  const dotPreviewId = React.useId();                         // 预览卡 id:刻度用 aria-describedby 关联(harness 同款)
  const hasLive = useRef(false); // 用户已发起新对话时置 true,避免历史覆盖新消息
  const justSwitchedRef = useRef(false); // 会话切换后标记一次:绘制完成后再强制滚底+重绘拇指
  const switchSeqRef = useRef(0); // 会话切换序号:兜底 effect 用它识别"本会话"的兜底;快速切换时旧兜底立即作废且不吞标志
  const settleSeqRef = useRef(-1); // 已做过"全量真实布局预热"的切换序号:同序号下的批渲染(刷新/流式追加)不重复预热
  const settledMsgNodesRef = useRef(new WeakSet<Element>()); // 已写入精确 contain-intrinsic-size 的 .msg 节点(随切换重置)
  const anchoredSidRef = useRef<string | null>(null); // 已成功"锚定到底部"的会话 id:切换兜底据此识别"内容已换会话但标志漏置"
  // 分支点计数器:本会话"消息面 turn"计数,与服务端 projectEvents 投影出的 turns 数组
  // 索引对齐(0 基)。历史载入后以 turns 长度为基准,流式事件逐条递增——
  // 保证"空会话直接连续对话"时每条渲染消息也能拿到准确的分支索引。
  const forkTurnRef = useRef(0);
  const lastIterRef = useRef(0); // 最近一次 iteration 编号(truncate 重开会重复同值,用于去重)
  const llm = useLlm();
  const { confirm, toast } = useFeedback();

  // 多会话并行:事件按 sid 路由,本视图只显示当前活跃会话的流
  const activeRef = useRef<string | null>(sid);
  activeRef.current = sid;
  const busyRef = useRef(busy); // 切换到运行中的会话时,历史载入后把末条 assistant 标记为流式中
  busyRef.current = busy;
  // 本轮是否已经收尾(done/error/stopped)。重试事件属于「还没结束」,必须据此把回复气泡
  // 保持在流式态,收尾产物(已修改文件卡 / 复制 / 分支)才不会在重试途中冒出来;
  // 反过来,ws 断线补发(见 server/core/ws.ts 的 pendingEvents/flushPending)可能在重连后
  // 重放一条陈旧的重试事件,那时本轮其实已经结束,不能靠它把气泡重新点亮成流式。
  const turnClosedRef = useRef(false);

  const changeReasoning = (lv: string) => {
    setReasoning(lv);
    localStorage.setItem('sshai.reasoning', lv);
  };

  // 切换访问权限模式:乐观更新,服务端确认(permission_set 成功 + permission_changed 广播)
  // 即最终态;请求失败回滚并提示(模式以服务端事件日志为准,避免界面与实际放行口径脱节)。
  // 草稿态(新会话/尚未激活)没有可写的目标:仅记在本地,等 send() 里 session_create
  // 成功后随新会话提交,避免对不存在的会话发 permission_set 报错
  const changePermMode = (mode: PermissionMode) => {
    const prev = permMode;
    permTouchedRef.current = true; // 用户显式选择(草稿态发送时据此决定是否提交 permission_set)
    setPermMode(mode);
    if (sid == null || sid === NEW_SESSION_ID) return;
    api.request('permission_set', { mode, sid: sidArg(sid) }, 8000)
      .catch((e) => {
        setPermMode(prev);
        toast.error(`切换权限模式失败: ${(e as Error).message}`);
      });
  };

  // ---- 聊天附件(图片/文件):粘贴、拖拽与"+"号上传 ----
  // 草稿附件仅存内存(上传拿到服务端 id 后随 speak 发送,不进输入草稿);
  // 图片缩略图在上传前后都用本地 objectURL 预览(上传完成换服务端 URL 会闪烁,发送时统一回收)。
  // 多模态开关(设置 → AI 配置 → 模型「多模态」)决定能否添加/发送图片。
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [lightbox, setLightbox] = useState<LightboxSrc | null>(null);

  /**
   * 成果物卡「打开文件」:通道选择 + 路径补全。
   *
   * 通道:服务端在 present 落盘时就判定了归属侧(meta.local),优先用它 ——
   * 相对路径靠前缀是猜不出来的;旧会话的历史数据没有该字段,才回落到
   * "路径落在本机工作区就是本机,否则远程"的推断。
   * 补全:相对路径必须按该侧工作区补成绝对路径 —— 本机媒体预览走 `/api/media`
   * (那条接口只认绝对路径,相对路径会落到服务进程的 cwd 上,表现为"图片明明在却
   * 报媒体加载失败"),远程走 SFTP 同理。
   */
  const openDeliverable = (f: PresentedFile, aside: boolean) => {
    const base = connected ? workspace : localWorkspace;
    const isLocal = f.local ?? (!!localWorkspace && (!connected || !!base && f.path.startsWith(localWorkspace)));
    const full = resolveWorkspacePath((isLocal ? localWorkspace : base) ?? undefined, f.path);
    if (isLocal) (aside ? onOpenLocalFileAside : onOpenLocalFile)?.(full);
    else (aside ? onOpenFileAside : onOpenFile)?.(full);
  };
  // 当前会话是否有生图请求在途:把"正在生成图片"并入对话流末尾那条统一的运行状态行
  // (不再在气泡内单独占一行)。image_job 置位,image_done / 轮次收尾时清位回到
  // 「Agent 正在运行…」。生图是非流式的数十秒等待,这行让"仍在跑"始终可见。
  // 按会话记账:状态行只反映「当前活跃会话」的生图进度——切到别的会话必须换回该会话
  // 自己的文案(通常是「Agent 正在运行…」),切回仍在生图的会话时再恢复「正在生成图片」。
  const imgJobsRef = useRef(new Map<string, { mode: 't2i' | 'i2i'; refs: number }>());
  // owner = 这条在途生图标记归属的会话 id(null 表示事件未带 sid):渲染时据此挡掉
  // 切会话那一帧的旧文案(切会话的复位在 effect 里,晚于提交,会先画一帧)
  const [imgJob, setImgJob] = useState<{ owner: string | null; mode: 't2i' | 'i2i'; refs: number } | null>(null);
  // 写入 targetSid 的在途生图标记(null 表示销账);仅当目标会话正是当前查看的会话时,
  // 才同步到 imgJob 状态驱动状态行,后台会话只改记账表、不改变屏幕上的文案。
  const setSessionImgJob = (targetSid: string | null | undefined, job: { mode: 't2i' | 'i2i'; refs: number } | null) => {
    if (targetSid && targetSid !== NEW_SESSION_ID) {
      if (job) imgJobsRef.current.set(targetSid, job);
      else imgJobsRef.current.delete(targetSid);
    }
    if (!targetSid || targetSid === activeRef.current) setImgJob(job ? { owner: targetSid ?? null, ...job } : null);
  };
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const attSeqRef = useRef(0); // 附件本地 key 自增
  const addWrapRef = useRef<HTMLDivElement>(null); // "+"按钮与菜单容器(外部点击关闭菜单)
  const imgInputRef = useRef<HTMLInputElement>(null);   // 图片选择(accept=image/*)
  const fileInputRef = useRef<HTMLInputElement>(null);  // 任意文件选择
  // 当前模型是否具备多模态(看图)能力:由提供方配置里逐模型声明
  const multimodal = llm.effModelContext?.multimodal === true;
  // 生图模型(imageGen):本轮对话整体走 /images/*,用户发的图是「图生图的参考图」,
  // 因此上传闸门必须一并放开 —— 只看 multimodal 会把生图模型的参考图入口堵死
  const imageGen = llm.effModelContext?.imageGen === true;
  // 「/图生图」「/生图」命令:即使对话模型不是多模态,也允许附带图片作为生图参考图。
  // 图片字节不会发给对话模型(那会让不支持视觉的上游直接报错),只把附件 id 以文本
  // 告知模型,由它转交 generate_image 工具 —— 参考图的实际读取发生在服务端。
  const i2iCommand = /(?:^|\s)\/(?:图生图|生图|文生图|i2i|t2i|genimage)(?=\s|$)/i.test(input);
  const canSendImage = multimodal || imageGen || i2iCommand;
  // 被拦下时给用户的指引:两个开关都关、且没用 /图生图 命令时才会走到这里
  const imgGateTip = '当前模型不支持图片输入。可在输入框开头加 /图生图 附参考图走生图工具,'
    + '或到「设置 → AI 配置」开启该模型的「多模态」/「生图」开关';
  const attPending = attachments.some((a) => a.uploading); // 仍在上传中(禁发)
  const attFailed = attachments.some((a) => !!a.error);    // 有上传失败项(须先移除)

  // 收纳文件:分类 → 本地预览 → 立即上传(逐个独立,失败只影响自身);
  // 图片仅在多模态模型下接受,其余类型(文件)不受限
  const intakeFiles = (files: File[]) => {
    // 子智能体会话不支持附件(服务端会拒绝):连上传入口一起关掉,别让用户白等一次上传
    if (childMode) return;
    const list = files.filter(Boolean);
    if (!list.length) return;
    const room = 10 - attachments.length;
    if (room <= 0) { toast.warning('一条消息最多 10 个附件'); return; }
    for (const file of list.slice(0, room)) {
      const kind = classifyKind(file.type, file.name);
      if (kind === 'image' && !canSendImage) {
        toast.warning(imgGateTip);
        continue;
      }
      const key = `att${++attSeqRef.current}`;
      const previewUrl = kind === 'image' ? URL.createObjectURL(file) : '';
      const item: ComposerAttachment = {
        key,
        name: file.name || (kind === 'image' ? `粘贴图片.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}` : '未命名文件'),
        mime: file.type || 'application/octet-stream',
        size: file.size,
        kind,
        uploading: true,
        previewUrl
      };
      setAttachments((prev) => [...prev, item]);
      const fd = new FormData();
      fd.append('files', file, file.name || item.name);
      fetch('/api/attachments', { method: 'POST', body: fd })
        .then(async (r) => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          const att: AttachmentInfo | undefined = j.attachments?.[0];
          if (!att) throw new Error('服务端未返回附件信息');
          return att;
        })
        .then((att) => setAttachments((prev) => prev.map((x) => (x.key === key ? { ...x, uploading: false, att } : x))))
        .catch((e) => {
          setAttachments((prev) => prev.map((x) => (x.key === key ? { ...x, uploading: false, error: (e as Error).message } : x)));
          toast.error(`附件上传失败:${(e as Error).message}`);
        });
    }
  };
  // 移除单个草稿附件(回收本地预览的 objectURL)
  const removeAttachment = (item: ComposerAttachment) => {
    if (item.previewUrl.startsWith('blob:')) { try { URL.revokeObjectURL(item.previewUrl); } catch {} }
    setAttachments((prev) => prev.filter((x) => x.key !== item.key));
  };
  // 清空全部草稿附件(发送成功/切换会话时调用)
  const clearAttachments = () => {
    setAttachments((prev) => {
      for (const x of prev) if (x.previewUrl.startsWith('blob:')) { try { URL.revokeObjectURL(x.previewUrl); } catch {} }
      return [];
    });
  };
  // 点击"+"菜单外部时关闭(与工作区 chip 弹窗同款交互)。
  // 菜单本体 portal 到 body(脱离 composer-box 的 backdrop-filter,否则 Chromium
  // 不应用其 backdrop-filter,玻璃磨砂失效),portal 节点的点击同样视为内部区域
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (addWrapRef.current && addWrapRef.current.contains(t)) return;
      if (t instanceof Element && t.closest('.add-menu')) return;
      setAddMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [addMenuOpen]);

  // 输入框自适应高度(主流聊天工具样式:单行起步,随内容增高)
  const autoGrow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  };
  // 高亮叠加层与 textarea 滚动同步(内容超过 max-height 出现滚动时保持对齐)
  const syncOverlayScroll = () => {
    const el = taRef.current;
    const ov = overlayRef.current;
    if (el && ov) ov.scrollTop = el.scrollTop;
  };
  useEffect(() => { autoGrow(); syncOverlayScroll(); }, [input]);

  // 工作区切换(远程或本地)后 @ 候选与解析失效:下次打开 @ 时重新拉取,
  // 已记录的 @名称->路径 解析一并作废(路径可能已随工作区变化)
  useEffect(() => {
    atLoadedRef.current = false;
    atFetchTokenRef.current += 1; // 使在途候选失效
    atMapRef.current.clear();
    setAtCandidates([]);
  }, [workspace, localWorkspace, noWorkspace, localNoWorkspace]);

  // 文件面板目录变化后 @ 候选失效:下次打开 @ 时按新目录重新拉取
  // (@ 菜单跟随文件管理器当前打开的目录,而非工作区根)
  useEffect(() => {
    atLoadedRef.current = false;
    atFetchTokenRef.current += 1; // 使在途候选失效
    setAtCandidates([]);
  }, [remoteCwd, localCwd]);

  const push = (fn: (m: ChatMessage[]) => ChatMessage[]) => setMessages(fn);
  // 渲染期同步最新消息:供「WS 重连后状态校准」读取,避免 effect 闭包拿到过期数据
  const msgRef = useRef(messages);
  msgRef.current = messages;
  // 首次连接(页面加载,历史尚在加载中)不做重连校准,已在线上线后才视为"重连"
  const everConnectedRef = useRef(false);
  // 子智能体会话:挂载/切换 runId 时拉一次运行记录信息(模式 + 是否常驻)
  useEffect(() => { refreshChildInfo(); }, [sid, refreshChildInfo]);

  useEffect(() => {
    const subs = [
      api.on('history_cleared', () => {
        histCache.current.delete(activeRef.current ?? ''); // 清空后旧缓存失效,下次切换重新拉取
        setMessages([]);
        setQueue([]); // 历史清空:待执行队列一并复位
        setSessionImgJob(activeRef.current, null); // 历史清空:在途生图标记一并销账
        setTodos([]); // 任务计划一并复位(日志已清空,残留计划会一直显示在面板上)
      }),
      api.on('agent', (m: any) => {
        // 在途生图标记先按会话记账(后台会话也要处理):image_done 若只认活跃会话,
        // 切走期间完成的生图会在记账表里留成"在途",切回时状态行停在过期的「正在生成图片」
        // 多会话并行:只处理当前活跃会话的事件,其他会话(后台运行中)的流不进入本视图;
        // 新会话草稿态(sid 为占位符或尚未定向)无真实会话,丢弃所有带 sid 的事件,避免串入旧会话流
        if (m.event === 'image_job' || m.event === 'image_done') {
          setSessionImgJob(m.sid || activeRef.current, m.event === 'image_job'
            ? { mode: m.mode === 'i2i' ? 'i2i' : 't2i', refs: Number(m.refs) || 0 }
            : null);
        }
        if (m.sid && (activeRef.current == null || activeRef.current === NEW_SESSION_ID || m.sid !== activeRef.current)) return;
        switch (m.event) {
          case 'status':
            setAgentState(m.status === 'running' ? 'working' : 'idle');
            // 子智能体会话:状态变化时刷新一次运行记录(冷恢复后 resident 会变 true)
            if (childMode) refreshChildInfo();
            if (m.status !== 'running') {
              setSessionImgJob(activeRef.current, null); // 会话已空闲:在途生图标记必须一并清掉(兜底,防状态行卡死)
              push((msgs) => {
                const c = dropStaleCompaction([...msgs]);
                // 本轮还挂着「等待重试」的行(重试行可能夹在回复气泡之间,不再是列表末尾):
                // 这一步失败后正在退避等待重发,本轮并没有结束。此时不能解除流式,否则渲染层
                // 会立刻把「已修改文件」卡与复制/分支按钮当成收尾产物显示出来(用户明确要求:
                // 重试途中不出现这些)。真正结束由 done/error/stopped 收尾,它们会自行置回 false。
                let pendingRetry: ChatMessage['retry'] | undefined;
                for (let i = c.length - 1; i >= 0; i--) {
                  if (isRealUserRow(c[i])) break;
                  const rt = c[i]?.retry;
                  if (rt) { pendingRetry = rt; break; }
                }
                const retryPending = !!pendingRetry && pendingRetry.state === 'scheduled';
                if (!retryPending) {
                  const li = tailAssistantIndex(c);
                  if (li >= 0 && c[li].streaming) c[li].streaming = false;
                }
                return c;
              });
            }
            break;
          case 'queue_update':
            // 待执行队列整表快照(新增排队/立即执行/删除/自动派发都会触发)
            setQueue(Array.isArray(m.queue) ? m.queue : []);
            break;
          case 'start':
            hasLive.current = true;
            // 本轮的用户消息/app 回复行马上要追加到屏幕上:内容已是本会话的。
            // 这行的另一个用处:切会话时历史回载还在路上就来了 start(hasLive 会挡掉回载),
            // 屏幕上是"上一会话残留 + 本会话新轮"的混合,但**最后一条真实 user 消息**是本轮的,
            // 计时器认它才准;不认就只剩"从切换那一刻起算"的错值。
            setMsgsSid(activeRef.current);
            turnStartRef.current = Date.now(); // 回合计时起点(折叠行「已完成,用时 X」用)
            turnClosedRef.current = false; // 新一轮开始:重新进入「未收尾」状态
            // 本轮首条 user/message 计入分支点计数
            forkTurnRef.current += 1; lastIterRef.current = 0;
            setAgentState('working'); setErrorMsg('');
            // 新一轮:只作废"已全部完成"的计划(面板本就因全完成而隐藏);仍有未完成项
            // 则原样保留显示——与后端 foldTodos 的跨轮存活规则一致,模型侧由后端把剩余
            // 计划拼进本轮指令续推;模型若另写新计划,后续 todo_update 会整表替换。
            setTodos((prev) => (prev.some((t) => t.status !== 'completed') ? prev : []));
            setSuppressIn(false); // 实时追加的新消息:解除入场动画抑制,保留浮现动效
            setSessionImgJob(activeRef.current, null); // 新一轮开始:上一轮的在途生图标记一律作废
            push((msgs) => [...msgs, { role: 'user', content: m.text, attachments: Array.isArray(m.attachments) ? m.attachments : undefined, time: Date.now(), source: m.source, forkTail: Math.max(0, forkTurnRef.current - 1) }]);
            push((msgs) => [...msgs, { role: 'assistant', segments: [], streaming: true, forkTail: Math.max(0, forkTurnRef.current - 1) }]);
            break;
          case 'context_usage':
            // 服务端每步请求后广播的上下文用量(实际/预估/窗口):仪表盘权威口径。
            // systemTokens/toolsTokens/messageTokens 是服务端给出的分项(与压缩阈值同源),
            // 旧版服务端不发这三项,前端回退到本地估算分项(见 ContextMeter)。
            setCtxUsage({
              estimated: Number(m.estimated) || 0,
              actual: typeof m.actual === 'number' ? m.actual : null,
              output: typeof m.output === 'number' ? m.output : null,
              window: Number(m.window) || 0,
              systemTokens: typeof m.systemTokens === 'number' ? m.systemTokens : undefined,
              toolsTokens: typeof m.toolsTokens === 'number' ? m.toolsTokens : undefined,
              messageTokens: typeof m.messageTokens === 'number' ? m.messageTokens : undefined
            });
            break;
          case 'session_stats':
            // 服务端每步末 fold 整个会话日志后广播(用量四桶 + 对话统计)。
            // 只用于展示,缺字段时保持上一次的值而不是清零。
            if (m.usage && typeof m.usage === 'object') setSessionUsage(m.usage as TokenUsageTotals);
            if (m.stats && typeof m.stats === 'object') setSessionStats(m.stats as SessionStatsInfo);
            break;
          case 'skill_loaded':
            // 用户 `/技能名` 直接调用技能:正文由服务端注入本轮消息,这里把技能记录挂到刚推入的
            // 用户气泡上,渲染「已加载技能」行(模型主动调用 skill 工具走工具卡片,两条路径都要可见)
            if (Array.isArray(m.skills) && m.skills.length) {
              push((msgs) => {
                const c = [...msgs];
                for (let k = c.length - 1; k >= 0; k--) {
                  // 挂到最近一条「真正的用户消息」上(压缩标记行的 role 也是 'user',不算)
                  if (isRealUserRow(c[k])) { c[k] = { ...c[k], skillsInjected: m.skills }; break; }
                }
                return c;
              });
            }
            break;
          case 'todo_update':
            // todo_write 工具写入的任务计划整表快照
            setTodos(Array.isArray(m.todos) ? m.todos : []);
            break;
          case 'permission_changed':
            // 访问权限模式切换广播(任意前端/任意窗口发起,服务端确认后下发):
            // 只作用于当前正在查看的会话,其他会话的模式在切回时经 get_history 回填
            if (m.sid && m.sid === activeRef.current && isPermissionMode(m.mode)) setPermMode(m.mode);
            break;
          case 'goal_changed':
            // 长期目标变更广播(命令 / 模型工具 / 自动续跑轮的上限受阻都会发):
            // 只作用于当前正在查看的会话,其他会话的目标在切回时经 get_history 回填
            if (!m.sid || m.sid === activeRef.current) setGoal((m.goal ?? null) as GoalInfo | null);
            break;
          case 'steer_message':
            // 运行中送达的非人类通知(子代理结算等,见 dsh 的 notifySettlement → steer):
            // 它属于**正在跑的这一轮**,不是排队等下一轮的用户输入。此刻把通知行插进本轮,
            // 并另起一条 assistant 行承接后续步骤 —— 与刷新后服务端投影出的行序完全一致
            // (projectEvents 给这条日志行打 inline 标记,前端同样按"轮内通知行"渲染)。
            if (!m.sid || m.sid === activeRef.current) {
              forkTurnRef.current += 1; // 它在日志里是一条 user/message,分支点计数与刷新口径对齐
              push((msgs) => [...msgs,
                { role: 'user', content: m.text, source: m.source, inline: true, time: m.time || Date.now(), forkTail: Math.max(0, forkTurnRef.current - 1) },
                { role: 'assistant', segments: [], streaming: true, forkTail: Math.max(0, forkTurnRef.current - 1) }
              ]);
            }
            break;
          case 'iteration':            // 每次迭代对应一条 assistant/message turn;truncate 重开会重复相同 iter,去重
            if (m.iter !== lastIterRef.current) {
              forkTurnRef.current += 1; lastIterRef.current = m.iter;
              push((msgs) => {
                const c = [...msgs];
                const li = tailAssistantIndex(c);
                if (li >= 0) {
                  const l = c[li];
                  l.forkTail = forkTurnRef.current - 1;
                  // 记录本步起点:这一步的模型请求若中途失败并重试,前端要把本步已流出的半成品整段回滚
                  l.stepSegBase = (l.segments || []).length;
                }
                return c;
              });
            }
            break;
          case 'text_delta':
            push((msgs) => {
              const copy = markRetryStarted([...msgs]);
              const li = tailAssistantIndex(copy);
              if (li >= 0) appendText(copy[li], m.text);
              return copy;
            });
            break;
          case 'reasoning_delta':
            // 思考内容增量(推理模型的 reasoning 通道):按到达顺序落为独立段,
            // 后续步骤的思考自然出现在上一组工具调用之后,而不是全堆在消息开头
            push((msgs) => {
              const copy = markRetryStarted([...msgs]);
              const li = tailAssistantIndex(copy);
              if (li >= 0) appendReasoning(copy[li], m.text);
              return copy;
            });
            break;
          case 'tool_call':
            push((msgs) => {
              const copy = markRetryStarted([...msgs]);
              const li = tailAssistantIndex(copy);
              const last = li >= 0 ? copy[li] : undefined;
              // 断线补偿(服务端补发)时同一 callId 可能已被实时事件渲染过,按 id 去重避免重复卡片。
              // 不可变更新(新 segments/tools 数组):配合工具列表 memo,
              // 只有本段真正变化时才重渲染,其余历史段原样跳过
              if (last
                && !(last.segments || []).some((s) => s.kind === 'tools' && (s.tools || []).some((t) => t.id === m.callId))) {
                const segs = last.segments || [];
                const newCall: ToolCallInfo = { id: m.callId, tool: m.tool, args: m.args, ok: undefined, ms: undefined, result: undefined };
                const newSegs = segs.length && segs[segs.length - 1].kind === 'tools'
                  ? [...segs.slice(0, -1), { ...segs[segs.length - 1], tools: [...(segs[segs.length - 1].tools || []), newCall] }]
                  : [...segs, { kind: 'tools' as const, tools: [newCall] }];
                copy[li] = { ...last, segments: newSegs };
              }
              return copy;
            });
            break;
          case 'tool_result':
            // 每条工具结果对应一条 tool/result turn,分支点推进到最后落定的结果
            forkTurnRef.current += 1;
            push((msgs) => {
              const copy = [...msgs];
              const li = tailAssistantIndex(copy);
              const last = li >= 0 ? copy[li] : undefined;
              if (last && Array.isArray(last.segments)) {
                // 不可变更新:替换目标工具对象与所在组数组,使工具列表 memo 正确感知变化
                const patch = { ok: m.ok, ms: m.ms, result: m.result, meta: m.meta, attachments: m.attachments };
                let segIndex = -1;
                for (let i = last.segments.length - 1; i >= 0; i--) {
                  if (last.segments[i].kind === 'tools') { segIndex = i; break; }
                }
                const newSegs = segIndex >= 0
                  ? last.segments.map((s, i) => {
                      if (i !== segIndex) return s;
                      const tools = s.tools || [];
                      const byId = m.callId ? tools.find((x) => x.id === m.callId) : null;
                      const target = byId || tools.find((x) => x.tool === m.tool && x.ok === undefined);
                      return target
                        ? { ...s, tools: tools.map((t) => (t === target ? { ...t, ...patch } : t)) }
                        : s;
                    })
                  : last.segments;
                copy[li] = { ...last, forkTail: forkTurnRef.current - 1, segments: newSegs };
              }
              return copy;
            });
            break;
          case 'image_job':
            // 生图请求已发出:把底部运行状态行切成"正在生成图片"。
            // 图像端点非流式,期间没有任何增量可吐,靠这行持续声明仍在等待。
            // 状态行已由事件入口按会话记账(见 api.on('agent') 开头),这里只把 pending 标记挂到气泡上
            push((msgs) => {
              const c = [...msgs];
              const li = tailAssistantIndex(c);
              if (li >= 0) {
                c[li] = { ...c[li], imageJob: { mode: m.mode === 'i2i' ? 'i2i' : 't2i', refs: Number(m.refs) || 0, pending: true } };
              }
              return c;
            });
            break;
          case 'image_done':
            // 成图落盘完成:状态行立刻回到「Agent 正在运行…」(后面可能还有正文要流式),
            // 附件元数据挂到当前 assistant 气泡,并逐批累加(一轮里连续生图多次时,先到的成图不能被后到的覆盖)
            // 状态行销账已由事件入口完成(见 api.on('agent') 开头)
            push((msgs) => {
              const c = [...msgs];
              const li = tailAssistantIndex(c);
              if (li >= 0) {
                c[li] = {
                  ...c[li],
                  ...(Array.isArray(m.attachments) && m.attachments.length ? { attachments: mergeAttachments(c[li].attachments, m.attachments) } : {}),
                  imageJob: { mode: m.mode === 'i2i' ? 'i2i' : 't2i', refs: Number(m.refs) || 0, ms: Number(m.ms) || 0, pending: false }
                };
              }
              return c;
            });
            scrollToBottomNow();
            break;
          case 'deliverable':
            // 成果物交付声明(present 工具):挂到当前 assistant 气泡,逐批累加。
            // 为什么实时也要处理:刷新能补上(走投影),但模型刚交付完的那一刻用户正盯着屏幕,
            // 等下一次刷新才出现卡片会显得"没反应"。
            push((msgs) => {
              const c = [...msgs];
              const li = tailAssistantIndex(c);
              if (li >= 0 && Array.isArray(m.files) && m.files.length) {
                c[li] = { ...c[li], deliverables: mergeDeliverables(c[li].deliverables, m.files) };
              }
              return c;
            });
            break;
          case 'done':
            setAgentState('done');
            turnClosedRef.current = true; // 本轮真正结束:此后重试事件不再把气泡点亮成流式
            setSessionImgJob(activeRef.current, null); // 本轮结束:状态行不再显示"正在生成图片"(成图失败时也不会卡住)
            push((msgs) => {
              const copy = dropEmptyRetryBubble([...msgs]);
              const li = tailAssistantIndex(copy);
              if (li >= 0) {
                const last = copy[li];
                last.streaming = false;
                stampTurnEnd(last, 'completed'); // 折叠行:已完成,用时 X
                // 文件变更汇总:所有 tool_result 已落定,聚合「N 个文件已更改」卡片数据
                // (本轮被重试拆成多段时汇总整轮,避免只统计重试之后的部分)
                attachTurnFileChanges(copy, li);
                // 最终文本通常已由 text_delta 流式拼好;这里只补上未流出的部分
                // (如达到最大迭代次数后追加的提示),避免重复
                const cur = segText(last);
                const doneText = m.text || '';
                // 只在 done 文本是「当前正文 + 未流出后缀」的顺延补差时才追加;
                // 服务端多步模式下 done.text 可能是最后一步正文(非当前正文前缀),
                // 整段追加会把已流式拼好的收尾重复一遍——宁可丢弃也不要重复
                const suffix = doneText.startsWith(cur) ? doneText.slice(cur.length) : '';
                if (suffix) appendText(last, suffix);
              }
              return copy;
            });
            break;
          case 'stopped':
            setAgentState('idle'); turnClosedRef.current = true; setSessionImgJob(activeRef.current, null);
            push((msgs) => {
              const c = dropEmptyRetryBubble([...msgs]);
              const li = tailAssistantIndex(c);
              if (li >= 0) { const l = c[li]; if (l.streaming) l.streaming = false; attachTurnFileChanges(c, li); stampTurnEnd(l, 'aborted'); }
              // 用户停下 Agent 时,尚在倒计时中的重试随之取消(对齐 harness llm/retry-started 的 cancelled 态)
              for (let i = c.length - 1; i >= 0; i--) {
                const rt = c[i]?.retry;
                if (rt && rt.state === 'scheduled') { c[i] = { ...c[i], retry: { ...rt, state: 'cancelled' } }; break; }
              }
              return c;
            });
            break;
          case 'error':
            setAgentState('error'); turnClosedRef.current = true; setErrorMsg(m.message); setSessionImgJob(activeRef.current, null);
            push((msgs) => {
              const c = dropEmptyRetryBubble([...msgs]);
              const li = tailAssistantIndex(c);
              if (li >= 0) { const l = c[li]; if (l.streaming) l.streaming = false; attachTurnFileChanges(c, li); stampTurnEnd(l, 'error'); }
              // 重试耗尽/不可重试的直接失败:倒计时中的重试随本轮中止取消(对齐 harness cancelled 态)
              for (let i = c.length - 1; i >= 0; i--) {
                const rt = c[i]?.retry;
                if (rt && rt.state === 'scheduled') { c[i] = { ...c[i], retry: { ...rt, state: 'cancelled' } }; break; }
              }
              return c;
            });
            break;
          case 'turn_end':
            // 轮末权威分支点(服务端 _runTurnInner/_runImageTurn 收尾后广播的 faceCount =
            // 该轮真正落盘后的消息面总长)。本地的 forkTurnRef 只是"猜":请求失败/中止的步,
            // 前端已按 iteration +1 但服务端不落 assistant/message;轮末自愈补的工具结果、
            // 生图轮的 image/generated 又只有服务端计数。猜漂了之后,下一条用户消息就带着错的
            // 下标去回退/删除,服务端命中的不是用户消息 —— 报「目标不是用户消息,无法回退」。
            // 这里以服务端口径重锚:计数器回到 faceCount,本轮回复气泡的分支点落到轮内最后一个消息面。
            if (typeof m.faceCount === 'number') {
              forkTurnRef.current = m.faceCount;
              push((msgs) => {
                const c = [...msgs];
                for (let i = c.length - 1; i >= 0; i--) {
                  if (c[i].role === 'assistant') {
                    // 权威耗时由服务端下发(与刷新后投影同一口径),覆盖 done/stopped/error
                    // 那几处按本地时刻打的近似值 —— 避免"刚跑完显示 1 秒、刷新后显示 2 分"的漂移
                    const el = typeof m.elapsedMs === 'number' ? m.elapsedMs : undefined;
                    // 本轮用量:与耗时同一处回填(统计行「用量 X tok + 用时」)。
                    // samples=0(整轮没报用量)时**不打戳**,与刷新后投影的"缺省"语义一致
                    const u = m.usage && typeof m.usage === 'object' && Number(m.usage.samples) > 0
                      ? m.usage as TokenUsageTotals : undefined;
                    c[i] = {
                      ...c[i],
                      forkTail: Math.max(0, m.faceCount - 1),
                      ...(el !== undefined ? { turnElapsedMs: el } : {}),
                      ...(u !== undefined ? { turnUsage: u } : {})
                    };
                    break;
                  }
                }
                return c;
              });
            }
            break;
          case 'notice':
            // 通知不打断流式中的 assistant 气泡:插到它前面,
            // 避免后续 text/reasoning 增量找不到目标消息(它们只认末尾的 assistant)
            // persisted=true:服务端已把它写进会话日志(占一个消息面下标),
            // 本地分支点计数器必须同步 +1,否则下一条用户消息会回退到错误的位置
            if (m.persisted === true) forkTurnRef.current += 1;
            push((msgs) => {
              const c = [...msgs];
              const li = tailAssistantIndex(c);
              if (li >= 0 && c[li].streaming) {
                c.splice(li, 0, { role: 'notice', content: m.text || '' });
              } else {
                c.push({ role: 'notice', content: m.text || '' });
              }
              return c;
            });
            break;
          case 'compaction_start':
            // 自动压缩开始(超水位/爆窗恢复要走摘要):摘要是一次真实的 LLM 请求,可能十几秒
            // 到几十秒。先在对话流里落一行运行态「正在把早期对话压缩为摘要…」,等 done 原地改写,
            // 而不是让界面在这段静默里什么都不显示。同一次压缩只保留一条运行行(重复 start 幂等);
            // 插入在流式 assistant 气泡之前:compaction/done 事件在日志里先于 assistant/message,
            // 服务端原位投影后标记行排在回复之前;这里保持一致,刷新/切回后位置不变。
            push((msgs) => {
              if (msgs.some((x) => x.compaction?.running)) return msgs;
              const c = [...msgs];
              const li = tailAssistantIndex(c);
              if (li >= 0) c.splice(li, 0, { role: 'user' as const, content: '', compaction: { running: true } });
              else c.push({ role: 'user' as const, content: '', compaction: { running: true } });
              return c;
            });
            scrollToBottomNow();
            break;
          case 'compaction_done':
            // 自动压缩完成:把上面那行运行态原地改写为「上下文压缩」完成态(条数 + 可展开摘要),
            // 不新增一行。从未收到 start(断线漏事件、切走再切回)时回退为追加到末尾。运行中不做
            // 整表重拉,避免打断正在流式的输出;刷新/切回会话后由 compaction/done 事件投影同款行。
            // m.at = 标记行在服务端消息面里的下标:标记行插在保留区首条消息面之前,会把下标
            // >= at 的既有分支点整体挤后一位。不平移的话,本轮早先推入的用户/回复气泡会带着旧下标,
            // 之后回退/删除就命中相邻的错误 turn(要么报错,要么悄悄回退错一轮)。
            if (typeof m.at === 'number') forkTurnRef.current += 1;
            push((msgs) => {
              const done = {
                content: m.summary || '【上下文已自动压缩】早期对话已省略。',
                compaction: { dropCount: Number(m.dropCount) || 0, manual: m.manual === true }
              };
              let idx = -1;
              for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].compaction?.running) { idx = i; break; } }
              const at = typeof m.at === 'number' ? m.at : -1;
              // 平移到新下标:标记行之前的分支点不动,之后的 +1(标记行自己占 at)
              const c = at < 0 ? [...msgs]
                : msgs.map((x) => (typeof x.forkTail === 'number' && x.forkTail >= at ? { ...x, forkTail: x.forkTail + 1 } : x));
              if (idx >= 0) { c[idx] = { ...c[idx], ...done, ...(at >= 0 ? { forkTail: at } : {}) }; return c; }
              // 无运行行(断线/切会话漏事件):插入在下标 at 处,与服务端原位投影一致,
              // 避免落到末尾(后续消息就排在它后面而非前面,与重载顺序一致)。
              const item: ChatMessage = { role: 'user' as const, ...done, ...(at >= 0 ? { forkTail: at } : {}) };
              const insertAt = at >= 0 ? Math.min(at, c.length) : c.length;
              return [...c.slice(0, insertAt), item, ...c.slice(insertAt)];
            });
            scrollToBottomNow();
            break;
          case 'compaction_failed':
            // m.persisted=true:服务端已把这条失败行落盘(占一个消息面下标),本地分支点计数器同步 +1
            if (m.persisted === true) forkTurnRef.current += 1;
            // 压缩未完成(摘要生成失败 / 无收益 / 为空):服务端**没有**裁剪任何历史。
            // 必须把上面那行运行态原地改写为失败态:否则「正在压缩…」会一直挂着转圈,
            // 而用户也完全不知道这一轮其实没压缩成——继续发消息就会直接撞上下文窗口。
            // 没有收到过 start(断线/切会话漏事件)时同样落一行,保证失败可见。
            push((msgs) => {
              const failedItem = {
                content: '',
                compaction: { running: false, failed: true, manual: m.manual === true, reason: String(m.reason || '摘要不可用') }
              };
              let idx = -1;
              for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].compaction?.running) { idx = i; break; } }
              const c = [...msgs];
              if (idx >= 0) { c[idx] = { ...c[idx], ...failedItem }; return c; }
              // 无运行行(断线/切会话漏事件):插入在流式 assistant 前(与 compaction_start 一致),
              // 找不到流式 assistant 时追加到末尾。
              const li2 = tailAssistantIndex(c);
              const fItem = { role: 'user' as const, ...failedItem };
              return li2 >= 0 ? [...c.slice(0, li2), fItem, ...c.slice(li2)] : [...c, fItem];
            });
            scrollToBottomNow();
            break;
          case 'retry':
            // 模型请求失败进入重试:渲染为 harness 风格的单行状态行(实时倒计时 + 可展开失败详情)。
            // 位置:把「失败发生的那一刻」当分界点 —— 当前回复气泡在失败点收尾,重试行紧跟其后,
            // 之后重新生成的内容流进一个新气泡。提示行因此夹在前后内容之间,而不是永远贴在整轮
            // 回复的最下面(与刷新后 turnsToMessages 的投影同一口径)。
            // 连续失败期间只占一行,原地更新计数;恢复输出后的下一次失败另起一行。
            // m.discard=true 表示这次失败前已经流出过内容:重试会重发这一步,必须先把它整段回滚,
            // 否则重试成功后的正文会和这段半成品拼在一起重复。
            // m.persisted=true:服务端已落库(占一个消息面下标),本地分支点计数器同步 +1。
            if (m.persisted === true) forkTurnRef.current += 1;
            push((msgs) => {
              const c = [...msgs];
              // discard:这次失败前已流出过内容 → 先回滚当前流式气泡的半成品,再落重试行
              if (m.discard === true) {
                for (let i = c.length - 1; i >= 0; i--) {
                  const msg = c[i];
                  if (msg?.role !== 'assistant' || !msg.streaming) continue;
                  msg.segments = rollbackPartialSegments(msg);
                  break;
                }
              }
              // 落点规则见 utils/compactionOrder 的 applyRetryNotice(首次重试在失败点拆开,
              // 连续失败原地更新,恢复后再次失败另起一行;陈旧事件不拆已收尾气泡)
              return applyRetryNotice(c, {
                retry: Number(m.retry) || 1,
                ...(typeof m.retryGroup === 'string' ? { retryGroup: m.retryGroup } : {}),
                maxRetries: Number(m.maxRetries) || 10,
                // 不再把 0 顶成 2000:换 Key(delayMs=0)是立即重发,显示「等待 2 秒」会误导
                // (历史回放走 projectEvents,那里本来也是 `|| 0`,两条路径口径要一致)
                delayMs: Math.max(0, Number(m.delayMs) || 0),
                error: String(m.error || '网络错误').slice(0, 120),
                discard: m.discard === true,
                ...(m.kind === 'switch' ? { kind: 'switch' as const } : {})
              }, { turnClosed: turnClosedRef.current, forkFaceIdx: forkTurnRef.current - 1 });
            });
            break;
          case 'history_compacted':
            // 手动压缩完成(/compact):后端已把早期消息替换为 compaction/done 摘要事件,
            // 这里整体重拉历史——被压缩的早期消息从视图中消失,压缩摘要以折叠标记行呈现
            // (样式参照 harness:CompactionItem 的标记行,而非用户气泡)。
            // 命令卡是纯前端消息(不持久化),整表替换会把它连同「已压缩 N 条早期消息…」
            // 完成态一起抹掉;这里把当前列表末尾的命令卡按原样接回,保证 patchCmd(cmdId)
            // 仍能命中、底部留下成功反馈(见 utils/commandCard 的成因说明)。
            {
              const targetSid = activeRef.current; // 本次重拉归属的会话:防止异步响应串到别的会话
              api.request('get_history', { sid: sidArg(targetSid) }, 8000)
                .then((h) => {
                  if (activeRef.current !== targetSid) return; // 重拉期间切走了:丢弃过期结果
                  const msgs = turnsToMessages(h.turns || []);
                  histCache.current.set(targetSid ?? '', { msgs, todos: Array.isArray(h.todos) ? h.todos : [] });
                  forkTurnRef.current = (h.turns || []).length; // 分支点/删除索引重新对齐压缩后的 turns
                  lastIterRef.current = 0;
                  setSuppressIn(true); // 整表替换:抑制入场动画,压缩瞬间画面保持静止
                  // 函数式更新读取最新 messages:命令卡上可能已落下 ok 态(先 patch 后重拉的时序)
                  setMessages((cur) => mergeTrailingCommandCards(msgs, cur));
                  setTodos(Array.isArray(h.todos) ? h.todos : []);
                })
                .catch(() => { /* 拉取失败保留当前视图,下次会话切换时会重新载入 */ });
            }
            break;
        }
      })
    ];
    return () => subs.forEach((off) => off());
  }, []);

  // WS 断线后状态补偿兜底:断线期间 agent 的 done/status 事件可能已丢失(缓冲补发覆盖不到的
  // 场景,如服务端进程重启),若服务端判定当前会话已空闲、但本会话末条回复仍标记"流式中",
  // 说明界面已进入永远等不到下一步的卡死态——整表校准解除 streaming 并补全最终内容。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = api.on('open', () => {
      if (!everConnectedRef.current) { everConnectedRef.current = true; return; } // 首次连接不校准
      if (timer) clearTimeout(timer);
      // 稍等片刻让服务端 flush 补发 + status 先落地,避免与已能正确解除 streaming 的场景冲突
      timer = setTimeout(() => {
        timer = null;
        if (busyRef.current) return; // 该会话仍在运行:补发/实时事件会继续驱动流,无需校准
        const last = msgRef.current[msgRef.current.length - 1];
        if (!last || last.role !== 'assistant' || !last.streaming) return;
        api.request('get_history', { sid: sidArg(activeRef.current) }, 8000)
          .then((h) => {
            const sid = activeRef.current;
            if (sid == null || sid === NEW_SESSION_ID) return;
            applyTurns(h);
          })
          .catch(() => { /* 校准失败保持现状,后续事件流不受影响 */ });
      }, 800);
    });
    return () => { if (timer) clearTimeout(timer); off(); };
  }, []);

  // 组件卸载(切走标签页/关闭)前立即落盘草稿,避免 400ms 防抖窗口内的输入丢失;
  // 顺带取消挂起的跳转点度量帧
  useEffect(() => () => { persistDrafts(); if (dotRafRef.current) cancelAnimationFrame(dotRafRef.current); }, []);

  // 模型(或它的上下文窗口)变了:上一次请求上报的窗口已经不代表这个模型,先清掉;
  // 仪表盘随即改用当前模型的窗口(见 ContextMeter 的 serverWin 回退)。否则切模型后会继续
  // 显示上一个模型的窗口 —— 看起来就像"所有模型都变成了同一个窗口"。
  useEffect(() => {
    setCtxUsage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llm.effModel, llm.effModelContext?.contextWindow]);

  // 挂载或会话切换时,载入当前活跃会话的历史。
  // 不先清空消息:保留上一会话内容 + 「正在加载会话」提示,新会话历史到达后再整体替换,
  // 避免切换出现空白闪烁;已加载过的会话走缓存秒开,后台静默刷新保持最新。
  useEffect(() => {
    let alive = true;
    const target = sid; // 本次要加载的会话 id(防止异步响应串到别的会话)
    const skipHistory = skipHistoryOnceRef.current; // 新会话草稿态刚创建并发送:消息由事件流渲染
    skipHistoryOnceRef.current = false;
    // 切换会话:清空上一会话的 context_usage,仪表盘回退到前端估算,直到本会话的下一步请求上报
    setCtxUsage(null);
    // 统计栏同理:先清空,等本会话的 get_history 回填或 session_stats 事件到达,避免串上一会话的数
    setSessionUsage(null);
    setSessionStats(null);

    // ---- 输入草稿:离开旧会话前保存输入,进入新会话后恢复其草稿 ----
    // 草稿键 = 目标会话的真实 sid(草稿态为 __new__);target=null(App 初次加载未定向)不算切换,不读写草稿
    const targetKey = target === NEW_SESSION_ID ? NEW_DRAFT_KEY : target;
    const isFirstRun = firstDraftRunRef.current;
    firstDraftRunRef.current = false;
    const prevKey = prevDraftKeyRef.current;
    prevDraftKeyRef.current = targetKey;
    if (!isFirstRun && prevKey !== null && targetKey !== null && prevKey !== targetKey) {
      // 离开旧会话:把当前输入保存到旧草稿键(空输入则清掉该 key)
      const cur = inputValueRef.current;
      if (cur && cur.trim()) draftsRef.current[prevKey] = cur;
      else delete draftsRef.current[prevKey];
    }
    // 进入新会话:恢复其草稿;target=null(App 初次加载尚未定向)时不设置输入,避免闪现
    if (targetKey !== null) {
      setInput(draftsRef.current[targetKey] ?? '');
    }
    saveDrafts(draftsRef.current);

    hasLive.current = false; // 切换会话:重置"已有新对话"标记,让新会话历史立即显示
    justSwitchedRef.current = true; // 切换会话:标记本轮滚底兜底(未完成不提前消费,见 [messages] 兜底 effect)
    switchSeqRef.current++; // 切换序号+1:旧会话的兜底据此立即作废,不会吞掉新会话的标志
    settledMsgNodesRef.current = new WeakSet(); // 会话内容已变:精确高度记录作废,重新测量
    forkTurnRef.current = 0; lastIterRef.current = 0; // 分支点计数器随会话重置
    setTodos([]);
    setAgentState('idle'); setErrorMsg('');
    // 切到哪个会话就显示哪个会话的状态:取回该会话自己的在途生图标记;
    // null 表示没有生图在途——状态行回到「Agent 正在运行…」,不沿用上一个会话的文案
    setSessionImgJob(target, target && target !== NEW_SESSION_ID ? imgJobsRef.current.get(target) ?? null : null);
    setQueue([]); // 切会话先复位队列,避免串到上一会话;真实队列随 get_history 返回
    setGoal(null); // 目标随会话走:切走先清空,防止把上一个会话的目标条画到新会话上
    clearAttachments(); // 草稿附件不跨会话携带(纯内存,发送时才随消息上行)

    // 新会话草稿态(sid 为占位符):不请求历史,显示空对话;sid=null(App 初次加载尚未定向)
    // 则沿用原切换重载逻辑(请求 get_history 拿回服务端活跃会话)
    if (target === NEW_SESSION_ID) {
      setSuppressIn(true);
      setMsgsSid(target); // 空对话就是本(草稿)会话的内容
      setMessages([]);
      setSwitching(false);
      permTouchedRef.current = false; // 新草稿:本次尚未手动改过权限档位
      // 草稿态权限选择器回显全局默认(用户上次设置的档位,服务端持久化):
      // 没手动改过才用默认值覆盖(防与用户刚做的选择竞态),请求失败回落 confirm
      setPermMode('confirm');
      api.request('permission_default_get', {}, 8000)
        .then((r) => {
          if (!alive || activeRef.current !== NEW_SESSION_ID) return;
          if (!permTouchedRef.current && isPermissionMode(r.mode)) setPermMode(r.mode);
        })
        .catch(() => { /* 回落 confirm:权限以服务端为准,不影响使用 */ });
      return () => { alive = false; };
    }
    // 刚由新会话草稿发送创建:首条消息正由事件流渲染,跳过历史回载避免重复;
    // 不重置消息(事件流 start/steer 到达即渲染),也不清空,避免与事件竞态
    if (skipHistory) {
      histCache.current.delete(target ?? '');
      setMsgsSid(target); // 屏幕上的消息就是新建会话正在流的内容:已属于本会话
      setSuppressIn(true);
      setSwitching(false);
      return () => { alive = false; };
    }
    // 有缓存则立即显示(切回已看过的会话零等待);无缓存时保留旧内容 + 加载指示
    const cached = histCache.current.get(target ?? '');
    if (cached) { setMsgsSid(target); setSuppressIn(true); setMessages(cached.msgs); setTodos(cached.todos); setSwitching(false); }
    else setSwitching(true);
    api.request('get_history', { sid: sidArg(target) }, 8000)
      .then((r) => {
        if (!alive || hasLive.current || activeRef.current !== target) return;
        // 历史 turns 长度即该会话已累计的消息面 turn 数,作为后续流式递增的基准
        forkTurnRef.current = (r.turns || []).length;
        // 目标状态随历史一起回填:目标是持久状态,切走再切回必须显示同一条(与服务端 goal_changed 同一口径)
        setGoal(r.goal === undefined ? null : (r.goal as GoalInfo | null));
        const msgs = turnsToMessages(r.turns || []);
        // 该会话此刻正在生成压缩摘要:compaction_start 只是实时事件、不落盘,切走再切回时历史
        // 整表重载会把那行「正在压缩…」丢掉,看起来像"压缩记录不见了"。服务端随 get_history
        // 如实回报 compacting,这里按与 compaction_start 完全相同的口径把运行行补回来(插在流式
        // assistant 之前,位置保持一致);完成/失败时由 compaction_done / compaction_failed 原地改写。
        if (r.compacting === true && !msgs.some((x) => x.compaction?.running)) {
          const li0 = tailAssistantIndex(msgs);
          const runRow = { role: 'user' as const, content: '', compaction: { running: true } };
          if (li0 >= 0) msgs.splice(li0, 0, runRow);
          else msgs.push(runRow);
        }
        // 切回一个仍在运行中的会话:末条回复标记为流式中,继续接收后续增量事件。
        // 历史末尾不是 assistant(本轮模型尚未流出任何内容/纯工具调用步骤)时补一个
        // 流式占位气泡:后续 text/reasoning/tool 事件只认"末尾 assistant",
        // 没有它整轮增量都会被静默丢弃,直到下一轮 start 才恢复——正是"切回后
        // 正在思考的回复消失"的另一半根因
        if (busyRef.current) {
          const last = msgs[msgs.length - 1];
          if (last?.role === 'assistant') last.streaming = true;
          else msgs.push({ role: 'assistant', segments: [], streaming: true });
        }
        histCache.current.set(target ?? '', { msgs, todos: Array.isArray(r.todos) ? r.todos : [] });
        setSuppressIn(true); // 历史整表替换:抑制最新一条的入场动画,切换画面保持静止
        setMsgsSid(target); // 本会话历史已上屏:计时器现在可以认它的本轮起点了
        setMessages(msgs);
        setTodos(Array.isArray(r.todos) ? r.todos : []); // 该会话当前的任务计划
        setQueue(Array.isArray(r.queue) ? r.queue : []); // 该会话的待执行队列快照
        // 该会话的权限模式快照(服务端权威):非法值/旧服务端缺省回落默认
        setPermMode(isPermissionMode(r.permissionMode) ? r.permissionMode : 'confirm');
        // 统计栏快照(旧版服务端不返回这两项 → 置空,胶囊自动不显示)
        setSessionUsage(r.usage && typeof r.usage === 'object' ? r.usage as TokenUsageTotals : null);
        setSessionStats(r.stats && typeof r.stats === 'object' ? r.stats as SessionStatsInfo : null);
        setSwitching(false);
      })
      .catch((e) => {
        if (!alive) return;
        setSwitching(false);
        if (cached) return; // 有缓存:继续显示缓存(可能略旧),静默忽略本次刷新失败
        // 无缓存且加载失败:清掉可能已混入的上一会话内容,提示可重试(会话项不再被 activeId 守卫挡住)
        histCache.current.delete(target ?? '');
        setMsgsSid(target); // 内容已清空(不再混着上一会话):计时器不会去认别人的起点
        setMessages([]);
        setTodos([]);
        setErrorMsg(`加载会话历史失败: ${(e as Error).message} — 再次点击该会话可重试`);
      });
    return () => { alive = false; };
  }, [sessionSeq, sid]);

  const clearAll = async () => {
    const ok = await confirm({
      title: '清空对话历史',
      message: '清空对话历史?该操作会同时清除服务端的持久化历史,不可恢复',
      confirmLabel: '清空',
      danger: true
    });
    if (!ok) return;
    api.send('clear_history', { sid: sidArg(sid) });
    setSessionImgJob(activeRef.current, null); // 清空历史:在途生图标记一并销账
    // 清空后服务端 turns 归零,分支点计数器必须同步重置——
    // 否则下一条新消息的 forkTail 沿用旧计数值,返回/删除时会索引越界报「目标消息不存在」
    forkTurnRef.current = 0; lastIterRef.current = 0;
    setMessages([]);
    setQueue([]);
  };

  // 用服务端返回的最新 turns 整表刷新消息与任务计划(删除/回退消息后调用),
  // 同时更新缓存与分支点计数,切走再切回仍是最新
  const applyTurns = (r: any) => {
    const msgs = turnsToMessages(r.turns || []);
    histCache.current.set(activeRef.current ?? '', { msgs, todos: Array.isArray(r.todos) ? r.todos : [] });
    forkTurnRef.current = (r.turns || []).length; // 分支点/删除索引重新对齐服务端 turns 长度
    lastIterRef.current = 0;
    setSuppressIn(true);
    setMessages(msgs);
    setTodos(Array.isArray(r.todos) ? r.todos : []);
  };

  // 回退/删除的定位参数:at 是本地推算的分支点下标(实时流里会漂移),ordinal 是
  // 「这条是本地视图里的第几条用户消息」——只取决于视图内容,不受计数器漂移影响。
  // 服务端以 ordinal 为权威定位,at/text 只作兜底与校验(见 server/agent/agent.ts 的 locateUserEvent)。
  // 线上故障:模型请求失败后再点回退,漂移的 at 命中了失败提示行(notice),报「目标不是用户消息,
  // 无法回退」——之前只有切换会话/刷新重拉历史才能恢复。
  const rewindLocator = (m: ChatMessage, i: number) => {
    const at = m.forkTail ?? i;
    // 只对用户气泡(非压缩标记行)带序号;messages[i] 不是本条时说明视图已变,退回纯 at
    if (m.role !== 'user' || m.compaction || messages[i] !== m) return { at };
    let ordinal = 0;
    for (let k = 0; k < i; k++) {
      const x = messages[k];
      if (x && x.role === 'user' && !x.compaction) ordinal += 1;
    }
    return { at, ordinal, text: m.content || '' };
  };

  // 回退/删除前把本地推算的 at 校准成服务端权威下标:
  // get_history 的 turns 是服务端投影的权威顺序,按「第几条用户消息」取它的下标,
  // 即使服务端还是旧版本(不认 ordinal)也能正确回退——前端热更新/刷新即时生效,不用等重启。
  // 拉取失败时保留本地 at,由服务端定位兜底,绝不因为一次网络抖动挡住回退。
  const rewindTarget = async (m: ChatMessage, i: number) => {
    const loc = rewindLocator(m, i);
    if (typeof loc.ordinal !== 'number') return loc;
    try {
      const h: any = await api.request('get_history', { sid: sidArg(sid) }, 8000);
      const turns: any[] = Array.isArray(h?.turns) ? h.turns : [];
      const users = turns.map((t, ti) => ({ t, ti })).filter((x) => x.t && x.t.role === 'user' && !x.t.compaction);
      const text = loc.text || '';
      const hit = users[loc.ordinal];
      if (hit && (!text || String(hit.t.content || '') === text)) return { ...loc, at: hit.ti };
      const same = text ? users.filter((x) => String(x.t.content || '') === text) : [];
      if (same.length === 1) return { ...loc, at: same[0].ti };
      if (hit) return { ...loc, at: hit.ti };
    } catch { /* 拉取失败:沿用本地 at,由服务端按 ordinal 定位 */ }
    return loc;
  };

  // 删除消息:删掉该条用户消息及其对应的一轮回复(仅作用于所在轮,其后内容保留)
  const deleteMsg = async (m: ChatMessage, i: number) => {
    const ok = await confirm({
      title: '删除消息',
      message: '删除这条消息及其对应的回复?该操作会同步清除服务端的持久化历史,不可恢复',
      confirmLabel: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      applyTurns(await api.request('message_delete', await rewindTarget(m, i), 8000));
    } catch (e) { toast.error((e as Error).message); }
  };

  // 回到本轮对话发起前:把对话回退到这条消息之前(移除它及其之后的所有内容)
  const rewindMsg = async (m: ChatMessage, i: number) => {
    const ok = await confirm({
      title: '回到本轮对话发起前',
      message: '将对话回退到这条消息之前?该条消息及其之后的所有内容都会被移除,不可恢复',
      confirmLabel: '回退',
      danger: true
    });
    if (!ok) return;
    try {
      applyTurns(await api.request('message_rewind', await rewindTarget(m, i), 8000));
      // 回退后把该条消息回填输入框,便于修改后重新发起(@引用按 @文件名 回填)
      restoreInputMentions(m.content || '');
      requestAnimationFrame(() => { const el = taRef.current; if (el) el.focus(); });
    } catch (e) { toast.error((e as Error).message); }
  };

  // 用户消息索引(左侧跳转点数据源:每条用户消息对应一个点;压缩标记行不算用户消息,跳过)
  const userMsgIndices = messages.reduce((acc: number[], m, i) => {
    if (m.role === 'user' && !m.compaction) acc.push(i);
    return acc;
  }, []);

  // 距底部多少像素内仍视为"在底部":容掉惯性滚动的残余位移与亚像素取整,
  // 避免流式增长时因 1px 误差误判为"用户上滑"而暂停吸附
  const STICK_EPS = 48;

  // 计算当前激活点:视口 40% 参考线之下的最后一条用户消息。
  // rAF 节流 + 文档序单调早停:滚动帧里不再对全部用户消息逐条 getBoundingClientRect
  // (强制整文档布局),首个越过参考线的点之后位置只会更靠下,直接终止遍历;
  // 加上 .msg 的 content-visibility,长会话滑动时每帧的开销稳定在常量级。
  // 末尾兜底:最新一轮的提问只要已经进入视口(刚发出消息瞬时触底时,新提问往往贴在
  // 视口下缘、落在 40% 参考线之下),激活状态就直接归到最后一轮——参考线只回答
  // "读到哪了",不应该让"底部明明显示着最新提问、导轨却还亮着上一轮"出现。
  const dotRafRef = useRef(0);
  // 每次渲染同步一份最新索引:被合并掉的那些帧之后消息可能又长了(发出提问后紧接着
  // 就是助手回包/流式追加),rAF 回调若读渲染闭包里的旧索引,就会漏掉刚出现的最新一轮
  // 用户消息,导轨于是停在上一轮。
  const userMsgIndicesRef = useRef<number[]>([]);
  userMsgIndicesRef.current = userMsgIndices;
  const updateActiveDot = () => {
    if (dotRafRef.current) return; // 上一帧的度量还没跑完,合并本次需求
    dotRafRef.current = requestAnimationFrame(() => {
      dotRafRef.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      const list = userMsgIndicesRef.current; // 取测量当帧的最新一轮信息,不用可能的旧闭包
      const box = el.getBoundingClientRect();
      const line = box.top + el.clientHeight * 0.4;
      let cur = -1;
      for (const i of list) {
        const node = userMsgRefs.current[i];
        if (!node) continue;
        if (node.getBoundingClientRect().top > line) break; // 文档序单调:之后都更靠下
        cur = i;
      }
      // 最后一条用户消息可见(顶边越过视口下缘)或视图本就贴着底部时,一律激活最后一轮:
      // 这两种情况下用户看到的就是最新一轮,再停在上一轮属于误判。
      const last = list[list.length - 1];
      if (last !== undefined && last > cur) {
        const lastNode = userMsgRefs.current[last];
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_EPS;
        if (lastNode && (atBottom || lastNode.getBoundingClientRect().top < box.bottom)) cur = last;
      }
      setActiveDot(cur);
    });
  };

  // 用户滚动输入的两种有效期:离散输入(滚轮/触摸/按键/拖拇指)后一段短窗口内的
  // 滚动事件都算这次手势的产物(惯性滚动会连续发事件但不刷新起点);点跳转点走的是
  // 平滑滚动,动画本身持续数百毫秒,窗口按动画时长量级给(见 userScrollUntilRef)。
  const USER_SCROLL_MS = 400;
  const SMOOTH_SCROLL_MS = 900;

  // 点击跳转点:平滑滚动到对应的用户消息
  const jumpToMsg = (i: number) => {
    const el = scrollRef.current;
    const node = userMsgRefs.current[i];
    if (!el || !node) return;
    const top = el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
    // 用户主动离底回看:标记为用户滚动,平滑动画期间产生的 scroll 事件才被认成手势
    // (暂停吸附,避免流式增量把用户拉回底部)
    userScrollUntilRef.current = performance.now() + SMOOTH_SCROLL_MS;
    el.scrollTo({ top, behavior: 'smooth' });
  };

  // ---- 轮次导轨(harness TurnNavigator):刻度滚动 / 预览跟随 / 当前轮进场 ----
  // 导轨自身滚动:刷新端点渐隐遮罩(预览位置由下面的 layout effect 跟着 scrollTop 重算)
  const syncDotRail = () => {
    const scroller = dotScrollerRef.current;
    if (!scroller) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const top = scroller.scrollTop > 1;
    const bottom = max > 1 && scroller.scrollTop < max - 1;
    setDotScrollTop(scroller.scrollTop);
    // 状态未变时返回同一引用,避免滚动帧里白白重渲染整个对话面板
    setDotFade((cur) => (cur.top === top && cur.bottom === bottom ? cur : { top, bottom }));
  };

  // 刻度数量变化(新建/切换会话)后重算一次渐隐:此时 DOM 已就绪,用 layout effect 免得闪一下
  useLayoutEffect(() => { syncDotRail(); }, [userMsgIndices.length]);

  // 预览卡定位:刻度中心相对导轨顶部(harness 用虚拟项 start + size/2 - scrollTop)
  useLayoutEffect(() => {
    if (previewDot === null) return;
    const scroller = dotScrollerRef.current;
    const mark = dotRefs.current[previewDot];
    if (!scroller || !mark) return;
    setDotPreviewCenter(mark.offsetTop + mark.offsetHeight / 2 - scroller.scrollTop);
  }, [previewDot, dotScrollTop]);

  // 当前轮自动进场(harness 的 follow effect):指针不在导轨上时把激活刻度滚进可视带;
  // 已在两端 24px 渐隐区之内就不动,免得滚动对话时导轨频繁自滚
  useEffect(() => {
    if (activeDot < 0 || dotPointerInsideRef.current) return;
    const scroller = dotScrollerRef.current;
    const d = userMsgIndices.indexOf(activeDot);
    const mark = d < 0 ? null : dotRefs.current[d];
    if (!scroller || !mark) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max <= 0) return;
    const center = mark.offsetTop + mark.offsetHeight / 2;
    const view = scroller.clientHeight;
    if (center >= scroller.scrollTop + 24 && center <= scroller.scrollTop + view - 24) return;
    scroller.scrollTo({
      top: Math.max(0, Math.min(max, center - view / 2)),
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }, [activeDot, userMsgIndices.length]);

  // 切换会话后刻度整体换义:收起预览,免得残留指着另一轮的刻度
  useEffect(() => { setPreviewDot(null); }, [sid]);

  // 悬停/聚焦预览的内容(照搬 harness TurnNavigator 的 preview):
  // 一行提问(50 字预算) + 该轮最近一条助手正文(120 字预算),各自超限补省略号
  const dotPreview = React.useMemo(() => {
    if (previewDot === null) return null;
    const idx = userMsgIndices[previewDot];
    if (idx === undefined) return null;
    // 该轮的助手正文:取本轮**最后一条有文本的 assistant**(harness 的 findLast 口径)。
    // 文本取自 text 段(harness 也只看 assistant-step 的 text block,不含推理)。
    let latest = '';
    for (let i = idx + 1; i < messages.length; i++) {
      const m = messages[i];
      if (isRealUserRow(m)) break; // 本轮结束,不再往后找回复
      if (m.role !== 'assistant') continue;
      const text = segText(m) || m.content || '';
      if (text) latest = text;
    }
    return {
      turn: previewDot + 1,
      prompt: railPreview([railPreviewText(messages[idx]?.content || '')], RAIL_PROMPT_LIMIT),
      response: latest === '' ? '' : railPreview([railPreviewText(latest)], RAIL_RESPONSE_LIMIT),
    };
  }, [previewDot, messages, userMsgIndices.length]);

  // 瞬时触底并恢复吸附(发送消息/切换会话/点击回底按钮共用)。
  // 与既有滚底一致用瞬时定位:平滑滚动目标是调用瞬间的底部,流式追加会让目标
  // 持续前移,动画追不上移动靶;且动画中途的 scroll 事件位置不在底部,会反复
  // 翻转吸附状态。只在赋值确实改变 scrollTop 时标记 progRef——已在底部时
  // 赋值不会触发 scroll 事件,残留的标志会把用户下一次真实上滑误吞成程序化滚动。
  const scrollToBottomNow = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setShowJump(false);
    const prevBehavior = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto'; // 覆盖任何来源的平滑滚动,保证瞬间滚底
    refreshOverlayScrollbar(el, true); // 先重算拇指(scrollHeight 才是真实值)
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (el.scrollTop < maxScroll - 0.5) progRef.current = true;
    el.scrollTop = maxScroll;
    refreshOverlayScrollbar(el, true); // 同一帧内把拇指重绘到当前正确位置/尺寸
    el.style.scrollBehavior = prevBehavior;
    updateActiveDot();
  };

  // 对话区 scroll 统一入口:更新跳转点/提示,并据位置维护吸附状态。判定顺序:
  // 1) 位置在底部(含 STICK_EPS 容差):无论来源一律恢复吸附——用户自己滚回底部、
  //    程序化触底、引擎钳制都适用,「在底部就跟随底部」永远是对的;
  // 2) progRef:本组件的程序化 scrollTop 赋值,只吞标志不改状态;
  // 3) 其余滚动只有落在用户输入有效期内(userScrollUntilRef)才认作"用户上滑离底"。
  //    引擎/布局驱动的滚动(切会话时内容整段替换带来的钳制与滚动锚定)不改变吸附状态,
  //    否则切换的触底兜底会在第一帧就被误判打断(见 userScrollUntilRef 注释)。
  const onChatScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    updateActiveDot();
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_EPS;
    if (atBottom) {
      progRef.current = false; // 已在底部:残留的程序化标志一并清掉
      stickRef.current = true;
      setShowJump(false);
      return;
    }
    if (progRef.current) { progRef.current = false; return; }
    if (performance.now() > userScrollUntilRef.current) return; // 非用户滚动:不动吸附状态
    stickRef.current = false;
    setShowJump(true);
  };

  // 滚动条宿主 = tab-body(对话标签页整个区域):拇指从面板顶部铺到底部、贴最右侧。
  // 消息区限宽居中(780px),两侧空白与输入面板不属于滚动区,原生滚轮落在其上
  // 不会滚动对话——在宿主上监听 wheel,目标不在任何可滚动容器内时把滚动量
  // 转发给聊天滚动区,让悬停在空白处也能滚动。声明在下方 [messages] 绘制 effect
  // 之前,保证首帧绘制拇指时宿主已注册;卸载时解除注册并移除监听与拇指。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const root = wrapRef.current;
    const host = (root?.closest('.tab-body') as HTMLElement | null) ?? root?.parentElement ?? null;
    if (!el || !host) return;
    setScrollbarHost(el, host);
    // 真实用户滚动输入续期(见 userScrollUntilRef):滚轮、触摸滑动、键盘滚动键、
    // 拖动自绘滚动条拇指都在宿主内,统一在这里登记,onChatScroll 据此区分手势与引擎滚动
    const markUserScroll = () => { userScrollUntilRef.current = performance.now() + USER_SCROLL_MS; };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // Ctrl+滚轮 / 触控板捏合缩放:交给浏览器
      markUserScroll(); // 无论是下面的转发还是落在聊天区上的原生滚动,都是用户手势
      // 自下而上检查目标到宿主的链路:命中聊天滚动区本身(原生滚动)或任何
      // 真实可滚动的内部容器(工具卡片/提问面板/输入框等)时不转发,交给原生处理
      for (let n = e.target as Element | null; n && n !== host; n = n.parentElement) {
        if (n === el) return;
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return;
      }
      e.preventDefault();
      // deltaMode:1=行、2=页,换算为像素后直接滚动;程序化滚动同样触发 scroll 事件,
      // 拇指重绘与跳转点激活态由既有 scroll 处理器照常完成
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
      el.scrollTop += dy;
    };
    const onTouch = () => markUserScroll();
    // 键盘滚动键:只有作用在对话滚动区上时才算(输入框里的按键不是滚动输入)
    const onKey = (e: KeyboardEvent) => {
      if (!/^(Arrow|Page|Home|End| )/.test(e.key)) return;
      const t = e.target as Element | null;
      if (t !== el && !(t && el.contains(t))) return;
      markUserScroll();
    };
    // 拖动自绘滚动条拇指(scrollbar-ui 里 thumb.setPointerCapture 后 move 事件仍指向拇指)
    const onPointer = (e: PointerEvent) => {
      if ((e.target as Element | null)?.classList?.contains('ob-thumb')) markUserScroll();
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('touchstart', onTouch, { passive: true });
    host.addEventListener('touchmove', onTouch, { passive: true });
    host.addEventListener('keydown', onKey, true);
    host.addEventListener('pointerdown', onPointer, true);
    host.addEventListener('pointermove', onPointer, true);
    return () => {
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('touchstart', onTouch);
      host.removeEventListener('touchmove', onTouch);
      host.removeEventListener('keydown', onKey, true);
      host.removeEventListener('pointerdown', onPointer, true);
      host.removeEventListener('pointermove', onPointer, true);
      setScrollbarHost(el, null);
    };
  }, []);

  // 用 useLayoutEffect:在浏览器绘制前同步完成「清残留拇指 → 滚到底 → 重绘拇指」,
  // 保证会话切换/流式更新时滚动条与内容在同一帧就位。吸附规则:
  // - 吸附中(stick=true):每次消息/流式增量变化都瞬时触底,行为同以往;
  // - 用户已上滑离底(暂停吸附):不强制触底,只重算悬浮拇指(内容仍在增长),
  //   让用户在 AI 回答过程中自由回看上下文,新内容在下方静默追加;
  // - 会话切换(justSwitched):总是恢复吸附并触底。
  // 这里强制瞬时定位:1) 临时禁用平滑滚动(scroll-behavior:smooth 会让程序化
  // scrollTop 赋值也动画,造成"内容从上面缓缓落下"的过渡);2) 拇指跳过淡入立即就位。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (justSwitchedRef.current) {
      stickRef.current = true; // 切换会话总是回到底部
      anchoredSidRef.current = sid; // 正常切换路径:内容已锚定到本会话
    }
    if (stickRef.current) {
      scrollToBottomNow();
    } else {
      refreshOverlayScrollbar(el, true); // 离底查看:内容变长后拇指位置/长度需重算
      setShowJump(true);                 // 流式增长不触发 scroll 事件,按钮显隐在此维护
      updateActiveDot();
    }
  }, [messages]);

  // 会话切换的兜底(精确滚到真正的底部,修复 content-visibility 占位高度塌陷)。
  // 背景:.msg 用 content-visibility:auto,视口外消息只占估算高度(contain-intrinsic-size
  // 记忆值 / 320px 兜底)。但 Chrome 对复用消息不会可靠记住真实高度,切换后撤掉预热会
  // 塌缩回估算高度,scrollHeight 骤缩→scrollTop 冻在"估算底部"→真实底部还在下方N千px,
  // 用户一眼看到就是"卡在中间没滚到底"。解法:
  // 1) 预热:临时挂 data-ws-settle 取消全部 .msg 跳过渲染,做一次全量真实布局,测出每条
  //    消息的真实 clientHeight,立刻把精确值写到 .msg { contain-intrinsic-size: auto H; },
  //    这样撤预热后每条消息仍占真实几何,不会塌缩;
  // 2) 收敛:ResizeObserver 监听尺寸(图片/字体异步加载撑高),每次都滚底+写入最新精确值;
  // 3) 收尾:连续 2 次 scrollHeight 一致视为收敛,最终滚一次后撤标记。
  // 快速切换保护:每次 [sid] 切换递增 switchSeqRef,旧序号的兜底只撤资源,不消费标志,
  // 把标志留给新会话;用户手动上滑放弃自动触底。
  // 兜底补全:切换路径偶发因 RPC/state 竞态漏置 justSwitchedRef(内容已换成新会话但标志
  // 未设),这里凭「当前内容所属会话 ≠ 已锚定过底部的会话」强制补齐标志,保证任何切换都兜底。
  useEffect(() => {
    if (!justSwitchedRef.current && anchoredSidRef.current !== sid) {
      // 自动标记一次:每个 switchSeqRef 保证兜底子例程只整体执行一遍
      justSwitchedRef.current = true;
      switchSeqRef.current++;
      settledMsgNodesRef.current = new WeakSet();
    }
    if (!justSwitchedRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const seq = switchSeqRef.current; // 本会话的切换序号
    if (settleSeqRef.current !== seq) { // 预热:每个切换序号只全量真实布局+测高一次
      settleSeqRef.current = seq;
      el.dataset.wsSettle = '1';
      settledMsgNodesRef.current = new WeakSet();
    }
    let lastH = -1;      // 上次测得的总 scrollHeight
    let same = 0;        // 高度连续未变的次数
    let timer = 0;       // 兜底超时句柄
    let rid = 0;         // rAF 句柄
    let ro: ResizeObserver | null = null;
    const release = () => { // 只撤资源与预热标记,不碰切换标志
      ro?.disconnect();
      cancelAnimationFrame(rid);
      clearTimeout(timer);
      delete el.dataset.wsSettle;
    };
    const done = () => { // 完成:消费切换标志并锚定本会话
      justSwitchedRef.current = false;
      anchoredSidRef.current = sid;
      release();
    };
    const finish = () => { // 收敛后收尾:最终滚底→消费切换标志
      if (switchSeqRef.current !== seq) { release(); return; } // 已切走:交给新会话
      if (!stickRef.current) { done(); return; }               // 用户已手动离底
      scrollToBottomNow();
      done();
    };
    const chip = (entries: ResizeObserverEntry[]) => {
      if (switchSeqRef.current !== seq) { release(); return; } // 快速切换:本会话兜底作废
      if (!stickRef.current) { done(); return; }               // 用户手动上滑:放弃自动触底
      // 对每个尺寸变化的子元素,写入最新精确高度到 inline contain-intrinsic-size:
      // 尺寸变化本身说明内容在变(图片/字体晚到、流式追加),必须无条件刷新——
      // 不能因"已测过"而跳过,否则晚到图片测到的是加载前的小高度,占位永错
      if (entries) {
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          if (!target.classList?.contains('msg')) continue;
          const h = entry.contentBoxSize?.[0]?.blockSize ?? target.clientHeight;
          if (h > 0) {
            target.style.containIntrinsicSize = `auto ${h}px`;
            settledMsgNodesRef.current.add(target);
          }
        }
      }
      // 兜底:预热全量真实布局后,首帧把仍未记录的 .msg 一次性测齐(WeakSet 去重,只测一次)
      for (let i = 0; i < el.children.length; i++) {
        const m = el.children[i] as HTMLElement;
        if (!m.classList?.contains('msg') || settledMsgNodesRef.current.has(m)) continue;
        const h = m.clientHeight;
        if (h > 0) {
          m.style.containIntrinsicSize = `auto ${h}px`;
          settledMsgNodesRef.current.add(m);
        }
      }
      scrollToBottomNow();
      const h = el.scrollHeight;
      if (h === lastH) {
        if (++same >= 2 && same === 2) rid = requestAnimationFrame(finish);
        return;
      }
      same = 0;
      lastH = h;
    };
    // 尺寸变化 → 重滚+写精确高度;图片/字体/异步 markdown 高亮撑高都能捕捉到
    ro = new ResizeObserver(chip);
    for (let i = 0; i < el.children.length; i++) ro.observe(el.children[i]);
    rid = requestAnimationFrame(() => chip([])); // 首帧:预热后先滚一次,至少测一次全高
    timer = window.setTimeout(finish, 800); // 兜底:迟迟不收敛(大图片加载)也按时收尾
    return release;
  }, [messages]);

  // 常驻几何守护:切换兜底只覆盖切换当下,图片/字体/流式内容可能在兜底结束后才撑高
  // 消息(如末条带图消息,图片加载晚于预热测量)。这里挂一棵常驻 ResizeObserver:
  // 1) 任何 .msg 尺寸变化都无条件刷新其 inline contain-intrinsic-size,保持滚动几何精确;
  // 2) 处于吸附底部(stick=true)时立即重新滚底,晚到图片也不会把底部顶走。
  // MutationObserver 给新挂载的消息补挂观察,避免 [messages] 每次 O(n) 全量重挂。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const t = entry.target as HTMLElement;
        if (!t.classList?.contains('msg')) continue;
        const h = entry.contentBoxSize?.[0]?.blockSize ?? t.clientHeight;
        if (h > 0) t.style.containIntrinsicSize = `auto ${h}px`;
      }
      if (scrollRef.current && stickRef.current) scrollToBottomNow();
    });
    const mo = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) ro.observe(n as Element);
    });
    mo.observe(el, { childList: true });
    for (let i = 0; i < el.children.length; i++) ro.observe(el.children[i]);
    return () => { mo.disconnect(); ro.disconnect(); };
  }, []);

  // 发送时的 @ 引用替换:把输入中记录的 @名称 替换为 @source:完整路径
  // (文本区只显示名称,AI 收到的是带来源标记的绝对路径)。
  // 按名称长度降序替换避免 @server.ts 被 @server 抢先吃掉;未记录的 @词原样保留。
  function composeMentionText(text: string): { text: string; refs: { source: 'remote' | 'local'; path: string }[] } {
    const map = atMapRef.current;
    if (map.size === 0) return { text, refs: [] };
    const names = [...map.keys()].sort((a, b) => b.length - a.length);
    const refs: { source: 'remote' | 'local'; path: string }[] = [];
    let out = '';
    let i = 0;
    while (i < text.length) {
      const atStart = i === 0 || /\s/.test(text[i - 1]);
      if (text[i] === '@' && atStart) {
        let consumed = 0;
        for (const name of names) {
          if (text.startsWith(name, i + 1)) {
            const after = text[i + 1 + name.length] ?? '';
            if (after === '' || /\s/.test(after)) {
              const rec = map.get(name)!;
              out += serializeMention(rec.source, rec.path);
              refs.push({ source: rec.source, path: rec.path });
              consumed = 1 + name.length;
              break;
            }
          }
        }
        if (consumed) { i += consumed; continue; }
      }
      out += text[i];
      i += 1;
    }
    return { text: out, refs };
  }

  // 发送文本 = 输入框原文 + @引用替换(技能 /词 原样保留,后端按独立词解析注入)
  const composedInput = composeMentionText(input).text;
  // 输入中是否已含完整 /技能名 或 @引用(用于占位提示与去重判断)
  const hasSkillToken = /(?:^|\s)(\/[a-z0-9][a-z0-9-]*|@[a-zA-Z0-9_.\-/\\]+)(?=\s|$)/i.test(input);
  // 发送入口的斜杠命令拦截:与「菜单选中即执行」(pickSlash)共用同一张命令表,
  // 差别只在输入来自整条文本 —— 手打 /compact 回车、菜单已关闭、带参数、手机 ➤ 按钮发送
  // 这些路径过去都不执行命令,而是把 "/compact" 当普通消息发给模型(表现为"假压缩")。
  // 匹配规则见 utils/slashCommand.ts:仅整条输入的首词命中命令名才算命令,技能与路径不误伤。
  const dispatchSlashFromInput = (): boolean => {
    // 命中集合同时包含规范名与中文 token(/计划 与 /plan 等价)
    const tokens = slashCommands.flatMap((c) => (c.token ? [c.name, c.token] : [c.name]));
    const hit = matchSlashCommand(input, tokens);
    if (!hit) return false;
    const cmd = slashCommands.find((c) => c.name === hit.name || c.token === hit.name);
    if (!cmd || !cmd.run) return false;
    closeSlash();
    // 命令即消费本次输入:与发送一样清掉输入框/草稿/附件,但不产生任何对话消息。
    // 附件元数据必须在 clearAttachments 之前取:两条命令都可能把它随命令上行
    // (harness:/plan <message> 与 /goal <objective> 的附件语义)。
    const atts = attachments.filter((a) => a.att).map((a) => a.att!);
    if (sid === NEW_SESSION_ID) delete draftsRef.current[NEW_DRAFT_KEY];
    else if (sid) delete draftsRef.current[sid];
    saveDrafts(draftsRef.current);
    setInput('');
    inputValueRef.current = ''; // 同步最新输入,防止随后的草稿保存把已执行命令回写
    clearAttachments();
    scrollToBottomNow();
    Promise.resolve(cmd.run(hit.args, { attachments: atts })).catch((e) => toast.error((e as Error).message));
    return true;
  };

  const send = async () => {
    // 斜杠命令优先于发送:命中已注册系统命令(/compact、/clear、/fork)时执行命令本身并终止,
    // 绝不把命令词当普通消息上行 speak —— 否则模型会「假装压缩」:前端当场有画面,
    // 服务端却没有 compaction/done 事件落盘,切换会话重载历史后压缩标记随之消失。
    if (!childMode && dispatchSlashFromInput()) return;
    // 工作中仍可发送:服务端会把消息放入待执行队列(当前轮结束后按序自动执行,不打断回复);
    // 提问挂起时禁止发送(须先作答或取消);纯附件消息(无文字)也允许发送
    const atts = attachments.filter((a) => a.att).map((a) => a.att!);
    if ((!input.trim() && atts.length === 0) || !canSend || askPending) return;
    if (attPending) { toast.warning('附件还在上传中,请稍候…'); return; }
    if (attFailed) { toast.warning('有附件上传失败,请先移除后再发送'); return; }
    if (atts.some((a) => a.kind === 'image') && !canSendImage) {
      toast.warning(imgGateTip);
      return;
    }
    const { text, refs } = composeMentionText(input);
    let realSid: string | null = sid == null || sid === NEW_SESSION_ID ? null : sid;
    // 新会话草稿态(sid 为占位符或尚未加载):先真正创建服务端会话(此时才列入历史会话列表),
    // 创建失败则保留输入与草稿,不发送
    if (sid == null || sid === NEW_SESSION_ID) {
      let created: any;
      try {
        created = await api.request('session_create', { transferFrom: draftSid || undefined }, 8000);
        realSid = created.active ?? null;
        activeRef.current = realSid; // 立即更新事件路由,不等 App 侧 state 同步
        skipHistoryOnceRef.current = true; // 跳过随后 sid 变化触发的历史回载(消息由事件流渲染)
        onSessionCreated?.(created); // App 刷新会话列表并激活新会话
      } catch (e) {
        toast.error(`新建会话失败: ${(e as Error).message}`);
        return;
      }
      // 草稿态权限模式落地:新会话已按服务端全局默认生效(session_create 回传
      // permissionMode)。用户手动改过且与服务端默认不一致时才提交 permission_set
      // (该档位同时成为新的全局默认,后续新会话继承);没手动改过则直接采纳默认,
      // 无需提交,避免把服务端默认误当"用户选择"而多写一条 mode 事件
      const seededPerm = isPermissionMode(created.permissionMode) ? created.permissionMode : 'confirm';
      if (permTouchedRef.current && permMode !== seededPerm) {
        try {
          await api.request('permission_set', { mode: permMode, sid: sidArg(realSid) }, 8000);
        } catch (e) {
          setPermMode(seededPerm);
          toast.error(`应用权限模式失败,本次按服务端默认「${seededPerm}」执行: ${(e as Error).message}`);
        }
      } else {
        setPermMode(seededPerm);
      }
    }
    // 发送即使用草稿:清除对应会话(或新会话)的输入草稿
    if (sid === NEW_SESSION_ID) delete draftsRef.current[NEW_DRAFT_KEY];
    else if (sid) delete draftsRef.current[sid];
    saveDrafts(draftsRef.current);
    setInput('');
    inputValueRef.current = ''; // 同步最新输入,防止随后的草稿保存把已发送文本回写
    clearAttachments(); // 附件随消息上行,清空草稿轨道并回收本地预览
    scrollToBottomNow(); // 发起对话:恢复吸附并回到底部,让用户新消息与回复立即可见
    setMessages((m) => [...m]);
    // 发送消息的那一刻即通知 App 锁定该会话的工作区(不等服务端 msgCount 落盘回传)。
    // 子智能体会话没有"工作区锁定"这回事(它继承父会话的绑定),不通知。
    if (!childMode) onSessionTouched?.(realSid);
    api.send('speak', { text, reasoning, sid: sidArg(realSid), ...(atts.length ? { attachments: atts } : {}), ...(refs.length ? { refs } : {}) });
  };

  // ---- 待执行队列操作 ----
  // 立即执行:把排队中的消息立即生效(忙碌时打断当前回复即时切换,空闲时直接开新轮)
  const runQueueNow = async (item: QueueItem) => {
    try {
      const r = await api.request('queue_steer', { id: item.id, sid: sidArg(sid) }, 8000);
      setQueue(Array.isArray(r.queue) ? r.queue : []);
      scrollToBottomNow(); // 用户主动执行:回到底部跟进新一轮回复
    } catch (e) { toast.error((e as Error).message); }
  };
  // 编辑:把排队中的消息撤回输入框重新编辑(该条先移出队列,发送后重新排队)
  const editQueueItem = async (item: QueueItem) => {
    try {
      const r = await api.request('queue_remove', { id: item.id, sid: sidArg(sid) }, 8000);
      setQueue(Array.isArray(r.queue) ? r.queue : []);
      restoreInputMentions(item.text);
      requestAnimationFrame(() => { const el = taRef.current; if (el) el.focus(); });
    } catch (e) { toast.error((e as Error).message); }
  };
  // 删除:直接从队列移除,不再执行
  const deleteQueueItem = async (item: QueueItem) => {
    const ok = await confirm({
      title: '删除排队消息',
      message: `从待执行队列中移除「${item.text}」?该消息将不再执行`,
      confirmLabel: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      const r = await api.request('queue_remove', { id: item.id, sid: sidArg(sid) }, 8000);
      setQueue(Array.isArray(r.queue) ? r.queue : []);
    } catch (e) { toast.error((e as Error).message); }
  };

  // ---- 命令卡片本地状态(role='command',仅前端可见,不持久化) ----
  // 系统命令(如 /compact)执行时插入消息流尾部显示「运行中」,异步完成后按 cmdId 原地更新。
  // 压缩成功时服务端广播 history_compacted 会重拉并整表替换历史;命令卡不持久化,重拉时
  // 只在"新历史里还没有持久压缩标记行"时才按 cmdId 接回尾部(见 utils/commandCard)。
  // 压缩本身的持久披露由「压缩标记行」(CompactionRow)承担:成功时它是这次 /compact 的
  // 唯一记录(命令卡让位,避免底部并排两条「已压缩 N 条早期消息」)。
  const cmdSeqRef = useRef(0);
  const pushCmd = (name: string, cmd: { state: 'running' | 'ok' | 'error'; text?: string }, id?: number) => {
    const cid = id ?? ++cmdSeqRef.current;
    // 只保留最新一条命令卡:再次执行同一命令时先移除上一条结果,避免底部累积多张卡片。
    // 压缩成功的持久披露由「压缩标记行」(CompactionRow)承担,命令卡只是本次命令的就地反馈。
    setMessages((msgs) => [...msgs.filter((m) => !m.command), { role: 'command', cmdId: cid, command: { name, ...cmd } }]);
    scrollToBottomNow();
    return cid;
  };
  const patchCmd = (id: number, patch: { state: 'running' | 'ok' | 'error'; text?: string }) => {
    setMessages((msgs) => msgs.map((m) => (m.cmdId === id
      ? { ...m, command: { state: patch.state, text: patch.text, name: m.command?.name || 'command' } }
      : m)));
  };

  // ---- / 命令菜单(照搬 deepseek-harness 的行内命令交互) ----
  // 系统命令:除技能外,提供常见会话操作(与 harness 的 command-compact/clear/fork 对齐)
  const slashCommands: SlashItem[] = [
    {
      name: 'compact', kind: 'command',
      description: '压缩当前会话上下文(把早期对话合并为摘要,释放窗口空间)',
      run: async () => {
        // 是否「正在运行」交给服务端裁决:前端 busy/agentState 由事件流维护,轮次异常收尾
        // 或切换会话都可能残留在 working。过去在这里本地拒绝,后果是请求从不发往后端
        // (表现为「压缩没反应、也没落盘」);后端会回「会话正在运行,请先停止或等待完成」,
        // 命令卡按同一条失败态呈现,语义不变但不再依赖前端视图状态。
        // 新会话草稿态还没有服务端会话可压缩:明确报错,而不是让请求落到别的会话上
        if (sid == null || sid === NEW_SESSION_ID) {
          pushCmd('compact', { state: 'error', text: '当前会话还没有内容,无法压缩;请先发一条消息' });
          return true;
        }
        const id = pushCmd('compact', { state: 'running', text: '正在压缩当前会话上下文…' });
        try {
          const r = await api.request('compact_now', { sid: sidArg(sid) }, 120000);
          // 压缩成功时服务端先广播 history_compacted → 前端重拉历史,持久「压缩标记行」
          // (CompactionRow)随之出现在对话末尾,成为这次压缩的唯一记录;命令卡被它取代。
          // 这里保留完成态只是兜底:万一事件重拉失败(标记行没进来),用户仍能看到结果。
          if (r.compacted) patchCmd(id, { state: 'ok', text: `已压缩 ${r.dropCount} 条早期消息,上下文空间已释放` });
          else patchCmd(id, { state: 'ok', text: '当前历史较短,无需压缩' });
        } catch (e) {
          // 压缩失败(如摘要生成失败/shrink 校验不通过):会话原样保留,
          // 命令卡显示失败原因(对齐 harness ManualCompactionError 的呈现)
          patchCmd(id, { state: 'error', text: (e as Error).message || '压缩失败,会话历史保持不变' });
        }
        return true;
      }
    },
    {
      // /计划(移植自 harness plan/plan-mode 的 /plan):进入/退出计划模式。
      // 计划模式 = 权限档位「计划模式」:写/执行类工具被 guard 直接拒绝,模型只调研并给出计划;
      // 模型可用 exit_plan_mode 把计划交你审阅,批准即退出计划模式。
      name: 'plan', kind: 'command', token: '计划',
      description: '进入或退出计划模式',
      run: async (query: string, ctx?: { attachments: any[] }) => {
        if (sid == null || sid === NEW_SESSION_ID) {
          pushCmd('plan', { state: 'error', text: '请先开始对话(或选好工作区)再切换计划模式' });
          return true;
        }
        const id = pushCmd('plan', { state: 'running', text: '正在切换计划模式…' });
        try {
          const r = await api.request('plan_command', { input: query || '', sid: sidArg(sid), attachments: ctx?.attachments || [] }, 20000);
          if (r.mode && isPermissionMode(r.mode)) setPermMode(r.mode);
          patchCmd(id, { state: r.kind === 'error' ? 'error' : 'ok', text: r.text });
        } catch (e) {
          patchCmd(id, { state: 'error', text: (e as Error).message || '计划模式切换失败' });
        }
        return true;
      }
    },
    {
      // /目标(移植自 harness command-goal 的 /goal):创建/查看/编辑/暂停/恢复/清除长期目标。
      // 目标 active 且已授权时,空闲会自动接着跑下一轮(轮次上限默认 256)。
      name: 'goal', kind: 'command', token: '目标',
      description: '设置或查看长期任务目标',
      run: async (query: string, ctx?: { attachments: any[] }) => {
        if (sid == null || sid === NEW_SESSION_ID) {
          pushCmd('goal', { state: 'error', text: '请先开始对话(或选好工作区)再设置目标' });
          return true;
        }
        const id = pushCmd('goal', { state: 'running', text: '正在处理目标…' });
        try {
          const r = await api.request('goal_command', { input: query || '', sid: sidArg(sid), attachments: ctx?.attachments || [] }, 20000);
          if (r.goal !== undefined) setGoal(r.goal ?? null);
          patchCmd(id, { state: r.kind === 'error' ? 'error' : 'ok', text: r.text });
        } catch (e) {
          patchCmd(id, { state: 'error', text: (e as Error).message || '目标操作失败' });
        }
        return true;
      }
    },
    {
      name: 'clear', kind: 'command',
      description: '清空当前会话的对话历史(含服务端持久化)',
      run: () => { clearAll(); return true; }
    },
    {
      name: 'fork', kind: 'command',
      description: '在当前会话基础上新建分支(保留原会话;不指定位置时从尾部开始)',
      run: () => {
        if (!onFork) { toast.warning('分支功能不可用'); return true; }
        onFork(-1); return true; // /fork 从会话尾部整体分支
      }
    },
    {
      name: 'help', kind: 'command',
      description: '查看可用命令',
      run: (q: string) => {
        api.send('speak', { text: '请用一句话列出当前可用的斜杠命令及其用途。', reasoning });
        updateInput('');
        return true;
      }
    }
  ];
  const slashAll: SlashItem[] = [...slashCommands, ...slashSkills];

  // 目标条动作(暂停/恢复/编辑/清除):与 /目标 命令共用同一条 RPC 与同一套语法
  // (harness 的 GoalBar 动作就是 /goal 子命令的语法子集),命令卡给出可见反馈。
  const runGoalAction = async (sub: string) => {
    if (sid == null || sid === NEW_SESSION_ID) return;
    setGoalPending(true);
    const id = pushCmd('goal', { state: 'running', text: '正在处理目标…' });
    try {
      const r = await api.request('goal_command', { input: sub, sid: sidArg(sid) }, 20000);
      if (r.goal !== undefined) setGoal((r.goal ?? null) as GoalInfo | null);
      patchCmd(id, { state: r.kind === 'error' ? 'error' : 'ok', text: r.text });
    } catch (e) {
      patchCmd(id, { state: 'error', text: (e as Error).message || '目标操作失败' });
    } finally {
      setGoalPending(false);
    }
  };

  // 拉取技能目录填充 slashSkills(未连接也返回内置+本机技能);仅首次(避免每次输入 / 都请求)
  const openSlash = () => {
    if (slashSkills.length > 0) return;
    api.request('skills_list', {}, 15000)
      .then((r) => setSlashSkills((r.skills || [])
        .filter((s: any) => s && s.name && s.description)
        .map((s: any) => ({ name: s.name, description: s.description, kind: 'skill' as const }))))
      .catch(() => {});
  };

  // 输入 / 唤醒菜单:行首 或 空白后 的 / 且其后是词尾时开启(对齐 harness 的 leadingInput,
  // 并支持选完技能后,在需求文字后再输空格 + / 继续追加技能)
  const syncSlash = (text: string) => {
    // 过滤词允许中日韩字符:中文 token(/计划、/目标)在输入途中也要能打开并过滤菜单
    const m = /(?:^|\s)\/([a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff-]*)$/i.exec(text);
    if (m) {
      setSlashQuery(m[1] || '');
      setSlashOpen(true);
      setSlashActive(0); // 过滤词变化:候选重排,高亮回到首项(否则会停在重排后的尾部)
      openSlash(); // 首次打开时拉取技能列表
    } else {
      setSlashOpen(false);
    }
  };
  const closeSlash = () => { setSlashOpen(false); setSlashActive(-1); };

  // 选中命令/技能:
  // - 技能:把末尾刚输入的 /词替换为 /name + 空格,整段文本仍是普通可编辑文本,
  //   叠加层按规则高亮显示;同一技能已完整存在于文本中则不重复插入
  // - 系统命令:直接执行(dispatch)
  const pickSlash = (item: SlashItem, query: string) => {
    if (item.kind === 'skill') {
      const name = item.name;
      // 把末尾刚输入的 /词替换为 /name + 空格(保留 / 前文字,整段文本仍可继续编辑,
      // 高亮叠加层负责把它显示为高亮 token)
      const m = /(^|\s)\/[a-z0-9-]*$/i.exec(input);
      const head = m ? input.slice(0, m.index + m[1].length) : input;
      // 去重必须只看 head(光标处这个 /词 之前的文本):拿整条 input 判断时,
      // 「刚刚输入/粘贴进来的 /技能名 本身」会被当成"已存在",补全退化成删除——
      // 粘贴含 /front-design 的文案后回车,技能名当场从输入框消失,只能重新输入。
      const already = new RegExp(`(?:^|\\s)/${escapeRe(name)}(?=\\s|$)`, 'i').test(head);
      const next = already ? head : `${head}/${name} `;
      updateInput(next);
      syncSlash(next);
      setSlashOpen(false);
      setSlashActive(-1);
      requestAnimationFrame(() => { const el = taRef.current; if (el) el.focus(); });
      return;
    }
    closeSlash();
    updateInput('');
    // 附件随命令上行(harness 的 /plan <message> 与 /goal <objective> 都接受附件):
    // 取"已上传完成"的附件元数据,由命令自己决定用法(/计划 off 会拒绝带附件)
    item.run?.(query, { attachments: attachments.filter((a) => a.att).map((a) => a.att!) });
  };

  // ---- @ 引用菜单(与 / 命令并行的行内交互) ----
  // 拉取候选(远程+本地工作区扁平化遍历);仅首次拉取,工作区切换后由 effect 重置再拉
  const openAt = () => {
    if (atLoadedRef.current) return;
    setAtLoading(true);
    const token = atFetchTokenRef.current; // 记录发起时的工作区/目录代际
    // 以文件面板当前打开的目录为遍历起点(未设置时服务端回落到对应工作区)
    api.request('ref_candidates', { remoteRoot: remoteCwd || '', localRoot: localCwd || '' }, 15000)
      .then((r) => {
        if (token !== atFetchTokenRef.current) return; // 期间工作区/目录已切换,丢弃旧候选
        setAtCandidates(Array.isArray(r.entries) ? r.entries : []);
        atLoadedRef.current = true;
      })
      .catch(() => { /* 拉取失败保留现状,下次输入 @ 时重试 */ })
      .finally(() => { if (token === atFetchTokenRef.current) setAtLoading(false); });
  };

  // 输入 @ 唤醒菜单:按「光标位置」判断 —— 光标前是行首/空白后的 @词 就开启。
  // 过去要求整条输入以 @词 结尾,于是「在已有文字中间插入引用」(@ 后面还跟着别的内容)
  // 永远弹不出菜单;现在只看光标前的文本,光标之后有什么都不影响。
  const syncAt = (text: string, caret?: number) => {
    const tok = atTokenAt(text, caret ?? text.length);
    if (tok) {
      atTokenRef.current = { start: tok.start, end: tok.end };
      setAtQuery(tok.query);
      setAtOpen(true);
      setAtActive(0); // 过滤词变化:候选重排,高亮回到首项(否则会停在重排后的尾部)
      openAt();
    } else {
      atTokenRef.current = null;
      setAtOpen(false);
    }
  };
  const closeAt = () => { setAtOpen(false); setAtActive(-1); atTokenRef.current = null; };

  // 选中候选:把光标处的 @词 替换为 @名称 + 空格(路径不进输入框),
  // 记录 名称 -> {路径,来源} 供发送时替换;同一名称已完整存在则不重复插入。
  // 替换区间优先用菜单打开时记录的 atTokenRef(支持在文本中间补全,光标之后的内容原样保留),
  // 区间失效(文本被外部改写)时回落到末尾词匹配。
  // 注意 already 需对 head(当前 @词 之前的保留文本)判断:若对 input 判断,
  // 刚输入的查询尾巴 @web 会被误判为"已存在",导致 @web 被清掉(引用"消失")。
  const pickAt = (item: AtCandidate, _query: string) => {
    const name = item.name;
    let start = input.length;
    let end = input.length;
    const tok = atTokenRef.current;
    if (tok && tok.start >= 0 && tok.end <= input.length && tok.start < tok.end
      && input[tok.start] === '@' && /^@[a-zA-Z0-9_.\-/\\]*$/.test(input.slice(tok.start, tok.end))) {
      start = tok.start;
      end = tok.end;
    } else {
      const m = /(^|\s)@[a-zA-Z0-9_.\-/\\]*$/i.exec(input);
      if (m) start = m.index + m[1].length;
    }
    const head = input.slice(0, start);
    const already = new RegExp(`(?:^|\\s)@${escapeRe(name)}(?=\\s|$)`, 'i').test(head);
    const insert = already ? '' : `@${name} `;
    // 吃掉一个相邻空白,避免在文本中间留下双空格:插入词自带尾随空格;
    // 去重删除时则是两侧各有一个空白相邻
    let tail = input.slice(end);
    const eatsSpace = insert ? /^[ \t]/.test(tail) : (/[ \t]$/.test(head) && /^[ \t]/.test(tail));
    if (eatsSpace) tail = tail.slice(1);
    const next = head + insert + tail;
    const caretAfter = head.length + insert.length;
    atMapRef.current.set(name, { path: item.path, source: item.source });
    updateInput(next);
    syncAt(next, caretAfter);
    setAtOpen(false);
    atTokenRef.current = null;
    setAtActive(-1);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (el) { el.focus(); el.setSelectionRange(caretAfter, caretAfter); }
    });
  };

  const stop = () => api.send('stop_agent', { sid: sidArg(sid) });

  // ---- 工作区切换(输入框下方):点击弹出下拉,切换/浏览选择工作区 ----
  const [wsBrowserOpen, setWsBrowserOpen] = useState(false);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  // ---- 本地工作区:与远程工作区并排,同样支持多个本地工作区 ----
  const [localWsBrowserOpen, setLocalWsBrowserOpen] = useState(false);
  const [localWsMenuOpen, setLocalWsMenuOpen] = useState(false);
  const wsBarRef = useRef<HTMLDivElement>(null);     // 远程工作区弹窗容器(chip + 下拉)
  const localWsBarRef = useRef<HTMLDivElement>(null); // 本地工作区弹窗容器(chip + 下拉)
  useEffect(() => {
    if (!wsMenuOpen && !localWsMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      // 只把「当前打开弹窗所在的容器(chip + 下拉)」视为内部区域:点击其中不关闭
      // (chip 的切换/选择由其 onClick 处理);点击该容器之外——包括 wsbar-row 里
      // 的其它位置、另一个 chip、模型菜单等——一律视为外部点击,关闭弹窗。
      const activeBar = wsMenuOpen ? wsBarRef.current : localWsBarRef.current;
      if (activeBar && activeBar.contains(e.target as Node)) return;
      setWsMenuOpen(false); setLocalWsMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [wsMenuOpen, localWsMenuOpen]);

  const setWorkspace = async (p: string) => {
    try {
      // sid:当前会话 id;草稿态(尚未创建服务端会话)传 null——服务端只改连接级工作区,
      // 不重绑旧会话;真正创建会话时(发送首条消息)会捕获"当时的连接工作区"作为自己的绑定
      await api.request('set_workspace', { path: p, sid: sid && sid !== NEW_SESSION_ID ? sid : null }, 20000);
      onWorkspaceSet(p); setWsBrowserOpen(false); setWsMenuOpen(false);
    } catch (e) { toast.error((e as Error).message); }
  };

  const setLocalWorkspace = (p: string) => {
    if (!onLocalWorkspaceSet) return;
    onLocalWorkspaceSet(p, sid && sid !== NEW_SESSION_ID ? sid : null); // App 内负责 set_local_workspace 请求 + 记录历史
    setLocalWsBrowserOpen(false); setLocalWsMenuOpen(false);
  };

  // 工作区 chip 的三态:绑定了目录 / 不使用工作区(边界=整台服务器·整台电脑)/ 尚未选择。
  // 图标与文案分开给:图标是内联 SVG(远程=云、本地=文件夹、不绑目录=整台机),颜色随 chip 文字色走
  const remoteChip = noWorkspace ? WHOLE_LABEL.remote : workspace ? lastPathSegment(workspace) : '选择远程工作区';
  const localChip = localNoWorkspace ? WHOLE_LABEL.local : localWorkspace ? lastPathSegment(localWorkspace) : '选择本地工作区';
  const remoteChipIcon = noWorkspace ? <IconServer16 size={13} /> : <IconCloud16 size={13} />;
  const localChipIcon = localNoWorkspace ? <IconDesktop16 size={13} /> : <IconFolder16 size={13} />;

  // 从历史中删除一条工作区记录:先确认(仅删快捷记录,不动远程/本地目录本身)
  const removeWs = async (p: string) => {
    const ok = await confirm({
      title: '删除工作区记录',
      message: `从历史记录中删除「${p}」?仅移除该工作区的快捷记录,不会删除远程目录本身`,
      confirmLabel: '删除',
      danger: true
    });
    if (!ok) return;
    onDeleteWs?.(p);
  };
  const removeLocalWs = async (p: string) => {
    const ok = await confirm({
      title: '删除本地工作区记录',
      message: `从历史记录中删除「${p}」?仅移除该工作区的快捷记录,不会删除本地目录本身`,
      confirmLabel: '删除',
      danger: true
    });
    if (!ok) return;
    onDeleteLocalWs?.(p);
  };

  // 发送后等待回答 / agent 工作期间都应允许暂停:busy(服务端 status) 与 agentState 任一命中即视为工作中
  const working = busy || agentState === 'working';
  // 运行状态行的已运行时长:working 期间每秒走一格(与 SessionHeader 的子代理时长同一做法)。
  // 起点只认**本轮**:本轮内容已上屏时取本轮 user 消息的发送时刻(切回运行中会话也准),
  // 本轮还没上屏(点击发送 → 服务端 status=running 先到,start/消息晚几帧到)则从现在起算,
  // 严格从 0 开始 —— 上一轮的旧时间戳不参与,否则第二轮一出现就是几十秒。
  //
  // 多会话并行 + 来回切换时还必须各算各的账,所以起点判定有两道闸:
  //   1) 只认**本会话**的 messages:切会话那一帧视图里还挂着上一个会话的内容(msgsSid 还是
  //      上一个会话),拿它当起点会把上一个会话已跑的时长原样搬到新会话上 —— 两个会话后面
  //      跟着同一个时间;本会话历史/事件一上屏(msgsSid 更新)立即重新认领;
  //   2) 从本会话消息里读出的**第一个**真实起点无条件采用(新会话可能是切过来的,它的起点
  //      未必比"现在"早);此后只允许往回校准一次,时长不倒退、不跳来跳去。
  //      旧写法只肯往回认(real < start 才算),于是第 1 道闸一旦漏掉那一帧、把上个会话的
  //      起点写进去,就再也纠不回来了。
  const [runningSec, setRunningSec] = useState(0);
  useEffect(() => {
    if (!working) { setRunningSec(0); return; }
    let anchored = false; // 是否已采用过来自**本会话**的真实起点
    let start = Date.now();
    const tick = () => {
      const now = Date.now();
      const real = msgsSid === sid
        ? liveTurnStartMs(messagesRef.current, now)
        : 0; // 屏幕上的内容还属于上一个会话:不认它
      if (real > 0 && (!anchored || real < start)) { start = real; anchored = true; }
      setRunningSec(Math.max(0, Math.floor((now - start) / 1000)));
    };
    tick(); // 立刻先出一格:首秒就有数字,不会先空一拍
    const timer = setInterval(tick, 1000);
    return () => { clearInterval(timer); };
  }, [working, sid, msgsSid]);
  // 一次性子智能体(显式 run_in_background:false):历史留在记录里,但不能再发消息 ——
  // 输入卡换成只读说明(dsh 的 SubagentReadOnlyComposer 接管规则)。可继续的照常给输入卡。
  const childOneShot = childMode && childInfo?.mode === 'one-shot';
  // 状态行文案只反映当前会话:imgJob 的 owner 不是当前 sid 时按「无生图在途」渲染,
  // 切会话瞬态(复位 effect 尚未跑)也不会把上一个会话的「正在生成图片」画到新会话上
  const rowImgJob = imgJob && (imgJob.owner == null || imgJob.owner === sid) ? imgJob : null;
  // 工作中也允许输入发送(自动进入待执行队列,当前轮结束后按序执行);
  // 发送条件:远程或本地任一侧「有工作区」或「已选择不使用工作区(整台服务器/整台电脑)」——
  // 两侧完全独立,只要有一侧确定了边界即可发起对话;两侧都没选则不允许发送。
  // 模型提问挂起时锁定输入与暂停(须先作答或取消提问);会话切换加载中也锁定,避免发到错误会话
  const canSend = (childMode || !!workspace || !!localWorkspace || noWorkspace || localNoWorkspace) && !askPending && !switching;

  // 一轮回复被重试提示拆成多段时,只有收尾那段承载收尾产物(已修改文件卡 / 复制 / 分支按钮);
  // 中间片段保持安静,避免重试一次就多出一套按钮。判定:该 assistant 之后、下一个 assistant
  // 之前是否夹着重试行(同轮内)。
  const fragmentIdx = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'assistant') continue;
    let sawRetry = false;
    for (let j = i + 1; j < messages.length; j++) {
      const x = messages[j];
      if (isRealUserRow(x)) break;
      if (x.role === 'assistant') { if (sawRetry) fragmentIdx.add(i); break; }
      if (x.role === 'notice' && x.retry) sawRetry = true;
    }
  }

  return (
    // 根为 fragment:跳转点(chat-dots)渲染在 chatwrap 之外,作为 tab-body 的子元素
    // 始终锚定对话区最左侧,不随限宽列移动(见 chat-dots 样式注释)
    <>
    <div className={`chatwrap${askPending ? ' ask-focus' : askChecking ? ' ask-boot' : ''}`} ref={wrapRef}>
      <div className="chat-scroll">
        <div className={`chat${suppressIn ? ' no-anim' : ''}`} ref={scrollRef} onScroll={onChatScroll}>
          {messages.length === 0 && (
            <div className="empty">
              <img className="empty-logo" src="/logo-256.png" alt="" />
              <div>{connected ? '连接服务器后:选远程工作区可远程+本地工作;只选本地工作区则仅在本机工作;也可选「不在工作区对话」让 AI 在整台机器上工作' : '未连接服务器 · 选择本地工作区后,即可让 Agent 在本机工作(或选「不在工作区对话」覆盖整台电脑)'}</div>
              <div className="muted">例如:「帮我看一下这个项目结构,然后修复 main.js 里的 bug」</div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.source?.form === 'notice' ? 'trigger' : m.role}${m.compaction ? ' compaction-msg' : ''}`} ref={(el) => { userMsgRefs.current[i] = el; }}>
              {m.compaction && (
                // 上下文压缩标记行(手动/自动):折叠展示摘要,展开看正文(样式参照 harness CompactionItem)
                <CompactionRow content={m.content || ''} dropCount={m.compaction.dropCount} manual={m.compaction.manual} running={!!m.compaction.running} failed={!!m.compaction.failed} reason={m.compaction.reason} />
              )}
              {m.command && (
                // 斜杠命令卡片(/compact 等):运行中/成功/失败的可见反馈(样式参照 harness GenericCommandCard)
                <CommandCard name={m.command.name} state={m.command.state} text={m.command.text} />
              )}
              {m.role === 'notice' && (m.retry
                // 模型请求失败进入重试:harness 风格单行折叠状态行(倒计时 + 可展开详情),非警示横幅
                ? <div className="retry-msg-wrap"><RetryRow data={m.retry} /></div>
                : <div className="bubble notice-bubble">⚠ {m.content}</div>)}
              {/* 非人类消息(source.form='notice':子代理结算 / 自动化任务 / 目标续跑……):
                  渲染成 dsh 的通知行 —— 图标 + 标题 + 时间,展开才看模型可见正文。
                  它**不是**用户气泡:没有删除/回退,也不参与"这句话是用户说的"那套操作栏。
                  `inline` = 运行中 steer 进来的(轮内送达):折叠行带一行账,不说"触发本轮"。 */}
              {m.role === 'user' && !m.compaction && m.source?.form === 'notice' && (
                <TurnTriggerRow source={m.source} content={m.content} time={m.time} inline={!!m.inline} />
              )}
              {m.role === 'user' && !m.compaction && m.source?.form !== 'notice' && (
                <>
                  <div className="bubble user-bubble">
                    {/* 目标自动续跑轮:不是用户打的字,气泡头标出「🎯 目标第 N 轮」 */}
                    {m.goalRound && (
                      <div className="goal-round-tag">🎯 目标第 {m.goalRound.round} 轮</div>
                    )}
                    {/* 附件(图片/文件)渲染在正文上方:单图 singleFit,多图方块平铺 */}
                    {!!m.attachments?.length && (
                      <MessageAttachments items={m.attachments} onOpen={setLightbox} />
                    )}
                    <MentionText text={m.content || ''} />
                  </div>
                  <div className="user-msg-foot">
                    {!!m.time && <span className="user-msg-time">{formatMsgTime(m.time)}</span>}
                    <UserMessageActions
                      text={displayMentionText(m.content || '')}
                      onDelete={childMode ? undefined : () => deleteMsg(m, i)}
                      onRewind={childMode ? undefined : () => rewindMsg(m, i)}
                    />
                  </div>
                  {/* 手动调用技能(`/技能名`):正文已注入本轮上下文,给出可见确认与正文预览 */}
                  {!!m.skillsInjected?.length && <LoadedSkillsRow skills={m.skillsInjected} />}
                </>
              )}
              {m.role === 'assistant' && (
                <div className="msg-col">
                  <div className="bubble ai-bubble">
                    {/* 回合过程折叠(对齐 dsh 的**两层**结构):
                        外层 TurnProcessNodeView = 一句「已完成,用时 2分19秒」▾,把整轮工具活动收起来,
                          展开后**完整铺开、不限高、不出滚动条**;
                        内层 ChatGroupSeat = 每个"一段工具活动"一个组头(「已读取文件并修改了文件」)▾,
                          组体限高 min(400px,50vh) 带上下渐隐 —— 与 dsh 逐条一致;
                        **正文段不参与折叠**:收起时只藏工具活动,回复正文始终可见。 */}
                    {(() => {
                      const segs = m.segments || [];
                      const units = planGroups(segs);
                      const hasProcess = units.some((u) => u.kind === 'group');
                      // 只有"已结束 且 有工具过程"的消息才有折叠行(进行中要能看着它干活)
                      const foldable = !m.streaming && hasProcess;
                      const foldOpen = foldable ? !!procFoldOpen[i] : true;
                      return (
                        <>
                          {foldable && (
                            <ProcessFold
                              reason={m.turnEndReason}
                              elapsedMs={m.turnElapsedMs}
                              open={foldOpen}
                              hasContent={hasProcess}
                              onToggle={() => setProcFoldOpen((s) => ({ ...s, [i]: !s[i] }))}
                            />
                          )}
                          {units.map((u, ui) => {
                            if (u.kind === 'text') {
                              // 正文段:AssistantSegment 按 text 引用 memo,历史段不变时跳过重渲染
                              return <AssistantSegment key={`t${u.index}`} text={segs[u.index]?.text || ''} />;
                            }
                            // 折叠时**隐藏而不是卸载**:内容留在 DOM 里(与 dsh 的
                            // hidden="until-found" 同效,浏览器页内查找仍能命中),
                            // 展开也不必重建终端/差异卡这些较重的小组件
                            return (
                              <div key={`g${ui}`} className="dsh-procslot"
                                hidden={foldable && !foldOpen ? true : undefined}>
                                {/* 与 dsh 同构的**两层**折叠:外层是整轮控件(「已完成,用时 X」),
                                    内层是过程组自己的组头(「已读取文件并修改了文件」),它的组体
                                    限高 min(400px,50vh) 并自带上下渐隐。
                                    别把内层设成 flat —— 那样"一段工具调用"就没有自己的折叠行了,
                                    与 dsh 的 ChatGroupSeat 不一致(见 test/subagent-ui.test.js)。 */}
                                <ProcessGroup summary={u.summary} live={isGroupLive(u.items)}
                                  collapsed={groupedFor(TRANSCRIPT_MODE, !!m.streaming)}>
                                  {u.memberIndexes.map((si) => {
                                    const seg = segs[si];
                                    if (!seg) return null;
                                    if (seg.kind === 'tools') {
                                      return (
                                        <ToolCallList key={si} tools={seg.tools || []}
                                          workspace={(connected ? workspace : localWorkspace) ?? undefined}
                                          onOpenSubagent={onOpenSubagent} onOpenImage={setLightbox} />
                                      );
                                    }
                                    // 思考段:折叠展示(照搬 dsh 的 ReasoningRow);
                                    // 流式时仅最后一段标记 running 获得扫光
                                    return <ReasoningSegment key={si} text={seg.text || ''}
                                      running={m.streaming && si === segs.length - 1} />;
                                  })}
                                </ProcessGroup>
                              </div>
                            );
                          })}
                        </>
                      );
                    })()}
                    {/* 这里刻意**不放光标/闪烁 caret**:dsh 全库没有任何光标,
                        流式进行中的信号由(1)正文文字本身在增长、(2)过程组头的扫光标题、
                        (3)输入框上方的「正在运行」状态行共同承担。加一个 caret 反而会
                        与扫光重复,并且让人误以为该位置可以输入。 */}
                    {/* 生图成图放在正文下方:先看完 AI 说了什么,再看它画出来的图。
                        与用户气泡同一套附件视图(单图大图、多图平铺),点击进灯箱 */}
                    {!!m.attachments?.length && (
                      <div className="ai-image-block">
                        <MessageAttachments items={m.attachments} onOpen={setLightbox} />
                        {!!m.imageJob && !m.imageJob.pending && (
                          <div className="ai-image-meta">
                            {m.imageJob.mode === 'i2i' ? '图生图' : '文生图'}
                            {m.imageJob.refs ? ` · 参考 ${m.imageJob.refs} 张` : ''}
                            {m.imageJob.ms ? ` · 耗时 ${Math.round(m.imageJob.ms / 1000)}s` : ''}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {/* 成果物卡片(present 工具交付的文件):语义与「文件已更改」不同 ——
                      那张答"改了什么",这张答"交给你什么"。先于改动卡显示,因为它是用户最关心的结论。
                      点击走与文件改动相同的打开路径(远程/本机各自分流) */}
                  {!m.streaming && !fragmentIdx.has(i) && !!m.deliverables?.length && (
                    <DeliverablesCard
                      files={m.deliverables}
                      cwd={connected ? workspace : localWorkspace}
                      onOpen={(f) => openDeliverable(f, false)}
                      onOpenAside={(f) => openDeliverable(f, true)}
                    />
                  )}
                  {/* 文件变更汇总卡:仅在本条回复结束(streaming=false)后展示「N 个文件已更改」(点击展开列表);
                      被重试拆出的中间片段不显示,卡片只挂在收尾那段(汇总整轮改动) */}
                  {!m.streaming && !fragmentIdx.has(i) && !!m.filesChanged?.length && (
                    <FilesChangedCard
                      items={m.filesChanged}
                      workspace={(connected ? workspace : localWorkspace) ?? undefined}
                      onOpenFile={onOpenFile}
                      onOpenLocalFile={onOpenLocalFile}
                      onOpenFileAside={onOpenFileAside}
                      onOpenLocalFileAside={onOpenLocalFileAside}
                      onOpenChanges={onOpenChanges}
                    />
                  )}
                  {!m.streaming && !fragmentIdx.has(i) && (
                    <MessageActions
                      text={segText(m)}
                      onBranch={() => onFork?.(m.forkTail ?? -1)}
                      elapsedMs={m.turnElapsedMs}
                      usage={m.turnUsage}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
          {/* 运行中指示行:agent 工作期间挂在消息列表末尾(StateDot ongoing 像素追光)。
              长耗时步骤(如大文件写入/命令执行)没有文本增量流出,此行让"仍在运行"
              可见,避免误以为卡死;提问挂起时 agent 在等用户作答,不算运行中。
              生图在途时复用同一行改文案(不再在气泡内另起一行),成图返回后自动变回原文案。
              「Agent 正在运行」后面跟已运行时长(中文,每秒递增一格,与「本轮用时」同一格式化器)。 */}
          {working && !askPending && !askChecking && (
            <div className={`running-row${rowImgJob ? ' image-waiting' : ''}`} role="status" aria-live="polite">
              <StateDot state="ongoing" size={12} />
              <span className="running-text">
                {rowImgJob
                  ? rowImgJob.mode === 'i2i'
                    ? `正在生成图片(图生图${rowImgJob.refs > 1 ? ` · 参考 ${rowImgJob.refs} 张` : ''})…`
                    : '正在生成图片…'
                  : `Agent 正在运行 ${runDurationText(runningSec * 1000)}…`}
              </span>
              {rowImgJob && <span className="running-hint">生图为同步等待,通常需 30 秒至数分钟</span>}
            </div>
          )}
        </div>
        {/* 回到底部悬浮按钮:用户上滑离开底部时出现(流式期间不被自动拉回,方便回看上下文),
            点击瞬时回底并恢复吸附。挂在 chat-scroll(定位宿主)内,贴对话区右下角 */}
        {showJump && (
          <button type="button" className="jump-bottom" onClick={scrollToBottomNow} aria-label="回到底部">
            <IconChevronDownOutline14 size={20} />
          </button>
        )}
      </div>
      {errorMsg && <div className="error">{errorMsg}</div>}
      {/* 任务计划面板:输入区玻璃面板之外,独立玻璃卡片悬浮(默认折叠;清单还有未完成项就一直显示,含跨轮,全部完成或无计划则隐藏) */}
      <TodoPanel todos={todos} />
      <div className="composer">
        {/* 子智能体会话的顶部提示:没有常驻实例(服务重启过)时说明"再发一条会把它恢复过来",
            但**不**顶掉输入框 —— 只有一次性派发才是真的不能再发。 */}
        {childMode && childInfo && childInfo.mode !== 'one-shot' && !childInfo.resident && (
          <div className="muted" data-subagent-dormant="" style={{ padding: '2px 6px 8px', fontSize: 12 }}>
            这个子智能体当前没有常驻实例(服务重启过):发一条消息会从运行记录里把它恢复过来继续跑。
          </div>
        )}
        {/* 模型提问面板(ask_user_question):内联显示在输入框上方,无遮罩;作答/取消前锁定输入。
            onBootChange:刷新后拉取挂起提问期间扣住输入区,防止"输入框→面板"闪跳 */}
        <AskPanel sid={sid} onPendingChange={setAskPending} onBootChange={setAskChecking} />
        {/* 待执行消息队列:对话进行中发送的消息在此排队等待,当前轮结束后按 FIFO 自动执行 */}
        <QueuePanel queue={queue} onRunNow={runQueueNow} onEdit={editQueueItem} onDelete={deleteQueueItem} />
        {/* 长期目标条(移植自 harness ui-goal 的 GoalBar):停在输入卡上方,目标已清除/已完成时不渲染 */}
        <GoalBar goal={goal} pending={goalPending}
          onPause={() => runGoalAction('pause')}
          onResume={() => runGoalAction('resume')}
          onClear={() => runGoalAction('clear')}
          onEdit={(objective) => runGoalAction(`edit ${objective}`)} />
        {/* 一次性子智能体:输入卡换成只读说明框(dsh 的 SubagentReadOnlyComposer)。
            可继续的子智能体与父会话一样,给完整输入卡。 */}
        {childOneShot ? (
          <SubagentReadOnlyComposer reason="one-shot" />
        ) : (
        <div className={`composer-box ${dragOver ? 'drag-over' : ''}`} ref={composerBoxRef}
          onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={(e) => { if (e.currentTarget.contains(e.relatedTarget as Node)) return; setDragOver(false); }}
          onDrop={(e) => {
            // 拖拽文件到输入卡:整批收纳(图片遵循多模态开关)
            if (!e.dataTransfer?.files?.length) return;
            e.preventDefault();
            setDragOver(false);
            intakeFiles(Array.from(e.dataTransfer.files));
          }}>
          {/* / 命令菜单:输入 / (行首或空格后)时浮在输入框上方,前缀优先+模糊匹配过滤。
              子智能体会话不提供:它的工具白名单里没有 skill,也没有任何会话级命令 */}
          {slashOpen && !childMode && (
            <SlashMenu
              items={slashAll}
              query={slashQuery}
              active={slashActive}
              onActiveChange={setSlashActive}
              onPick={pickSlash}
              onClose={closeSlash}
              anchorRef={composerBoxRef}
            />
          )}
          {/* @ 引用菜单:输入 @ 时浮在输入框上方,列出远程+本地工作区的文件/文件夹。
              子智能体会话不提供:@ 引用要由服务端在一轮里解析成路径提示,子代理这条链路不做这件事 */}
          {atOpen && !childMode && (
            <AtMenu
              items={atCandidates}
              loading={atLoading}
              query={atQuery}
              active={atActive}
              onActiveChange={setAtActive}
              onPick={pickAt}
              onClose={closeAt}
              anchorRef={composerBoxRef}
            />
          )}
          {/* 草稿附件轨道:粘贴/拖拽/上传的图片与文件(64px 缩略图卡,悬停删除) */}
          {attachments.length > 0 && (
            <AttachRail items={attachments} onRemove={removeAttachment}
              onOpen={(it) => setLightbox({ src: it.previewUrl, alt: it.name })} />
          )}
          <div className="composer-input">
            {/* 高亮叠加层:文字透明只露出 /技能名 与 @文件名 高亮底;pointer-events 穿透,不挡输入 */}
            <div className="composer-overlay" ref={overlayRef} aria-hidden="true">
              {tokenizeInput(input).map((s, i) => s.t === 'skill'
                ? <span className="composer-token" key={i}>{s.v}</span>
                : s.t === 'mention'
                  ? <span className="composer-mention" key={i}>{s.v}</span>
                  : <span key={i}>{s.v}</span>)}
              {input.endsWith('\n') && <span> </span>}
            </div>
            <textarea ref={taRef} rows={1} value={input}
              onChange={(e) => { const v = e.target.value; updateInput(v); syncSlash(v); syncAt(v, e.target.selectionStart ?? v.length); }}
              onScroll={syncOverlayScroll}
              onPaste={(e) => {
                // 粘贴图片/文件:拦截默认行为改为附件收纳(粘贴文本不受影响)
                const files = Array.from(e.clipboardData?.files || []);
                if (files.length > 0) { e.preventDefault(); intakeFiles(files); }
              }}
              placeholder={!connected && !localWorkspace && !localNoWorkspace ? '未连接服务器 · 选择本地工作区后即可对话'
                : !workspace && !localWorkspace && !noWorkspace && !localNoWorkspace ? '请先选择远程工作区或本地工作区(至少选一个:也可让该侧「不使用工作区」)'
                : noWorkspace && localNoWorkspace ? '不使用工作区 · 整台服务器 + 整台电脑(请让 AI 使用绝对路径)'
                : localNoWorkspace ? '不使用本地工作区 · 本机全盘(请让 AI 使用绝对路径)'
                : noWorkspace ? '不使用远程工作区 · 整台远程服务器(请让 AI 使用绝对路径)'
                : connected && !workspace ? '未选远程工作区 · 当前仅限本地工作区对话'
                : askPending ? '请先在提问面板中作答或取消…'
                : working ? 'Agent 工作中,发送后将进入队列等待执行…'
                // 生图对话:技能/文件引用不参与生图(提示词就是原文),占位符改讲本模式的用法
                : imageGen ? '描述要生成的图片;附带图片则图生图,之后每轮自动基于上一张成图继续修改…'
                : hasSkillToken ? '输入需求…' : '输入 @ 引用文件、/ 唤起命令与技能菜单…'}
              disabled={!canSend}
              onKeyDown={(e) => {
                // / 命令菜单打开时的键盘交互(对齐 harness):↑↓ 移动、Enter 选中、Esc 关闭、Tab 补全
                if (slashOpen) {
                  const list = rankSlashItems(slashAll, slashQuery).slice(0, SLASH_MENU_MAX); // 与菜单渲染上限一致,高亮不会落到未渲染的行
                  if (e.key === 'ArrowDown') { e.preventDefault(); setSlashActive((i) => (list.length ? (i + 1) % list.length : -1)); return; }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setSlashActive((i) => (list.length ? (i - 1 + list.length) % list.length : -1)); return; }
                  if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    // 菜单开着就绝不落进发送分支:那会把刚粘贴进来的 /技能名 当普通消息发走并清空输入框,
                    // 用户只能重新输入(技能列表还在异步加载、候选为空时最容易踩到)。
                    // 有候选则补全/执行,没有候选只收起菜单,输入原样保留,再按一次回车才是发送。
                    e.preventDefault();
                    const it = list.length ? list[slashActive >= 0 ? slashActive : 0] : null;
                    if (it) pickSlash(it, slashQuery); else closeSlash();
                    return;
                  }
                  if (e.key === 'Tab' && list.length) {
                    e.preventDefault();
                    const it = list[slashActive >= 0 ? slashActive : 0];
                    if (it) pickSlash(it, slashQuery);
                    return;
                  }
                }
                // @ 引用菜单打开时的键盘交互(与 / 菜单同款):↑↓ 移动、Enter/Tab 选中、Esc 关闭
                if (atOpen) {
                  const list = rankByName(atCandidates, atQuery).slice(0, AT_MENU_MAX); // 与菜单渲染上限一致,高亮不会落到未渲染的行
                  if (e.key === 'ArrowDown') { e.preventDefault(); setAtActive((i) => (list.length ? (i + 1) % list.length : -1)); return; }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setAtActive((i) => (list.length ? (i - 1 + list.length) % list.length : -1)); return; }
                  if (e.key === 'Escape') { e.preventDefault(); closeAt(); return; }
                  if (e.key === 'Enter' && !e.shiftKey && list.length) {
                    e.preventDefault();
                    const it = list[atActive >= 0 ? atActive : 0];
                    if (it) pickAt(it, atQuery);
                    return;
                  }
                  if (e.key === 'Tab' && list.length) {
                    e.preventDefault();
                    const it = list[atActive >= 0 ? atActive : 0];
                    if (it) pickAt(it, atQuery);
                    return;
                  }
                }
                // 退格整词删除:光标紧邻完整 /技能名 或 @文件名(行首/空白后、后跟空白或结尾)时,
                // 一整个删除(连同其后单个空格,避免留下双空格)
                if (!slashOpen && !atOpen && e.key === 'Backspace') {
                  const el = e.currentTarget as HTMLTextAreaElement;
                  if (el.selectionStart === el.selectionEnd) {
                    const pre = el.value.slice(0, el.selectionStart);
                    const m = /(^|\s)((?:\/[a-z0-9][a-z0-9-]*)|(?:@[a-zA-Z0-9_.\-/\\]+))[ \t]?$/i.exec(pre);
                    if (m) {
                      e.preventDefault();
                      // 删除 @引用 时同步清理其 名称->路径 解析,避免残留脏引用
                      const token = m[2].trim();
                      if (token.startsWith('@') && atMapRef.current.has(token.slice(1))) {
                        atMapRef.current.delete(token.slice(1));
                      }
                      let end = el.selectionStart;
                      // m[2] 未带尾随空格且光标后紧跟一个空格时一并删掉,避免留下双空格
                      if (!/[ \t]$/.test(m[2]) && /[ \t]/.test(el.value[end] || '')) end += 1;
                      const start = el.selectionStart - m[2].length;
                      const next = el.value.slice(0, start) + el.value.slice(end);
                      updateInput(next);
                      syncSlash(next);
                      syncAt(next, start);
                      requestAnimationFrame(() => {
                        const t = taRef.current;
                        if (t) { t.setSelectionRange(start, start); t.focus(); }
                      });
                      return;
                    }
                  }
                }
                // 桌面:Enter 发送 / Shift+Enter 换行;手机(compact):Enter 换行,发送只走按钮(与 IM 习惯一致)
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !compact) { e.preventDefault(); send(); }
                else if (e.key === 'Escape') updateInput('');
              }} />
          </div>
          <div className="composer-foot">
            {/* 左下角:"+"上传附件菜单(图片/文件)+ AI 访问权限模式。
                图片项仅在模型开启多模态时可用(关闭时给出原因提示) */}
            <div className="composer-foot-left">
            {/* 子智能体会话:上传附件与 / 技能、@ 引用都不适用(它只读,也拿不到附件),整块入口收起 */}
            {!childMode && (
            <div className="composer-add-wrap" ref={addWrapRef}>
              <button type="button" className={`composer-add ${addMenuOpen ? 'on' : ''}`}
                aria-label="添加附件" aria-haspopup="menu" aria-expanded={addMenuOpen}
                onClick={() => setAddMenuOpen((v) => !v)}>＋</button>
              {addMenuOpen && createPortal(
                (() => {
                  // portal 定位:菜单底边锚定"+"按钮上方 10px(msm/ws-pick 同语义)。
                  // 用 bottom 而非 top+translateY(-100%):入场动画 glass-pop 的 transform
                  // 会临时覆盖静态位移,造成先垂在下方、动画结束瞬移上去的抖动
                  const chipR = addWrapRef.current?.getBoundingClientRect();
                  const pos = chipR
                    ? { left: Math.max(8, chipR.left), bottom: Math.max(12, window.innerHeight - chipR.top + 10) }
                    : undefined;
                  return (
                    <div className="add-menu" role="menu" aria-label="选择上传类型" style={pos}>
                      <button type="button" role="menuitem" className={`add-menu-item ${canSendImage ? '' : 'disabled'}`}
                        data-tip={canSendImage ? undefined : imgGateTip}
                        onClick={() => {
                          if (!canSendImage) { toast.warning(imgGateTip); return; }
                          setAddMenuOpen(false); imgInputRef.current?.click();
                        }}>
                        <span className="am-ico" aria-hidden>🖼</span>
                        <span className="am-main">
                          <span>图片</span>
                          <span className="am-desc">{imageGen ? '作为图生图的参考图(可多张)' : canSendImage ? 'PNG / JPG / WebP / GIF…' : '当前模型不支持图片输入'}</span>
                        </span>
                      </button>
                      <button type="button" role="menuitem" className="add-menu-item"
                        onClick={() => { setAddMenuOpen(false); fileInputRef.current?.click(); }}>
                        <span className="am-ico" aria-hidden>📎</span>
                        <span className="am-main">
                          <span>文件</span>
                          <span className="am-desc">任意类型,文本文件会随消息发给 AI</span>
                        </span>
                      </button>
                    </div>
                  );
                })(),
                document.body
              )}
              {/* 隐藏的选择器:菜单项触发,选择后立即上传收纳;onChange 后清空 value 以便重复选择同一文件 */}
              <input ref={imgInputRef} type="file" accept="image/*" multiple hidden
                onChange={(e) => { intakeFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
              <input ref={fileInputRef} type="file" multiple hidden
                onChange={(e) => { intakeFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
            </div>
            )}
            {/* AI 访问权限模式(变更前确认/自动编辑/计划模式/完全访问)。
                仅切换中锁定;草稿态(新会话)也开放选择:模式先存本地,随 session_create 落地。
                子智能体会话不给这个选择器:它的权限在派发时固定,不能从会话内部放宽(harness 同语义) */}
            {!childMode && (
              <PermissionSelect value={permMode} disabled={switching}
                onChange={changePermMode} anchorRef={composerBoxRef} />
            )}
            <span className="muted composer-tip">{compact ? '点右侧发送按钮 · 换行直接回车' : 'Enter 发送 · Shift+Enter 换行'}</span>
            </div>
            <ContextMeter messages={messages} input={composedInput}
              contextWindow={llm.effModelContext?.contextWindow || 0} usage={ctxUsage} />
            {/* 工作中且输入框为空(且无附件):显示停止按钮;有内容/附件时变为发送按钮,
                发送后默认进入待执行队列等待执行 */}
            {working && !askPending && !input.trim() && attachments.length === 0
              ? <button className="send-btn stop" onClick={stop} aria-label="停止当前任务"><IconStop16 size={15} /></button>
              : <button className="send-btn"
                  aria-label={working ? 'Agent 工作中,发送后进入队列等待执行' : '发送'}
                  disabled={!canSend || (!input.trim() && attachments.length === 0)} onClick={send}><IconSend16 size={15} /></button>}
          </div>
        </div>
        )}
        {/* 工作区 + 模型:工作区在左,模型在右;模型为二级菜单(模型清单按提供商分组 / 推理等级) */}
        <div className="wsbar-row">
          {childMode ? (
            /* 子智能体会话:工作区与模型都继承父会话(harness 的子代理路由也是继承来的),
               所以这里不给可切换的 chip,只如实说明;统计行仍然照常显示。 */
            <span className="muted tb-model" data-tip="子智能体继承父会话的连接、工作区与模型:它不能自己换工作区,模型也跟随父会话">
              子智能体会话 · 继承父会话的工作区与模型
            </span>
          ) : (<>
          {connected && (
            <div className="wsbar" ref={wsBarRef}>
              <button
                className={`ws-chip ${workspace || noWorkspace ? '' : 'none'}${remoteLocked ? ' locked' : ''}${wsMenuOpen ? ' open' : ''}`}
                disabled={remoteLocked}
                data-tip={remoteLocked ? '该会话已开始对话,远程工作区已锁定;如需更换请新建会话'
                  : noWorkspace ? `「不使用工作区」:AI 可读写整台远程服务器(必须传绝对路径),点击切换回某个目录工作区` : undefined}
                onClick={() => { if (!remoteLocked) { setWsMenuOpen((v) => !v); setLocalWsMenuOpen(false); } }}
              >
                <span className="ws-chip-path">
                  <span className="ws-chip-ico">{remoteLocked ? <IconLock16 size={12} /> : remoteChipIcon}</span>
                  <span className="ws-chip-name">{remoteChip}</span>
                </span>
                <span className="ws-chip-arrow"><IconChevronDownOutline14 size={13} /></span>
              </button>
              {wsMenuOpen && (
                <div className="ws-pick" onClick={(e) => e.stopPropagation()}>
                  {savedWs.length === 0 ? (
                    <div className="muted ws-pick-empty">还没有已保存的工作区</div>
                  ) : (
                    <div className="ws-pick-list">
                      {savedWs.map((p) => (
                        <div key={p} className={`ws-pick-item ${workspace === p ? 'on' : ''}`}>
                          <button type="button" className="ws-pick-main"
                            data-tip={p}
                            onClick={() => setWorkspace(p)}>
                            <span className="ws-pick-path">{lastPathSegment(p)}</span>
                            {workspace === p && <span className="ws-pick-cur">✓</span>}
                          </button>
                          <button type="button" className="ws-pick-del" aria-label={`从历史中删除工作区 ${p}`}
                            onClick={() => removeWs(p)}><IconTrashOutline14 size={13} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="ctx-sep" />
                  <button className="ws-pick-item ws-pick-action" onClick={() => { setWsMenuOpen(false); setWsBrowserOpen(true); }}>
                    <IconFolder16 size={13} />
                    <span>浏览选择其他目录…</span>
                  </button>
                  {home && (
                    <button className="ws-pick-item ws-pick-action" onClick={() => setWorkspace(home)}>
                      <IconHome16 size={13} />
                      <span>家目录</span>
                    </button>
                  )}
                  {/* 不使用工作区:不绑定任何目录,边界放宽到整台远程服务器。与本地侧完全独立 */}
                  <button className={`ws-pick-item ws-pick-action${noWorkspace ? ' on' : ''}`}
                    data-tip="不绑定远程工作目录:AI 可在整台远程服务器上读写文件与执行命令(必须使用绝对路径)。仅影响远程侧,与本地工作区互不影响"
                    onClick={() => setWorkspace(NO_WORKSPACE)}>
                    <IconServer16 size={13} />
                    <span>不使用工作区(整台服务器){noWorkspace ? ' ✓' : ''}</span>
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="wsbar" ref={localWsBarRef}>
            <button
              className={`ws-chip local ${localWorkspace || localNoWorkspace ? '' : 'none'}${localLocked ? ' locked' : ''}${localWsMenuOpen ? ' open' : ''}`}
              disabled={localLocked}
              data-tip={localLocked ? '该本地会话已开始对话,本地工作区已锁定;如需更换请新建会话'
                : localNoWorkspace ? `「不使用工作区」:AI 可读写这台电脑的整个「此电脑」(所有盘符,必须传绝对路径),点击切换回某个目录工作区` : undefined}
              onClick={() => { if (!localLocked) { setLocalWsMenuOpen((v) => !v); setWsMenuOpen(false); } }}
            >
              <span className="ws-chip-path">
                <span className="ws-chip-ico">{localLocked ? <IconLock16 size={12} /> : localChipIcon}</span>
                <span className="ws-chip-name">{localChip}</span>
              </span>
              <span className="ws-chip-arrow"><IconChevronDownOutline14 size={13} /></span>
            </button>
            {localWsMenuOpen && (
              <div className="ws-pick" onClick={(e) => e.stopPropagation()}>
                {savedLocalWs.length === 0 ? (
                  <div className="muted ws-pick-empty">还没有已保存的本地工作区</div>
                ) : (
                  <div className="ws-pick-list">
                    {savedLocalWs.map((p) => (
                      <div key={p} className={`ws-pick-item ${localWorkspace === p ? 'on' : ''}`}>
                        <button type="button" className="ws-pick-main"
                          data-tip={p}
                          onClick={() => setLocalWorkspace(p)}>
                          <span className="ws-pick-path">{lastPathSegment(p)}</span>
                          {localWorkspace === p && <span className="ws-pick-cur">✓</span>}
                        </button>
                        <button type="button" className="ws-pick-del" aria-label={`从历史中删除本地工作区 ${p}`}
                          onClick={() => removeLocalWs(p)}><IconTrashOutline14 size={13} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="ctx-sep" />
                <button className="ws-pick-item ws-pick-action" onClick={() => { setLocalWsMenuOpen(false); setLocalWsBrowserOpen(true); }}>
                  <IconFolder16 size={13} />
                  <span>浏览选择其他本地目录…</span>
                </button>
                {/* 不使用工作区:不绑定任何目录,边界放宽到整台电脑(此电脑/所有盘符)。与远程侧完全独立 */}
                <button className={`ws-pick-item ws-pick-action${localNoWorkspace ? ' on' : ''}`}
                  data-tip="不绑定本地工作目录:AI 可读写这台电脑的任何位置(C 盘、D 盘…统称「此电脑」),必须使用绝对路径。仅影响本地侧,与远程工作区互不影响"
                  onClick={() => setLocalWorkspace(NO_WORKSPACE)}>
                  <IconDesktop16 size={13} />
                  <span>不使用工作区(整台电脑){localNoWorkspace ? ' ✓' : ''}</span>
                </button>
              </div>
            )}
          </div>
          <div className="grow" />
          {/* 模型选择(二级菜单):mock 联调模式仅展示,不可切换 */}
          {llm.isMock ? (
            <span className="muted tb-model" data-tip="mock 联调模式,无需 API Key">mock 模式</span>
          ) : (
            <ModelMenu reasoning={reasoning} onChangeReasoning={changeReasoning} />
          )}
          {/* 自定义模型输入:当前提供方无预置模型,或选中「自定义模型…」时显示 */}
          {!llm.isMock && (llm.model === '__custom__' || llm.provider.models.length === 0) && (
            <input className="tb-model"
              value={llm.model === '__custom__' ? llm.customModel : llm.model}
              onChange={(e) => { if (llm.model === '__custom__') llm.setCustomModel(e.target.value); else llm.setModel(e.target.value); }}
              placeholder="自定义模型名"
              data-tip="输入模型名" />
          )}
          </>)}
        </div>
        {/* 对话统计(轮/步 · 解码速度、token 总量/缓存命中率):服务端 fold 整个会话日志得出。
            独立成行铺在面板最底部 —— 不再嵌进输入卡玻璃盒(那里是操作按钮的地盘)。
            这一行与里面的两个胶囊**始终占位**(统计未到手时显示 `0 轮 0 步` / `0 tok`):
            高度恒定,首批统计到齐时不会把输入区与对话区顶上去,避免页面抖动。
            点击胶囊在其上方弹出明细 */}
        <div className="composer-stats">
          <StatsPills usage={sessionUsage} stats={sessionStats} />
        </div>
      </div>
      {wsBrowserOpen && (
        <DirBrowser initial={workspace || home || '/'} home={home} onClose={() => setWsBrowserOpen(false)} onPick={setWorkspace} />
      )}
      {localWsBrowserOpen && (
        <LocalDirBrowser initial={localWorkspace || localHome || undefined} home={localHome} onClose={() => setLocalWsBrowserOpen(false)} onPick={setLocalWorkspace} />
      )}
    </div>
    {/* 附件灯箱:草稿轨道与消息里的图片点击放大(Esc/点击遮罩关闭) */}
    <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
    {/* 用户消息轮次导轨(一轮用户消息一条细刻度):absolute 贴对话区(main 内、sidebar 右侧)最左侧,
        不随限宽的聊天内容移动,也不钉在浏览器窗口最左。渲染在 chatwrap 之外:
        chatwrap 是滚动条拇指宿主、会被设为定位元素,放里面会被重新锚定到限宽列。
        刻度与悬停手感照搬 harness TurnNavigator:指针沿导轨滑动时,预览卡跟着刻度中心迁移 */}
    {userMsgIndices.length > 1 && (
      <nav
        className="chat-dots"
        aria-label="用户消息跳转"
        onPointerEnter={() => { dotPointerInsideRef.current = true; }}
        onPointerLeave={() => { dotPointerInsideRef.current = false; setPreviewDot(null); }}
      >
        <div
          ref={dotScrollerRef}
          className={`chat-dots-scroller${dotFade.top ? ' fade-top' : ''}${dotFade.bottom ? ' fade-bottom' : ''}`}
          onScroll={syncDotRail}
        >
          <div className="chat-dots-marks">
            {userMsgIndices.map((idx, d) => (
              <button
                key={idx}
                ref={(el) => { dotRefs.current[d] = el; }}
                type="button"
                className={`chat-dot${idx === activeDot ? ' on' : ''}${d === previewDot ? ' preview' : ''}`}
                aria-label={`跳转到第 ${d + 1} 条用户消息`}
                aria-current={idx === activeDot ? 'true' : undefined}
                aria-describedby={d === previewDot ? dotPreviewId : undefined}
                onPointerMove={() => { setPreviewDot(d); }}
                onFocus={() => { setPreviewDot(d); }}
                onBlur={() => { setPreviewDot(null); }}
                onClick={() => jumpToMsg(idx)}
              />
            ))}
          </div>
        </div>
        {/* 悬停/聚焦预览(harness preview):一行提问 + 至多三行回复,位置随刻度中心平滑迁移 */}
        {dotPreview && (
          <div
            className="chat-dots-preview"
            id={dotPreviewId}
            style={{ '--dot-preview-center': `${dotPreviewCenter}px` } as React.CSSProperties}
          >
            <div className="chat-dots-preview-prompt">{dotPreview.prompt || `第 ${dotPreview.turn} 轮`}</div>
            {dotPreview.response !== '' && (
              <div className="chat-dots-preview-response">{dotPreview.response}</div>
            )}
          </div>
        )}
      </nav>
    )}
    </>
  );
}