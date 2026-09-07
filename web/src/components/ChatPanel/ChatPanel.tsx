import React, { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../../api';
import { useLlm } from '../../context/llm-context';
import type { ChatMessage, MsgSegment, ToolCallInfo, TodoItem, FileChangeItem } from '../../types';
import DirBrowser from '../DirBrowser/DirBrowser';
import LocalDirBrowser from '../DirBrowser/LocalDirBrowser';
import ModelMenu from '../ModelMenu/ModelMenu';
import ContextMeter, { type ContextUsage } from '../ContextMeter/ContextMeter';
import TodoPanel from '../TodoPanel/TodoPanel';
import SlashMenu, { rankSlashItems, rankByName } from '../SlashMenu/SlashMenu';
import type { SlashItem } from '../SlashMenu/SlashMenu';
import AtMenu from '../AtMenu/AtMenu';
import type { AtCandidate } from '../AtMenu/AtMenu';
import { useFeedback } from '../../context/feedback';
import AskPanel from '../AskPanel/AskPanel';
import QueuePanel, { QueueItem } from '../QueuePanel/QueuePanel';
import PermissionSelect, { isPermissionMode } from '../PermissionSelect/PermissionSelect';
import type { PermissionMode } from '../PermissionSelect/PermissionSelect';
import { ToolCallList } from '../ToolCallList/ToolCallList';
import { ReasoningRow } from '../ReasoningRow/ReasoningRow';
import { CompactionRow } from './CompactionRow';
import { FilesChangedCard } from './FilesChangedCard';
import { CommandCard } from './CommandCard';
import { refreshOverlayScrollbar, setScrollbarHost } from '../../utils/scrollbar-ui';
import { StateDot } from '../StateDot/StateDot';
import { IconChevronDownOutline14 } from '../icons/icons';
import { AttachRail, MessageAttachments, Lightbox, classifyKind } from '../Attachments/Attachments';
import type { ComposerAttachment, LightboxSrc } from '../Attachments/Attachments';
import type { AttachmentInfo } from '../../types';
import './ChatPanel.scss';

// 新会话(尚未创建服务端会话)的前端占位 sid:用于"草稿式"新建——
// 点击「新建」只进入空对话的草稿态,不创建服务端会话、不进入历史列表;
// 发送首条消息时才真正 session_create,创建后按会话内容出现在历史会话列表。
export const NEW_SESSION_ID = '__new__';

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

// 完整 Markdown 解析(marked + DOMPurify):
// gfm 支持表格/任务列表等,breaks 保留单换行即换行的聊天习惯;
// 输出再经 DOMPurify 白名单清洗,AI 内容里即使夹带 HTML 也不会注入。
const mdParser = new Marked({ gfm: true, breaks: true });

// 推理等级定义与选择器已迁移到 ModelMenu.tsx(REASONING_LEVELS + 二级菜单)。

// ---------------- markdown 渲染(完整排版,白名单清洗后输出) ----------------
function renderMarkdown(text = '') {
  if (!text || !text.trim()) return '';
  // Marked 同步模式下 parse 返回 string(异步 mode 才返回 Promise)
  const html = mdParser.parse(text) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
// 提取 ```thinking …``` 块为折叠行(ReasoningRow,与 reasoning 通道同款呈现),
// 剩余文本交给 AssistantText 继续渲染;当正文只由 thinking 块组成(纯推理回复)时,返回 null。
function renderAssistantContent(content = '') {
  const blocks: React.ReactElement[] = [];
  const rest = content.replace(/```thinking\s*([\s\S]*?)```/g, (_m, t) => {
    blocks.push(<ReasoningRow key={blocks.length} text={t.trim()} />);
    return '';
  });
  if (!blocks.length) return null; // 无 thinking 块:交给调用方直接渲染
  const restHtml = rest.trim();
  return (
    <>
      {blocks}
      {restHtml && <AssistantText text={rest} />}
    </>
  );
}

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

// 文本段 memo:按 text 引用判定,未变化的历史段整体跳过重渲染(含 markdown 解析)。
// 流式增量每次赋值新字符串,正在流的段仍正常更新。
const AssistantText = memo(function AssistantText({ text }: { text: string }) {
  const spans: React.ReactNode[] = [];
  const parts = text.split(/(```[\s\S]*?```)/g);
  parts.forEach((part, i) => {
    if (part.startsWith('```')) {
      const code = part.slice(3, part.length - 3);
      spans.push(<pre key={i}><code>{code}</code></pre>);
    } else if (part.trim()) {
      spans.push(<div key={i} className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(part) }} />);
    }
  });
  return <>{spans}</>;
});

// 段级渲染 memo(正文/思考):历史段内容引用未变时整体跳过,长会话的流式更新、
// 输入与面板重渲染不再拖着全部消息重跑 thinking 提取与 markdown 解析;
// 正在流式更新的段(text 每次增量都是新字符串)依旧正常渲染。
const AssistantSegment = memo(function AssistantSegment({ text }: { text: string }) {
  return <div>{renderAssistantContent(text) || <AssistantText text={text} />}</div>;
});
const ReasoningSegment = memo(function ReasoningSegment({ text, running }: { text: string; running?: boolean }) {
  return text && text.trim() ? <ReasoningRow text={text.trim()} running={running} /> : null;
});

// 消息操作栏(照搬 deepseek-harness 的 MessageIconActions):
// - 复制:复制该条回复的全文,成功后图标短暂换成 ✓(1s)
// - 分支:从这条回复处开启新会话继续——作用于任意一条历史消息,不只最新一条;
//   新会话克隆到该条回复为止的事件日志,后续对话从分支点另起炉灶(原会话保留)
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

function MessageActions({ text, onBranch }: {
  text: string;
  onBranch?: () => void;
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
    <div className="msg-actions">
      <button type="button" className="msg-action action-icon" aria-label="复制"
        data-tip={copied ? '已复制' : '复制'} onClick={onCopy}>
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
      {onBranch && (
        <button type="button" className="msg-action action-icon" aria-label="在新对话中分支"
          data-tip="在新对话中分支"
          onClick={onBranch}>
          <IconBranch />
        </button>
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
  onDelete: () => void;
  onRewind: () => void;
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
      <button type="button" className="msg-action action-icon" aria-label="复制"
        data-tip={copied ? '已复制' : '复制'} onClick={onCopy}>
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
      <button type="button" className="msg-action action-icon danger" aria-label="删除消息"
        data-tip="删除消息" onClick={onDelete}>
        <IconTrash />
      </button>
      <button type="button" className="msg-action action-icon" aria-label="回到本轮对话发起前"
        data-tip="回到本轮对话发起前" onClick={onRewind}>
        <IconRewind />
      </button>
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

// ---- 文件变更汇总:从消息的工具调用 meta 聚合「N 个文件已更改」卡片数据 ----
// 文件类工具(write/edit/delete × 远程/本地)在 tool_result 附加 card='diff' 的改动卡
// (path/kind/addLines/delLines);同文件多次操作按路径合并增删行数,kind 删除优先。
const FILE_CHANGE_KINDS = new Set(['create', 'write', 'edit', 'delete']);
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
      const cur = byPath.get(m.path);
      if (!cur) { byPath.set(m.path, { path: m.path, kind, addLines: add, delLines: del }); continue; }
      cur.addLines += add;
      cur.delLines = del !== null ? (cur.delLines ?? 0) + del : cur.delLines;
      if (kind === 'delete') cur.kind = 'delete'; // 删除是文件的最终状态
    }
  }
  // 按路径排序,展示顺序稳定
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
// 消息结束(完成/停止/出错)或历史回放时,把聚合结果挂到 assistant 消息上
function attachFileChanges(msg: ChatMessage | undefined) {
  if (msg && msg.role === 'assistant') msg.filesChanged = collectFileChanges(msg);
}

// 把服务端持久化的 turns 转成渲染消息数组:
// 一次 run 的多轮 assistant/tool 在渲染上合并为一条回复,按「思考 / 文本 / 连续工具组」实际发生顺序分段
function turnsToMessages(turns: any[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // 先扫一遍把工具结果聚齐:历史 turns 的顺序是 assistant(含 tool_calls)在前、
  // tool(执行结果)在后,若边循环边查 map,处理 assistant 时结果还没写入,
  // 会漏配导致工具永远显示"执行中"。预扫后无论顺序如何都能配对成功。
  const toolById = new Map<string, ToolCallInfo>(); // tool_call_id -> {tool, ok, ms?, result}
  for (const t of turns) {
    if (t && t.role === 'tool' && t.tool_call_id) {
      const id = String(t.tool_call_id);
      toolById.set(id, { tool: t.tool_name, args: t.tool_args, ok: t.ok ?? true, ms: t.ms, result: t.content || '', meta: t.meta });
    }
  }
  for (let ti = 0; ti < turns.length; ti++) {
    const t = turns[ti];
    if (t.role === 'tool') {
      // 工具结果并入所在回复,该消息的分支点随之推进到这条 turn
      const last = out[out.length - 1];
      if (last) last.forkTail = ti;
      continue; // tool 消息本身不渲染,只作为结果并入上游工具组
    }
    if (t.role === 'user') {
      out.push({
        role: 'user', content: t.content || '', forkTail: ti, time: t.time,
        // 附件元数据随历史回放,用户气泡内渲染缩略图/文件 chip
        ...(Array.isArray(t.attachments) && t.attachments.length ? { attachments: t.attachments } : {}),
        ...(t.compaction ? { compaction: t.compaction } : {})
      });
      continue;
    }
    if (t.role === 'assistant') {
      const calls = t.tool_calls_json ? JSON.parse(t.tool_calls_json) : (t.tool_calls || []);
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
        prev.forkTail = ti;
      } else {
        const nm: ChatMessage = { role: 'assistant', segments: [], streaming: false, forkTail: ti };
        if (t.reasoning_content) appendReasoning(nm, t.reasoning_content);
        appendText(nm, t.content);
        appendTools(nm, tools);
        out.push(nm);
      }
      continue;
    }
    // 其余角色跳过
  }
  // 文件变更汇总:历史回放的工具 meta 已随 tool/result 持久化,按消息聚合挂载
  for (const m of out) if (m.role === 'assistant') attachFileChanges(m);
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
  /** 会话发送了首条消息(发送那一刻即回调):App 据此立即锁定会话工作区,不必等服务端 msgCount 落盘回传 */
  onSessionTouched?: (sid: string | null) => void;
  /** 移动端(手机)布局:Enter 改为换行(发送只点按钮),提示文案同步切换 */
  compact?: boolean;
}

// 模型请求失败进入重试的状态行(照搬 deepseek-harness 的 ModelRetryItem):
// 单行折叠行,不占大块警示横幅——收起时只显示「等待/已重试模型请求(N/M) · Xs」实时倒计时,
// 展开可看重试延迟与失败原因。等待中文字带扫光动画,同一失败重试原地更新不堆叠。
function RetryRow({ data }: { data: NonNullable<ChatMessage['retry']> }) {
  const { retry, maxRetries, delayMs, error, state } = data;
  const scheduledSeconds = Math.max(1, Math.ceil(delayMs / 1000));
  const [seconds, setSeconds] = useState(scheduledSeconds);

  useEffect(() => {
    // 仅"等待重试"阶段走实时倒计时;开始/取消后定格为该次的计划等待秒数
    if (state !== 'scheduled') { setSeconds(scheduledSeconds); return; }
    // 倒计时锚定浏览器时钟(事件时间与 Date.now() 可能不同钟),每秒校准
    const deadline = Date.now() + delayMs;
    const tick = () => setSeconds(Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    if (Math.max(1, Math.ceil(delayMs / 1000)) <= 1) return;
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [delayMs, retry, state, scheduledSeconds]);

  const label = state === 'started' ? '已重试模型请求'
    : state === 'cancelled' ? '模型请求重试已取消'
    : '等待重试模型请求';

  return (
    <details className={`retry-msg${state === 'scheduled' ? ' active' : ''}`}>
      <summary>
        <span className="retry-text">{label}({retry}/{maxRetries}) · {seconds}s</span>
      </summary>
      <div className="retry-details">
        <div><span className="retry-detail-label">重试延迟：</span>{delayMs}ms</div>
        <div><span className="retry-detail-label">失败原因：</span>{error}</div>
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

export default function ChatPanel({ connected, workspace, localWorkspace, remoteCwd, localCwd, busy, sessionSeq = 0, sid = null, home = null, savedWs = [], localHome = null, savedLocalWs = [], remoteLocked = false, localLocked = false, onWorkspaceSet, onLocalWorkspaceSet, onDeleteWs, onDeleteLocalWs, onFork, onSessionCreated, onSessionTouched, compact = false }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
  // 候选只拉取一次(避免每次输入 @ 都请求;工作区切换后重新拉取)
  const atLoadedRef = useRef(false);
  // 候选拉取令牌:工作区切换时递增,使在途的旧工作区候选失效(避免晚到的响应覆盖新工作区)
  const atFetchTokenRef = useRef(0);
  const [agentState, setAgentState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  // 会话切换加载指示:切换期间保留上一会话内容 + 顶部提示,历史到达后再整体替换,避免空白闪烁
  const [switching, setSwitching] = useState(false);
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
  const scrollRef = useRef<HTMLDivElement>(null);
  // ---- 自动触底(吸附底部)控制 ----
  // stick=true 时流式更新/消息变化跟随触底;用户手动上滑离开底部即暂停(方便回看上下文),
  // 重新滚回底部、发送消息或切换会话时恢复。程序化 scrollTop 赋值同样会触发 scroll 事件,
  // 用 progRef 标记本次滚动来自代码(只在确实改变 scrollTop 时置位,防止残留标志吞掉真实手势)。
  const stickRef = useRef(true);
  const progRef = useRef(false);
  // 离开底部时显示"回到底部"悬浮按钮(流式期间内容持续增长,靠按钮一键返回)
  const [showJump, setShowJump] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null); // chatwrap:聊天滚动条拇指的宿主(整列高度,含输入区区域)
  const taRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null); // 高亮叠加层(与 textarea 滚动同步)
  const composerBoxRef = useRef<HTMLDivElement>(null); // 输入卡锚点:供 Slash/At 菜单 portal 到 body 后做 fixed 定位
  const userMsgRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [activeDot, setActiveDot] = useState(-1);
  // 悬停跳转点时的自定义内容提示(不用原生 title,支持两行截断省略)
  const [dotTip, setDotTip] = useState<{ top: number; left: number; text: string } | null>(null);
  const hasLive = useRef(false); // 用户已发起新对话时置 true,避免历史覆盖新消息
  const justSwitchedRef = useRef(false); // 会话切换后标记一次:绘制完成后再强制滚底+重绘拇指
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
    api.request('permission_set', { mode }, 8000)
      .catch((e) => {
        setPermMode(prev);
        toast.error(`切换权限模式失败: ${(e as Error).message}`);
      });
  };

  // ---- 聊天附件(图片/文件):粘贴、拖拽与"+"号上传 ----
  // 草稿附件仅存内存(上传拿到服务端 id 后随 speak 发送,不进输入草稿);
  // 图片缩略图在上传前后都用本地 objectURL 预览(上传完成换服务端 URL 会闪烁,发送时统一回收)。
  // 多模态开关(设置 → AI 模型 → 模型「多模态」)决定能否添加/发送图片。
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [lightbox, setLightbox] = useState<LightboxSrc | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const attSeqRef = useRef(0); // 附件本地 key 自增
  const addWrapRef = useRef<HTMLDivElement>(null); // "+"按钮与菜单容器(外部点击关闭菜单)
  const imgInputRef = useRef<HTMLInputElement>(null);   // 图片选择(accept=image/*)
  const fileInputRef = useRef<HTMLInputElement>(null);  // 任意文件选择
  // 当前模型是否具备多模态(看图)能力:由提供方配置里逐模型声明
  const multimodal = llm.effModelContext?.multimodal === true;
  const attPending = attachments.some((a) => a.uploading); // 仍在上传中(禁发)
  const attFailed = attachments.some((a) => !!a.error);    // 有上传失败项(须先移除)

  // 收纳文件:分类 → 本地预览 → 立即上传(逐个独立,失败只影响自身);
  // 图片仅在多模态模型下接受,其余类型(文件)不受限
  const intakeFiles = (files: File[]) => {
    const list = files.filter(Boolean);
    if (!list.length) return;
    const room = 10 - attachments.length;
    if (room <= 0) { toast.warning('一条消息最多 10 个附件'); return; }
    for (const file of list.slice(0, room)) {
      const kind = classifyKind(file.type, file.name);
      if (kind === 'image' && !multimodal) {
        toast.warning('当前模型未开启多模态,不支持发送图片(设置 → AI 模型 → 模型「多模态」开关)');
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
  }, [workspace, localWorkspace]);

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

  useEffect(() => {
    const subs = [
      api.on('history_cleared', () => {
        histCache.current.delete(activeRef.current ?? ''); // 清空后旧缓存失效,下次切换重新拉取
        setMessages([]);
        setQueue([]); // 历史清空:待执行队列一并复位
      }),
      api.on('agent', (m: any) => {
        // 多会话并行:只处理当前活跃会话的事件,其他会话(后台运行中)的流不进入本视图;
        // 新会话草稿态(sid 为占位符或尚未定向)无真实会话,丢弃所有带 sid 的事件,避免串入旧会话流
        if (m.sid && (activeRef.current == null || activeRef.current === NEW_SESSION_ID || m.sid !== activeRef.current)) return;
        switch (m.event) {
          case 'status':
            setAgentState(m.status === 'running' ? 'working' : 'idle');
            if (m.status !== 'running') {
              push((msgs) => { const c = [...msgs]; const l = c[c.length - 1]; if (l?.streaming) l.streaming = false;
              return c; });
            }
            break;
          case 'queue_update':
            // 待执行队列整表快照(新增排队/立即执行/删除/自动派发都会触发)
            setQueue(Array.isArray(m.queue) ? m.queue : []);
            break;
          case 'start':
            hasLive.current = true;
            // 本轮首条 user/message 计入分支点计数
            forkTurnRef.current += 1; lastIterRef.current = 0;
            setAgentState('working'); setErrorMsg('');
            setTodos([]); // 开启新一轮:上一轮的任务计划清空(对齐 harness 的 standing plan 语义)
            setSuppressIn(false); // 实时追加的新消息:解除入场动画抑制,保留浮现动效
            push((msgs) => [...msgs, { role: 'user', content: m.text, attachments: Array.isArray(m.attachments) ? m.attachments : undefined, time: Date.now(), forkTail: Math.max(0, forkTurnRef.current - 1) }]);
            push((msgs) => [...msgs, { role: 'assistant', segments: [], streaming: true, forkTail: Math.max(0, forkTurnRef.current - 1) }]);
            break;
          case 'context_usage':
            // 服务端每步请求后广播的上下文用量(实际/预估/窗口):仪表盘权威口径
            setCtxUsage({
              estimated: Number(m.estimated) || 0,
              actual: typeof m.actual === 'number' ? m.actual : null,
              output: typeof m.output === 'number' ? m.output : null,
              window: Number(m.window) || 0
            });
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
          case 'iteration':
            // 每次迭代对应一条 assistant/message turn;truncate 重开会重复相同 iter,去重
            if (m.iter !== lastIterRef.current) {
              forkTurnRef.current += 1; lastIterRef.current = m.iter;
              push((msgs) => { const c = [...msgs]; const l = c[c.length - 1]; if (l?.role === 'assistant') l.forkTail = forkTurnRef.current - 1; return c; });
            }
            break;
          case 'text_delta':
            push((msgs) => {
              const copy = markRetryStarted([...msgs]);
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') appendText(last, m.text);
              return copy;
            });
            break;
          case 'reasoning_delta':
            // 思考内容增量(推理模型的 reasoning 通道):按到达顺序落为独立段,
            // 后续步骤的思考自然出现在上一组工具调用之后,而不是全堆在消息开头
            push((msgs) => {
              const copy = markRetryStarted([...msgs]);
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') appendReasoning(last, m.text);
              return copy;
            });
            break;
          case 'tool_call':
            push((msgs) => {
              const copy = markRetryStarted([...msgs]);
              const li = copy.length - 1;
              const last = copy[li];
              // 断线补偿(服务端补发)时同一 callId 可能已被实时事件渲染过,按 id 去重避免重复卡片。
              // 不可变更新(新 segments/tools 数组):配合工具列表 memo,
              // 只有本段真正变化时才重渲染,其余历史段原样跳过
              if (last?.role === 'assistant'
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
              const li = copy.length - 1;
              const last = copy[li];
              if (last?.role === 'assistant' && Array.isArray(last.segments)) {
                // 不可变更新:替换目标工具对象与所在组数组,使工具列表 memo 正确感知变化
                const patch = { ok: m.ok, ms: m.ms, result: m.result, meta: m.meta };
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
          case 'done':
            setAgentState('done');
            push((msgs) => {
              const copy = [...msgs];
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') {
                last.streaming = false;
                // 文件变更汇总:所有 tool_result 已落定,聚合「N 个文件已更改」卡片数据
                attachFileChanges(last);
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
            setAgentState('idle');
            push((msgs) => {
              const c = [...msgs];
              const l = c[c.length - 1];
              if (l?.streaming) l.streaming = false;
                attachFileChanges(l);
              // 用户停下 Agent 时,尚在倒计时中的重试随之取消(对齐 harness llm/retry-started 的 cancelled 态)
              for (let i = c.length - 1; i >= 0; i--) {
                const rt = c[i]?.retry;
                if (rt && rt.state === 'scheduled') { c[i] = { ...c[i], retry: { ...rt, state: 'cancelled' } }; break; }
              }
              return c;
            });
            break;
          case 'error':
            setAgentState('error'); setErrorMsg(m.message);
            push((msgs) => {
              const c = [...msgs];
              const l = c.slice(-1)[0];
              if (l?.streaming) l.streaming = false;
                attachFileChanges(l);
              // 重试耗尽/不可重试的直接失败:倒计时中的重试随本轮中止取消(对齐 harness cancelled 态)
              for (let i = c.length - 1; i >= 0; i--) {
                const rt = c[i]?.retry;
                if (rt && rt.state === 'scheduled') { c[i] = { ...c[i], retry: { ...rt, state: 'cancelled' } }; break; }
              }
              return c;
            });
            break;
          case 'notice':
            // 通知不打断流式中的 assistant 气泡:插到它前面,
            // 避免后续 text/reasoning 增量找不到目标消息(它们只认末尾的 assistant)
            push((msgs) => {
              const c = [...msgs];
              const last = c[c.length - 1];
              if (last?.role === 'assistant' && last.streaming) {
                c.splice(c.length - 1, 0, { role: 'notice', content: m.text || '' });
              } else {
                c.push({ role: 'notice', content: m.text || '' });
              }
              return c;
            });
            break;
          case 'compaction_done':
            // 自动压缩完成(上下文超水位/爆窗恢复):在消息流中插入「上下文压缩」标记行,
            // 披露模型自该处起不再看到被压缩的早期历史(其上的消息保持原样,与 CompactionRow
            // 的语义一致)。运行中不做整表重拉,避免打断正在流式的输出;刷新/切回会话后
            // 由 compaction/done 事件在原位投影出同款标记行。流式中的 assistant 不打断,插到它前面。
            push((msgs) => {
              const c = [...msgs];
              const item = {
                role: 'user' as const,
                content: m.summary || '【上下文已自动压缩】早期对话已省略。',
                compaction: { dropCount: Number(m.dropCount) || 0, manual: m.manual === true }
              };
              const last = c[c.length - 1];
              if (last?.role === 'assistant' && last.streaming) c.splice(c.length - 1, 0, item);
              else c.push(item);
              return c;
            });
            scrollToBottomNow();
            break;
          case 'retry':
            // 模型请求失败进入重试:渲染为 harness 风格的单行状态行(实时倒计时 + 可展开失败详情),
            // 同一失败的重试原地更新不堆叠;流式 assistant 存在时插到它前面(不打断对话流)
            push((msgs) => {
              const c = [...msgs];
              const payload = {
                retry: Number(m.retry) || 1,
                maxRetries: Number(m.maxRetries) || 5,
                delayMs: Number(m.delayMs) || 2000,
                error: String(m.error || '网络错误').slice(0, 120),
                state: 'scheduled' as const
              };
              for (let i = c.length - 1; i >= 0; i--) {
                if (c[i]?.retry) { c[i] = { role: 'notice', retry: payload }; return c; }
              }
              const last = c[c.length - 1];
              if (last?.role === 'assistant' && last.streaming) {
                c.splice(c.length - 1, 0, { role: 'notice', retry: payload });
              } else {
                c.push({ role: 'notice', retry: payload });
              }
              return c;
            });
            break;
          case 'history_compacted':
            // 手动压缩完成(/compact):后端已把早期消息替换为 compaction/done 摘要事件,
            // 这里整体重拉历史——被压缩的早期消息从视图中消失,压缩摘要以折叠标记行呈现
            // (样式参照 harness:CompactionItem 的标记行,而非用户气泡)。
            api.request('get_history', {}, 8000)
              .then((h) => {
                const msgs = turnsToMessages(h.turns || []);
                histCache.current.set(activeRef.current ?? '', { msgs, todos: Array.isArray(h.todos) ? h.todos : [] });
                forkTurnRef.current = (h.turns || []).length; // 分支点/删除索引重新对齐压缩后的 turns
                lastIterRef.current = 0;
                setSuppressIn(true); // 整表替换:抑制入场动画,压缩瞬间画面保持静止
                setMessages(msgs);
                setTodos(Array.isArray(h.todos) ? h.todos : []);
              })
              .catch(() => { /* 拉取失败保留当前视图,下次会话切换时会重新载入 */ });
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
        api.request('get_history', {}, 8000)
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
    justSwitchedRef.current = true; // 切换会话:绘制后兜底重测滚底/拇指,见下方 [messages] 兜底 effect
    forkTurnRef.current = 0; lastIterRef.current = 0; // 分支点计数器随会话重置
    setTodos([]);
    setAgentState('idle'); setErrorMsg('');
    setQueue([]); // 切会话先复位队列,避免串到上一会话;真实队列随 get_history 返回
    clearAttachments(); // 草稿附件不跨会话携带(纯内存,发送时才随消息上行)

    // 新会话草稿态(sid 为占位符):不请求历史,显示空对话;sid=null(App 初次加载尚未定向)
    // 则沿用原切换重载逻辑(请求 get_history 拿回服务端活跃会话)
    if (target === NEW_SESSION_ID) {
      setSuppressIn(true);
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
      setSuppressIn(true);
      setSwitching(false);
      return () => { alive = false; };
    }
    // 有缓存则立即显示(切回已看过的会话零等待);无缓存时保留旧内容 + 加载指示
    const cached = histCache.current.get(target ?? '');
    if (cached) { setSuppressIn(true); setMessages(cached.msgs); setTodos(cached.todos); setSwitching(false); }
    else setSwitching(true);
    api.request('get_history', {}, 8000)
      .then((r) => {
        if (!alive || hasLive.current || activeRef.current !== target) return;
        // 历史 turns 长度即该会话已累计的消息面 turn 数,作为后续流式递增的基准
        forkTurnRef.current = (r.turns || []).length;
        const msgs = turnsToMessages(r.turns || []);
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
        setMessages(msgs);
        setTodos(Array.isArray(r.todos) ? r.todos : []); // 该会话当前的任务计划
        setQueue(Array.isArray(r.queue) ? r.queue : []); // 该会话的待执行队列快照
        // 该会话的权限模式快照(服务端权威):非法值/旧服务端缺省回落默认
        setPermMode(isPermissionMode(r.permissionMode) ? r.permissionMode : 'confirm');
        setSwitching(false);
      })
      .catch((e) => {
        if (!alive) return;
        setSwitching(false);
        if (cached) return; // 有缓存:继续显示缓存(可能略旧),静默忽略本次刷新失败
        // 无缓存且加载失败:清掉可能已混入的上一会话内容,提示可重试(会话项不再被 activeId 守卫挡住)
        histCache.current.delete(target ?? '');
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
    api.send('clear_history', {});
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
      applyTurns(await api.request('message_delete', { at: m.forkTail ?? i }, 8000));
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
      applyTurns(await api.request('message_rewind', { at: m.forkTail ?? i }, 8000));
      // 回退后把该条消息回填输入框,便于修改后重新发起
      updateInput(m.content || '');
      requestAnimationFrame(() => { const el = taRef.current; if (el) el.focus(); });
    } catch (e) { toast.error((e as Error).message); }
  };

  // 用户消息索引(左侧跳转点数据源:每条用户消息对应一个点;压缩标记行不算用户消息,跳过)
  const userMsgIndices = messages.reduce((acc: number[], m, i) => {
    if (m.role === 'user' && !m.compaction) acc.push(i);
    return acc;
  }, []);

  // 计算当前激活点:视口 40% 参考线之下的最后一条用户消息。
  // rAF 节流 + 文档序单调早停:滚动帧里不再对全部用户消息逐条 getBoundingClientRect
  // (强制整文档布局),首个越过参考线的点之后位置只会更靠下,直接终止遍历;
  // 加上 .msg 的 content-visibility,长会话滑动时每帧的开销稳定在常量级。
  const dotRafRef = useRef(0);
  const updateActiveDot = () => {
    if (dotRafRef.current) return; // 上一帧的度量还没跑完,合并本次需求
    dotRafRef.current = requestAnimationFrame(() => {
      dotRafRef.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      const line = el.getBoundingClientRect().top + el.clientHeight * 0.4;
      let cur = -1;
      for (const i of userMsgIndices) {
        const node = userMsgRefs.current[i];
        if (!node) continue;
        if (node.getBoundingClientRect().top > line) break; // 文档序单调:之后都更靠下
        cur = i;
      }
      setActiveDot(cur);
    });
  };

  // 点击跳转点:平滑滚动到对应的用户消息
  const jumpToMsg = (i: number) => {
    const el = scrollRef.current;
    const node = userMsgRefs.current[i];
    if (!el || !node) return;
    const top = el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
    el.scrollTo({ top, behavior: 'smooth' });
  };

  // 距底部多少像素内仍视为"在底部":容掉惯性滚动的残余位移与亚像素取整,
  // 避免流式增长时因 1px 误差误判为"用户上滑"而暂停吸附
  const STICK_EPS = 48;

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

  // 对话区 scroll 统一入口:更新跳转点/提示,并据位置维护吸附状态。
  // 程序化触底(scrollTop 赋值)触发的事件只吞掉标志不改状态;其余一律视为
  // 用户手势——在底部(含 48px 容差)恢复吸附,离开底部暂停吸附并亮出回底按钮。
  // 拇指拖拽/滚轮转发/触摸滚动都走原生 scroll 事件,天然被识别为用户手势。
  const onChatScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    updateActiveDot();
    hideDotTip();
    if (progRef.current) { progRef.current = false; return; }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_EPS;
    stickRef.current = atBottom;
    setShowJump(!atBottom);
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
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // Ctrl+滚轮 / 触控板捏合缩放:交给浏览器
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
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      host.removeEventListener('wheel', onWheel);
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
    if (justSwitchedRef.current) stickRef.current = true; // 切换会话总是回到底部
    if (stickRef.current) {
      scrollToBottomNow();
    } else {
      refreshOverlayScrollbar(el, true); // 离底查看:内容变长后拇指位置/长度需重算
      setShowJump(true);                 // 流式增长不触发 scroll 事件,按钮显隐在此维护
      updateActiveDot();
    }
  }, [messages]);

  // 会话切换的兜底:首帧布局时内容挂载动画/延迟加载的图片可能在绘制后几帧内
  // 才把 scrollHeight 撑到最终值,首帧测得的底部与拇指长度会偏小,看起来就像
  // "滚动条从长到短缓缓过渡"。绘制后下一帧再强制滚底 + 重绘一次拇指,保证
  // 切换会话后滚动条立即是最终形态(仅会话切换后触发一次,不干扰普通流式)。
  useEffect(() => {
    if (!justSwitchedRef.current) return;
    justSwitchedRef.current = false;
    const id = requestAnimationFrame(() => {
      if (scrollRef.current) scrollToBottomNow();
    });
    return () => cancelAnimationFrame(id);
  }, [messages]);

  // 跳转点悬停提示:取不被裁剪的 fixed 定位,按当前点视口坐标弹出到右侧
  const showDotTip = (e: React.MouseEvent<HTMLButtonElement>, text: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setDotTip({ top: r.top + r.height / 2, left: r.right + 8, text });
  };
  const hideDotTip = () => setDotTip(null);

  // 发送时的 @ 引用替换:把输入中记录的 @名称 替换为 @source:完整路径
  // (文本区只显示名称,AI 收到的是带来源标记的绝对路径)。
  // 按名称长度降序替换避免 @server.ts 被 @server 抢先吃掉;未记录的 @词原样保留。
  function composeMentionText(text: string): string {
    const map = atMapRef.current;
    if (map.size === 0) return text;
    const names = [...map.keys()].sort((a, b) => b.length - a.length);
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
              out += `@${rec.source}:${rec.path}`;
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
    return out;
  }

  // 发送文本 = 输入框原文 + @引用替换(技能 /词 原样保留,后端按独立词解析注入)
  const composedInput = composeMentionText(input);
  // 输入中是否已含完整 /技能名 或 @引用(用于占位提示与去重判断)
  const hasSkillToken = /(?:^|\s)(\/[a-z0-9][a-z0-9-]*|@[a-zA-Z0-9_.\-/\\]+)(?=\s|$)/i.test(input);

  const send = async () => {
    // 工作中仍可发送:服务端会把消息放入待执行队列(当前轮结束后按序自动执行,不打断回复);
    // 提问挂起时禁止发送(须先作答或取消);纯附件消息(无文字)也允许发送
    const atts = attachments.filter((a) => a.att).map((a) => a.att!);
    if ((!input.trim() && atts.length === 0) || !canSend || askPending) return;
    if (attPending) { toast.warning('附件还在上传中,请稍候…'); return; }
    if (attFailed) { toast.warning('有附件上传失败,请先移除后再发送'); return; }
    if (atts.some((a) => a.kind === 'image') && !multimodal) {
      toast.warning('当前模型未开启多模态,不支持发送图片(设置 → AI 模型 → 模型「多模态」开关)');
      return;
    }
    const text = composedInput;
    let realSid: string | null = sid == null || sid === NEW_SESSION_ID ? null : sid;
    // 新会话草稿态(sid 为占位符或尚未加载):先真正创建服务端会话(此时才列入历史会话列表),
    // 创建失败则保留输入与草稿,不发送
    if (sid == null || sid === NEW_SESSION_ID) {
      let created: any;
      try {
        created = await api.request('session_create', {}, 8000);
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
          await api.request('permission_set', { mode: permMode }, 8000);
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
    // 发送消息的那一刻即通知 App 锁定该会话的工作区(不等服务端 msgCount 落盘回传)
    onSessionTouched?.(realSid);
    api.send('speak', { text, reasoning, ...(atts.length ? { attachments: atts } : {}) });
  };

  // ---- 待执行队列操作 ----
  // 立即执行:把排队中的消息立即生效(忙碌时打断当前回复即时切换,空闲时直接开新轮)
  const runQueueNow = async (item: QueueItem) => {
    try {
      const r = await api.request('queue_steer', { id: item.id }, 8000);
      setQueue(Array.isArray(r.queue) ? r.queue : []);
      scrollToBottomNow(); // 用户主动执行:回到底部跟进新一轮回复
    } catch (e) { toast.error((e as Error).message); }
  };
  // 编辑:把排队中的消息撤回输入框重新编辑(该条先移出队列,发送后重新排队)
  const editQueueItem = async (item: QueueItem) => {
    try {
      const r = await api.request('queue_remove', { id: item.id }, 8000);
      setQueue(Array.isArray(r.queue) ? r.queue : []);
      updateInput(item.text);
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
      const r = await api.request('queue_remove', { id: item.id }, 8000);
      setQueue(Array.isArray(r.queue) ? r.queue : []);
    } catch (e) { toast.error((e as Error).message); }
  };

  // ---- 命令卡片本地状态(role='command',仅前端可见,不持久化) ----
  // 系统命令(如 /compact)执行时插入消息流尾部显示「运行中」,异步完成后按 cmdId 原地更新;
  // 压缩成功时服务端广播 history_compacted 重拉历史,命令卡随之被「压缩标记行」(CompactionRow)
  // 取代——呈现方式对齐 harness 的 CompactionCommandCard(运行行 + checkpoint 披露)。
  const cmdSeqRef = useRef(0);
  const pushCmd = (cmd: { state: 'running' | 'ok' | 'error'; text?: string }, id?: number) => {
    const cid = id ?? ++cmdSeqRef.current;
    setMessages((msgs) => [...msgs, { role: 'command', cmdId: cid, command: { name: 'compact', ...cmd } }]);
    scrollToBottomNow();
    return cid;
  };
  const patchCmd = (id: number, patch: { state: 'running' | 'ok' | 'error'; text?: string }) => {
    setMessages((msgs) => msgs.map((m) => (m.cmdId === id ? { ...m, command: { name: 'compact', ...patch } } : m)));
  };

  // ---- / 命令菜单(照搬 deepseek-harness 的行内命令交互) ----
  // 系统命令:除技能外,提供常见会话操作(与 harness 的 command-compact/clear/fork 对齐)
  const slashCommands: SlashItem[] = [
    {
      name: 'compact', kind: 'command',
      description: '压缩当前会话上下文(把早期对话合并为摘要,释放窗口空间)',
      run: async () => {
        // 运行中直接失败(与 harness runMaintenance 的同步 busy 语义一致),命令卡给失败态
        if (busy || agentState === 'working') {
          pushCmd({ state: 'error', text: 'Agent 正在运行,请先停止或等待完成再压缩' });
          return true;
        }
        // 插入「运行中」命令卡:压缩进行中的可见反馈(替代原先的纯 toast,
        // 呈现方式对齐 harness 的 CompactionCommandCard 运行行)
        const id = pushCmd({ state: 'running', text: '正在压缩当前会话上下文…' });
        try {
          const r = await api.request('compact_now', {}, 120000);
          // 压缩成功时服务端先广播 history_compacted → 前端重拉历史,
          // 命令卡随之被「压缩标记行」(CompactionRow)取代;这里先落完成态兜底,
          // 保证事件重拉失败时用户仍能看到结果(harness:命令卡片折叠进 CompactionItem)
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
    const m = /(?:^|\s)\/([a-z0-9-]*)$/i.exec(text);
    if (m) {
      setSlashQuery(m[1] || '');
      setSlashOpen(true);
      if (slashActive < 0) setSlashActive(0);
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
      // 同一技能已完整存在于文本中则不重复追加
      const already = new RegExp(`(?:^|\\s)/${name}(?=\\s|$)`, 'i').test(input);
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
    item.run?.(query);
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

  // 输入 @ 唤醒菜单:行首 或 空白后 的 @ 且其后是词尾时开启(与 syncSlash 同构)
  const syncAt = (text: string) => {
    const m = /(?:^|\s)@([a-zA-Z0-9_.\-/\\]*)$/.exec(text);
    if (m) {
      setAtQuery(m[1] || '');
      setAtOpen(true);
      if (atActive < 0) setAtActive(0);
      openAt();
    } else {
      setAtOpen(false);
    }
  };
  const closeAt = () => { setAtOpen(false); setAtActive(-1); };

  // 选中候选:把末尾刚输入的 @词 替换为 @名称 + 空格(路径不进输入框),
  // 记录 名称 -> {路径,来源} 供发送时替换;同一名称已完整存在则不重复插入。
  // 注意 already 需对 head(剥除当前 @词 尾部后的保留文本)判断:若对 input 判断,
  // 刚输入的查询尾巴 @web 会被误判为"已存在",导致 @web 被清掉(引用"消失")。
  const pickAt = (item: AtCandidate, _query: string) => {
    const name = item.name;
    const m = /(^|\s)@[a-zA-Z0-9_.\-/\\]*$/i.exec(input);
    const head = m ? input.slice(0, m.index + m[1].length) : input;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const already = new RegExp(`(?:^|\\s)@${esc}(?=\\s|$)`, 'i').test(head);
    const next = already ? head : `${head}@${name} `;
    atMapRef.current.set(name, { path: item.path, source: item.source });
    updateInput(next);
    syncAt(next);
    setAtOpen(false);
    setAtActive(-1);
    requestAnimationFrame(() => { const el = taRef.current; if (el) el.focus(); });
  };

  const stop = () => api.send('stop_agent', {});

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
  // 工作中也允许输入发送(自动进入待执行队列,当前轮结束后按序执行);
  // 发送条件:远程或本地工作区任一已选——连接服务器但未选远程工作区时,
  // 只要选了本地工作区即可发起对话(仅限本地工作,会话归本地任务列表);
  // 模型提问挂起时锁定输入与暂停(须先作答或取消提问);会话切换加载中也锁定,避免发到错误会话
  const canSend = (!!workspace || !!localWorkspace) && !askPending && !switching;

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
              <div>{connected ? '连接服务器后:选远程工作区可远程+本地工作;只选本地工作区则仅在本机工作' : '未连接服务器 · 选择本地工作区后,即可让 Agent 在本机工作'}</div>
              <div className="muted">例如:「帮我看一下这个项目结构,然后修复 main.js 里的 bug」</div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}${m.compaction ? ' compaction-msg' : ''}`} ref={(el) => { userMsgRefs.current[i] = el; }}>
              {m.compaction && (
                // 上下文压缩标记行(手动/自动):折叠展示摘要,展开看正文(样式参照 harness CompactionItem)
                <CompactionRow content={m.content || ''} dropCount={m.compaction.dropCount} manual={m.compaction.manual} />
              )}
              {m.command && (
                // 斜杠命令卡片(/compact 等):运行中/成功/失败的可见反馈(样式参照 harness GenericCommandCard)
                <CommandCard name={m.command.name} state={m.command.state} text={m.command.text} />
              )}
              {m.role === 'notice' && (m.retry
                // 模型请求失败进入重试:harness 风格单行折叠状态行(倒计时 + 可展开详情),非警示横幅
                ? <div className="retry-msg-wrap"><RetryRow data={m.retry} /></div>
                : <div className="bubble notice-bubble">⚠ {m.content}</div>)}
              {m.role === 'user' && !m.compaction && (
                <>
                  <div className="bubble user-bubble">
                    {/* 附件(图片/文件)渲染在正文上方:单图 singleFit,多图方块平铺 */}
                    {!!m.attachments?.length && (
                      <MessageAttachments items={m.attachments} onOpen={setLightbox} />
                    )}
                    {m.content}
                  </div>
                  <div className="user-msg-foot">
                    {!!m.time && <span className="user-msg-time">{formatMsgTime(m.time)}</span>}
                    <UserMessageActions
                      text={m.content || ''}
                      onDelete={() => deleteMsg(m, i)}
                      onRewind={() => rewindMsg(m, i)}
                    />
                  </div>
                </>
              )}
              {m.role === 'assistant' && (
                <div className="msg-col">
                  <div className="bubble ai-bubble">
                    {(m.segments || []).map((seg, si) => {
                      if (seg.kind === 'tools') return (
                        <ToolCallList key={si} tools={seg.tools || []} workspace={(connected ? workspace : localWorkspace) ?? undefined} />
                      );
                      // 思考段:穿插在文本/工具组之间,折叠展示(照搬 dsh 的 ReasoningRow;
                      // 流式时仅最后一段标记 running 获得扫光);ReasoningSegment 按 text 引用 memo
                      if (seg.kind === 'reasoning') {
                        return <ReasoningSegment key={si} text={seg.text || ''} running={m.streaming && si === (m.segments || []).length - 1} />;
                      }
                      // 正文段:AssistantSegment 按 text 引用 memo,历史段不变时跳过重渲染
                      return <AssistantSegment key={si} text={seg.text || ''} />;
                    })}
                    {m.streaming && (m.segments || []).length === 0 && <span className="cursor" aria-hidden="true" />}
                  </div>
                  {/* 文件变更汇总卡:仅在本条回复结束(streaming=false)后展示「N 个文件已更改」(点击展开列表) */}
                  {!m.streaming && !!m.filesChanged?.length && (
                    <FilesChangedCard items={m.filesChanged} workspace={(connected ? workspace : localWorkspace) ?? undefined} />
                  )}
                  {!m.streaming && (
                    <MessageActions
                      text={segText(m)}
                      onBranch={() => onFork?.(m.forkTail ?? -1)}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
          {/* 运行中指示行:agent 工作期间挂在消息列表末尾(StateDot ongoing 像素追光)。
              长耗时步骤(如大文件写入/命令执行)没有文本增量流出,此行让"仍在运行"
              可见,避免误以为卡死;提问挂起时 agent 在等用户作答,不算运行中 */}
          {working && !askPending && !askChecking && (
            <div className="running-row" role="status" aria-live="polite">
              <StateDot state="ongoing" size={12} />
              <span className="running-text">Agent 正在运行…</span>
            </div>
          )}
        </div>
        {/* 回到底部悬浮按钮:用户上滑离开底部时出现(流式期间不被自动拉回,方便回看上下文),
            点击瞬时回底并恢复吸附。挂在 chat-scroll(定位宿主)内,贴对话区右下角 */}
        {showJump && (
          <button type="button" className="jump-bottom" onClick={scrollToBottomNow} aria-label="回到底部">
            <IconChevronDownOutline14 size={16} />
          </button>
        )}
      </div>
      {/* 跳转点悬停内容提示:fixed 定位防裁剪,两行截断 + 省略号 */}
      {dotTip && (
        <div className="dot-tip" style={{ top: dotTip.top, left: dotTip.left }}>{dotTip.text}</div>
      )}
      {errorMsg && <div className="error">{errorMsg}</div>}
      {/* 任务计划面板:输入区玻璃面板之外,独立玻璃卡片悬浮(默认折叠,无计划时隐藏) */}
      <TodoPanel todos={todos} />
      <div className="composer">
        {/* 模型提问面板(ask_user_question):内联显示在输入框上方,无遮罩;作答/取消前锁定输入。
            onBootChange:刷新后拉取挂起提问期间扣住输入区,防止"输入框→面板"闪跳 */}
        <AskPanel sid={sid} onPendingChange={setAskPending} onBootChange={setAskChecking} />
        {/* 待执行消息队列:对话进行中发送的消息在此排队等待,当前轮结束后按 FIFO 自动执行 */}
        <QueuePanel queue={queue} onRunNow={runQueueNow} onEdit={editQueueItem} onDelete={deleteQueueItem} />
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
          {/* / 命令菜单:输入 / (行首或空格后)时浮在输入框上方,前缀优先+模糊匹配过滤 */}
          {slashOpen && (
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
          {/* @ 引用菜单:输入 @ 时浮在输入框上方,列出远程+本地工作区的文件/文件夹 */}
          {atOpen && (
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
              onChange={(e) => { const v = e.target.value; updateInput(v); syncSlash(v); syncAt(v); }}
              onScroll={syncOverlayScroll}
              onPaste={(e) => {
                // 粘贴图片/文件:拦截默认行为改为附件收纳(粘贴文本不受影响)
                const files = Array.from(e.clipboardData?.files || []);
                if (files.length > 0) { e.preventDefault(); intakeFiles(files); }
              }}
              placeholder={!connected && !localWorkspace ? '未连接服务器 · 选择本地工作区后即可对话'
                : connected && !workspace && !localWorkspace ? '请先选择远程工作区或本地工作区'
                : connected && !workspace ? '未选远程工作区 · 当前仅限本地工作区对话'
                : askPending ? '请先在提问面板中作答或取消…'
                : working ? 'Agent 工作中,发送后将进入队列等待执行…'
                : hasSkillToken ? '输入需求…' : '输入 @ 引用文件、/ 唤起命令与技能菜单…'}
              disabled={!canSend}
              onKeyDown={(e) => {
                // / 命令菜单打开时的键盘交互(对齐 harness):↑↓ 移动、Enter 选中、Esc 关闭、Tab 补全
                if (slashOpen) {
                  const list = rankSlashItems(slashAll, slashQuery);
                  if (e.key === 'ArrowDown') { e.preventDefault(); setSlashActive((i) => (list.length ? (i + 1) % list.length : -1)); return; }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setSlashActive((i) => (list.length ? (i - 1 + list.length) % list.length : -1)); return; }
                  if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
                  if (e.key === 'Enter' && !e.shiftKey && list.length) {
                    e.preventDefault();
                    const it = list[slashActive >= 0 ? slashActive : 0];
                    if (it) pickSlash(it, slashQuery);
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
                  const list = rankByName(atCandidates, atQuery);
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
                      syncAt(next);
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
            <div className="composer-add-wrap" ref={addWrapRef}>
              <button type="button" className={`composer-add ${addMenuOpen ? 'on' : ''}`}
                data-tip="添加附件" aria-label="添加附件" aria-haspopup="menu" aria-expanded={addMenuOpen}
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
                      <button type="button" role="menuitem" className={`add-menu-item ${multimodal ? '' : 'disabled'}`}
                        data-tip={multimodal ? undefined : '当前模型未开启多模态(设置 → AI 模型 → 模型「多模态」)'}
                        onClick={() => {
                          if (!multimodal) { toast.warning('当前模型未开启多模态,不支持发送图片'); return; }
                          setAddMenuOpen(false); imgInputRef.current?.click();
                        }}>
                        <span className="am-ico" aria-hidden>🖼</span>
                        <span className="am-main">
                          <span>图片</span>
                          <span className="am-desc">{multimodal ? 'PNG / JPG / WebP / GIF…' : '当前模型未开启多模态'}</span>
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
            {/* AI 访问权限模式(变更前确认/自动编辑/计划模式/完全访问)。
                仅切换中锁定;草稿态(新会话)也开放选择:模式先存本地,随 session_create 落地 */}
            <PermissionSelect value={permMode} disabled={switching}
              onChange={changePermMode} anchorRef={composerBoxRef} />
            <span className="muted composer-tip">{compact ? '点 ➤ 发送 · 换行直接回车' : 'Enter 发送 · Shift+Enter 换行'}</span>
            </div>
            <ContextMeter messages={messages} input={composedInput}
              contextWindow={llm.effModelContext?.contextWindow || 0} usage={ctxUsage} />
            {/* 工作中且输入框为空(且无附件):显示停止按钮;有内容/附件时变为发送按钮,
                发送后默认进入待执行队列等待执行 */}
            {working && !askPending && !input.trim() && attachments.length === 0
              ? <button className="send-btn stop" onClick={stop} title="停止当前任务">⏹</button>
              : <button className="send-btn"
                  title={working ? 'Agent 工作中,发送后进入队列等待执行' : '发送'}
                  disabled={!canSend || (!input.trim() && attachments.length === 0)} onClick={send}>➤</button>}
          </div>
        </div>
        {/* 工作区 + 模型:工作区在左,模型在右;模型为二级菜单(模型清单按提供商分组 / 推理等级) */}
        <div className="wsbar-row">
          {connected && (
            <div className="wsbar" ref={wsBarRef}>
              <button
                className={`ws-chip ${workspace ? '' : 'none'}${remoteLocked ? ' locked' : ''}`}
                disabled={remoteLocked}
                data-tip={remoteLocked ? '该会话已开始对话,远程工作区已锁定;如需更换请新建会话' : undefined}
                onClick={() => { if (!remoteLocked) { setWsMenuOpen((v) => !v); setLocalWsMenuOpen(false); } }}
              >
                <span className="ws-chip-path">{remoteLocked ? `🔒 ${lastPathSegment(workspace || '') || '远程工作区'}` : (workspace ? `📂 ${lastPathSegment(workspace)}` : '选择远程工作区')}</span>
                <span className="ws-chip-arrow">{wsMenuOpen ? '▾' : '▸'}</span>
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
                          <button type="button" className="ws-pick-del action-icon danger" aria-label={`从历史中删除工作区 ${p}`}
                            onClick={() => removeWs(p)}>🗑</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="ctx-sep" />
                  <button className="ws-pick-item ws-pick-action" onClick={() => { setWsMenuOpen(false); setWsBrowserOpen(true); }}>
                    📁 浏览选择其他目录…
                  </button>
                  {home && (
                    <button className="ws-pick-item ws-pick-action" onClick={() => setWorkspace(home)}>
                      🏠 家目录
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="wsbar" ref={localWsBarRef}>
            <button
              className={`ws-chip local ${localWorkspace ? '' : 'none'}${localLocked ? ' locked' : ''}`}
              disabled={localLocked}
              data-tip={localLocked ? '该本地会话已开始对话,本地工作区已锁定;如需更换请新建会话' : undefined}
              onClick={() => { if (!localLocked) { setLocalWsMenuOpen((v) => !v); setWsMenuOpen(false); } }}
            >
              <span className="ws-chip-path">{localLocked ? `🔒 ${lastPathSegment(localWorkspace || '') || '本地工作区'}` : (localWorkspace ? `🖥 ${lastPathSegment(localWorkspace)}` : '选择本地工作区')}</span>
              <span className="ws-chip-arrow">{localWsMenuOpen ? '▾' : '▸'}</span>
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
                        <button type="button" className="ws-pick-del action-icon danger" aria-label={`从历史中删除本地工作区 ${p}`}
                          onClick={() => removeLocalWs(p)}>🗑</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="ctx-sep" />
                <button className="ws-pick-item ws-pick-action" onClick={() => { setLocalWsMenuOpen(false); setLocalWsBrowserOpen(true); }}>
                  📁 浏览选择其他本地目录…
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
              title="输入模型名" />
          )}
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
    {/* 用户消息跳转点:absolute 贴对话区(main 内、sidebar 右侧)最左侧,
        不随限宽的聊天内容移动,也不钉在浏览器窗口最左。渲染在 chatwrap 之外:
        chatwrap 是滚动条拇指宿主、会被设为定位元素,放里面会被重新锚定到限宽列 */}
    {userMsgIndices.length > 1 && (
      <nav className="chat-dots" aria-label="用户消息跳转">
        {userMsgIndices.map((idx, d) => {
          const t = (messages[idx]?.content || '').trim();
          return (
            <button
              key={idx}
              type="button"
              className={`chat-dot${idx === activeDot ? ' on' : ''}`}
              aria-label={`跳转到第 ${d + 1} 条用户消息`}
              onClick={() => jumpToMsg(idx)}
              onMouseEnter={(e) => showDotTip(e, t)}
              onMouseLeave={hideDotTip}
            />
          );
        })}
      </nav>
    )}
    </>
  );
}