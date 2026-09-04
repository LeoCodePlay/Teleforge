import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../../api';
import { useLlm } from '../../context/llm-context';
import type { ChatMessage, MsgSegment, ToolCallInfo, TodoItem } from '../../types';
import DirBrowser from '../DirBrowser/DirBrowser';
import LocalDirBrowser from '../DirBrowser/LocalDirBrowser';
import ModelMenu from '../ModelMenu/ModelMenu';
import ContextMeter from '../ContextMeter/ContextMeter';
import TodoPanel from '../TodoPanel/TodoPanel';
import SlashMenu, { rankSlashItems } from '../SlashMenu/SlashMenu';
import type { SlashItem } from '../SlashMenu/SlashMenu';
import { useFeedback } from '../../context/feedback';
import AskPanel from '../AskPanel/AskPanel';
import QueuePanel, { QueueItem } from '../QueuePanel/QueuePanel';
import { ToolCallList } from '../ToolCallList/ToolCallList';
import { ReasoningRow } from '../ReasoningRow/ReasoningRow';
import { CompactionRow } from './CompactionRow';
import { refreshOverlayScrollbar, setScrollbarHost } from '../../utils/scrollbar-ui';
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

function AssistantText({ text }: { text: string }) {
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
}

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
      out.push({ role: 'user', content: t.content || '', forkTail: ti, time: t.time, ...(t.compaction ? { compaction: t.compaction } : {}) });
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
  return out;
}

// ---- 输入区:单一可编辑文本 + 高亮叠加层 ----
// 不再用"冻结文本段 + 技能 tag"分段输入(会导致布局错乱且冻结文本不可编辑);
// 输入框始终是普通 textarea,内容完整可编辑。叠加层按后端同款规则
// (行首/空白后的 /word,其后跟空白或结尾)把 /技能名 高亮显示;
// 退格时光标紧邻完整 /技能名 时整词删除(连同其后单个空格)。
type OverlaySeg = { t: 'text' | 'skill'; v: string };

function tokenizeInput(text: string): OverlaySeg[] {
  const out: OverlaySeg[] = [];
  const re = /(?:^|\s)(\/[a-z0-9][a-z0-9-]*)(?=\s|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      // 前导空白归入文本段(不高亮),只高亮 /word 本身
      out.push({ t: 'text', v: text.slice(last, m.index + (m[0].length - m[1].length)) });
    }
    out.push({ t: 'skill', v: m[1] });
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
  busy: boolean;
  sessionSeq?: number;
  sid?: string | null;
  home?: string | null;
  savedWs?: string[];
  /** 本机家目录(本地工作区下拉/浏览默认起点) */
  localHome?: string | null;
  /** 本机保存过的本地工作区历史 */
  savedLocalWs?: string[];
  onWorkspaceSet: (ws: string) => void;
  /** 选择/切换本地工作区 */
  onLocalWorkspaceSet?: (p: string) => void;
  /** 从当前服务器的工作区历史中删除一条记录(仅删快捷记录,不影响远程目录) */
  onDeleteWs?: (ws: string) => void;
  /** 从本地工作区历史中删除一条记录 */
  onDeleteLocalWs?: (p: string) => void;
  /** 在新对话中分支:由 App 执行 session_fork 并刷新会话(at 为 turns 索引,-1 表示从尾部;缺省时隐藏分支按钮) */
  onFork?: (at: number) => void;
  /** 新会话草稿态发送首条消息:ChatPanel 先创建服务端会话,成功后回调让 App 刷新会话列表/active/sessionSeq */
  onSessionCreated?: (r: any) => void;
}

export default function ChatPanel({ connected, workspace, localWorkspace, busy, sessionSeq = 0, sid = null, home = null, savedWs = [], localHome = null, savedLocalWs = [], onWorkspaceSet, onLocalWorkspaceSet, onDeleteWs, onDeleteLocalWs, onFork, onSessionCreated }: ChatPanelProps) {
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
  const [agentState, setAgentState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  // 会话切换加载指示:切换期间保留上一会话内容 + 顶部提示,历史到达后再整体替换,避免空白闪烁
  const [switching, setSwitching] = useState(false);
  // 抑制入场动画:历史整表载入(挂载/切换会话/后台刷新)时给 .chat 加 no-anim,
  // 连最新一条消息的 msg-in 淡入也不播——切换瞬间就该是静止的成品画面;
  // 只有用户实时发送(start/steer 追加新消息)才解除,让新消息保留浮现动效
  const [suppressIn, setSuppressIn] = useState(true);
  // 会话历史缓存:切回已加载过的会话时秒开(零网络),后台静默刷新保持最新
  const histCache = useRef(new Map<string, { msgs: ChatMessage[]; todos: TodoItem[] }>());
  // 模型提问挂起(ask_user_question):未作答前锁定输入框与停止按钮
  const [askPending, setAskPending] = useState(false);
  // 新会话草稿态发送成功后:跳过随后 sid 变化触发的历史回载(首条消息由事件流渲染)
  const skipHistoryOnceRef = useRef(false);
  // 待执行消息队列(工作中发送的消息,显示在输入框上方,当前轮结束后按 FIFO 自动执行)
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [reasoning, setReasoning] = useState(() => {
    // 迁移旧设置:以前独立存的 thinkingMode=off 等价于现在的推理等级 off;其余回落到 high/默认
    const tm = localStorage.getItem('sshai.thinkingMode');
    const saved = localStorage.getItem('sshai.reasoning') || localStorage.getItem('sshai.thinking') || '';
    if (tm === 'off' || saved === 'off') return 'off';
    if (saved === 'max' || saved === 'low' || saved === 'xhigh') return saved;
    return 'default';
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null); // chatwrap:聊天滚动条拇指的宿主(整列高度,含输入区区域)
  const taRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null); // 高亮叠加层(与 textarea 滚动同步)
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

  const push = (fn: (m: ChatMessage[]) => ChatMessage[]) => setMessages(fn);

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
              push((msgs) => { const c = [...msgs]; const l = c[c.length - 1]; if (l?.streaming) l.streaming = false; return c; });
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
            push((msgs) => [...msgs, { role: 'user', content: m.text, time: Date.now(), forkTail: forkTurnRef.current - 1 }]);
            push((msgs) => [...msgs, { role: 'assistant', segments: [], streaming: true, forkTail: forkTurnRef.current - 1 }]);
            break;
          case 'todo_update':
            // todo_write 工具写入的任务计划整表快照
            setTodos(Array.isArray(m.todos) ? m.todos : []);
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
              const copy = [...msgs];
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') appendText(last, m.text);
              return copy;
            });
            break;
          case 'reasoning_delta':
            // 思考内容增量(推理模型的 reasoning 通道):按到达顺序落为独立段,
            // 后续步骤的思考自然出现在上一组工具调用之后,而不是全堆在消息开头
            push((msgs) => {
              const copy = [...msgs];
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') appendReasoning(last, m.text);
              return copy;
            });
            break;
          case 'tool_call':
            push((msgs) => {
              const copy = [...msgs];
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') {
                appendTools(last, [{ id: m.callId, tool: m.tool, args: m.args, ok: undefined, ms: undefined, result: undefined }]);
              }
              return copy;
            });
            break;
          case 'tool_result':
            // 每条工具结果对应一条 tool/result turn,分支点推进到最后落定的结果
            forkTurnRef.current += 1;
            push((msgs) => {
              const copy = [...msgs];
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant' && Array.isArray(last.segments)) {
                last.forkTail = forkTurnRef.current - 1;
                const tseg = [...last.segments].reverse().find((s) => s.kind === 'tools');
                if (tseg) {
                  const tools = tseg.tools || [];
                  const byId = m.callId ? tools.find((x) => x.id === m.callId) : null;
                  const target = byId || tools.find((x) => x.tool === m.tool && x.ok === undefined);
                  if (target) Object.assign(target, { ok: m.ok, ms: m.ms, result: m.result, meta: m.meta });
                }
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
                // 最终文本通常已由 text_delta 流式拼好;这里只补上未流出的部分
                // (如达到最大迭代次数后追加的提示),避免重复
                const cur = segText(last);
                const doneText = m.text || '';
                const suffix = doneText.startsWith(cur) ? doneText.slice(cur.length) : doneText;
                if (suffix) appendText(last, suffix);
              }
              return copy;
            });
            break;
          case 'stopped':
            setAgentState('idle');
            push((msgs) => { const c = [...msgs]; const l = c[c.length - 1]; if (l?.streaming) l.streaming = false; return c; });
            break;
          case 'error':
            setAgentState('error'); setErrorMsg(m.message);
            push((msgs) => { const c = [...msgs]; const l = c.slice(-1)[0]; if (l?.streaming) l.streaming = false; return c; });
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
          case 'retry':
            // 模型请求失败进入重试:显示「重试第 N/M 次」(对齐 harness llm-retry 语义)。
            // 同一失败的重试提示原地更新,避免堆叠;流式 assistant 存在时插到它前面
            push((msgs) => {
              const c = [...msgs];
              const err = String(m.error || '网络错误').slice(0, 120);
              const delay = Math.round((Number(m.delayMs) || 2000) / 1000);
              const content = `请求失败(${err}),${delay}s 后重试(第 ${m.retry}/${m.maxRetries} 次)`;
              for (let i = c.length - 1; i >= 0; i--) {
                if (c[i]?.retryNotice) { c[i] = { role: 'notice', content, retryNotice: true }; return c; }
              }
              const last = c[c.length - 1];
              if (last?.role === 'assistant' && last.streaming) {
                c.splice(c.length - 1, 0, { role: 'notice', content, retryNotice: true });
              } else {
                c.push({ role: 'notice', content, retryNotice: true });
              }
              return c;
            });
            break;
          case 'steer':
            // 运行中补充的指令:显示为用户消息,并另起一条流式 assistant 气泡接收后续输出
            // (后端会写入一条 steer 的 user/message,计入分支点计数)
            forkTurnRef.current += 1;
            setSuppressIn(false); // 实时追加:解除入场动画抑制
            push((msgs) => {
              const c = [...msgs];
              const l = c[c.length - 1];
              if (l?.streaming) l.streaming = false;
              c.push({ role: 'user', content: m.text, time: Date.now(), forkTail: forkTurnRef.current - 1 });
              c.push({ role: 'assistant', segments: [], streaming: true, forkTail: forkTurnRef.current - 1 });
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

  // 组件卸载(切走标签页/关闭)前立即落盘草稿,避免 400ms 防抖窗口内的输入丢失
  useEffect(() => () => persistDrafts(), []);

  // 挂载或会话切换时,载入当前活跃会话的历史。
  // 不先清空消息:保留上一会话内容 + 「正在加载会话」提示,新会话历史到达后再整体替换,
  // 避免切换出现空白闪烁;已加载过的会话走缓存秒开,后台静默刷新保持最新。
  useEffect(() => {
    let alive = true;
    const target = sid; // 本次要加载的会话 id(防止异步响应串到别的会话)
    const skipHistory = skipHistoryOnceRef.current; // 新会话草稿态刚创建并发送:消息由事件流渲染
    skipHistoryOnceRef.current = false;

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

    // 新会话草稿态(sid 为占位符):不请求历史,显示空对话;sid=null(App 初次加载尚未定向)
    // 则沿用原切换重载逻辑(请求 get_history 拿回服务端活跃会话)
    if (target === NEW_SESSION_ID) {
      setSuppressIn(true);
      setMessages([]);
      setSwitching(false);
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
        // 切回一个仍在运行中的会话:末条回复标记为流式中,继续接收后续增量事件
        if (busyRef.current) {
          const last = msgs[msgs.length - 1];
          if (last?.role === 'assistant') last.streaming = true;
        }
        histCache.current.set(target ?? '', { msgs, todos: Array.isArray(r.todos) ? r.todos : [] });
        setSuppressIn(true); // 历史整表替换:抑制最新一条的入场动画,切换画面保持静止
        setMessages(msgs);
        setTodos(Array.isArray(r.todos) ? r.todos : []); // 该会话当前的任务计划
        setQueue(Array.isArray(r.queue) ? r.queue : []); // 该会话的待执行队列快照
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
    } catch (e) { toast.error((e as Error).message); }
  };

  // 用户消息索引(左侧跳转点数据源:每条用户消息对应一个点;压缩标记行不算用户消息,跳过)
  const userMsgIndices = messages.reduce((acc: number[], m, i) => {
    if (m.role === 'user' && !m.compaction) acc.push(i);
    return acc;
  }, []);

  // 计算当前激活点:视口 40% 参考线之下的最后一条用户消息
  const updateActiveDot = () => {
    const el = scrollRef.current;
    if (!el) return;
    const line = el.getBoundingClientRect().top + el.clientHeight * 0.4;
    let cur = -1;
    for (const i of userMsgIndices) {
      const node = userMsgRefs.current[i];
      if (node && node.getBoundingClientRect().top <= line) cur = i;
    }
    setActiveDot(cur);
  };

  // 点击跳转点:平滑滚动到对应的用户消息
  const jumpToMsg = (i: number) => {
    const el = scrollRef.current;
    const node = userMsgRefs.current[i];
    if (!el || !node) return;
    const top = el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
    el.scrollTo({ top, behavior: 'smooth' });
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
  // 保证会话切换/流式更新时滚动条与内容在同一帧就位。这里强制瞬时定位:
  // 1) 临时禁用平滑滚动(scroll-behavior:smooth 会让程序化 scrollTop 赋值也
  //    动画,造成"内容从上面缓缓落下"的过渡);2) 拇指跳过淡入立即就位。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prevBehavior = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto'; // 覆盖任何来源的平滑滚动,保证瞬间滚底
    refreshOverlayScrollbar(el, true); // 先清掉上一会话残留的绝对定位拇指(scrollHeight 才恢复真实值)
    el.scrollTop = el.scrollHeight;    // 滚到底部(最新消息)——切换会话与流式期间都保持底部
    refreshOverlayScrollbar(el, true); // 同一帧内把拇指重绘到当前正确位置/尺寸
    el.style.scrollBehavior = prevBehavior;
    updateActiveDot();
  }, [messages]);

  // 会话切换的兜底:首帧布局时内容挂载动画/延迟加载的图片可能在绘制后几帧内
  // 才把 scrollHeight 撑到最终值,首帧测得的底部与拇指长度会偏小,看起来就像
  // "滚动条从长到短缓缓过渡"。绘制后下一帧再强制滚底 + 重绘一次拇指,保证
  // 切换会话后滚动条立即是最终形态(仅会话切换后触发一次,不干扰普通流式)。
  useEffect(() => {
    if (!justSwitchedRef.current) return;
    justSwitchedRef.current = false;
    const id = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      const prevBehavior = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      el.scrollTop = el.scrollHeight;
      refreshOverlayScrollbar(el, true);
      el.style.scrollBehavior = prevBehavior;
      updateActiveDot();
    });
    return () => cancelAnimationFrame(id);
  }, [messages]);

  // 跳转点悬停提示:取不被裁剪的 fixed 定位,按当前点视口坐标弹出到右侧
  const showDotTip = (e: React.MouseEvent<HTMLButtonElement>, text: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setDotTip({ top: r.top + r.height / 2, left: r.right + 8, text });
  };
  const hideDotTip = () => setDotTip(null);

  // 发送文本就是输入框原文(技能 /词 原样保留,后端按独立词解析注入)
  const composedInput = input;
  // 输入中是否已含完整 /技能名(用于占位提示与去重判断)
  const hasSkillToken = /(?:^|\s)\/[a-z0-9][a-z0-9-]*(?=\s|$)/i.test(input);

  const send = async () => {
    // 工作中仍可发送:服务端会把消息放入待执行队列(当前轮结束后按序自动执行,不打断回复);
    // 提问挂起时禁止发送(须先作答或取消)
    if (!input.trim() || !canSend || askPending) return;
    const text = composedInput;
    // 新会话草稿态(sid 为占位符或尚未加载):先真正创建服务端会话(此时才列入历史会话列表),
    // 创建失败则保留输入与草稿,不发送
    if (sid == null || sid === NEW_SESSION_ID) {
      try {
        const r = await api.request('session_create', {}, 8000);
        activeRef.current = r.active ?? null; // 立即更新事件路由,不等 App 侧 state 同步
        skipHistoryOnceRef.current = true; // 跳过随后 sid 变化触发的历史回载(消息由事件流渲染)
        onSessionCreated?.(r); // App 刷新会话列表并激活新会话
      } catch (e) {
        toast.error(`新建会话失败: ${(e as Error).message}`);
        return;
      }
    }
    // 发送即使用草稿:清除对应会话(或新会话)的输入草稿
    if (sid === NEW_SESSION_ID) delete draftsRef.current[NEW_DRAFT_KEY];
    else if (sid) delete draftsRef.current[sid];
    saveDrafts(draftsRef.current);
    setInput('');
    inputValueRef.current = ''; // 同步最新输入,防止随后的草稿保存把已发送文本回写
    setMessages((m) => [...m]);
    api.send('speak', { text, reasoning });
  };

  // ---- 待执行队列操作 ----
  // 立即执行:把排队中的消息立即注入当前对话(忙碌时作为下一步 steer,空闲时直接开新轮)
  const runQueueNow = async (item: QueueItem) => {
    try {
      const r = await api.request('queue_steer', { id: item.id }, 8000);
      setQueue(Array.isArray(r.queue) ? r.queue : []);
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

  // ---- / 命令菜单(照搬 deepseek-harness 的行内命令交互) ----
  // 系统命令:除技能外,提供常见会话操作(与 harness 的 command-compact/clear/fork 对齐)
  const slashCommands: SlashItem[] = [
    {
      name: 'compact', kind: 'command',
      description: '压缩当前会话上下文(把早期对话合并为摘要,释放窗口空间)',
      run: async () => {
        if (busy || agentState === 'working') { toast.warning('Agent 正在运行,请先停止或等待完成再压缩'); return true; }
        try {
          const r = await api.request('compact_now', {}, 120000);
          // 命令反馈走 toast(玻璃胶囊,自动消失),不用底部红色错误横幅:
          // 压缩成功/无需压缩是信息而非错误,错误横幅只留给真正的失败
          if (r.compacted) toast.success(`已压缩 ${r.dropCount} 条早期消息,上下文空间已释放`);
          else toast.info('当前历史较短,无需压缩');
        } catch (e) {
          toast.error((e as Error).message);
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
      await api.request('set_workspace', { path: p }, 20000);
      onWorkspaceSet(p); setWsBrowserOpen(false); setWsMenuOpen(false);
    } catch (e) { toast.error((e as Error).message); }
  };

  const setLocalWorkspace = (p: string) => {
    if (!onLocalWorkspaceSet) return;
    onLocalWorkspaceSet(p); // App 内负责 set_local_workspace 请求 + 记录历史
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
  // 连接时需远程工作区,本地模式需本地工作区;
  // 模型提问挂起时锁定输入与暂停(须先作答或取消提问);会话切换加载中也锁定,避免发到错误会话
  const canSend = (connected ? !!workspace : !!localWorkspace) && !askPending && !switching;

  return (
    // 根为 fragment:跳转点(chat-dots)渲染在 chatwrap 之外,作为 tab-body 的子元素
    // 始终锚定对话区最左侧,不随限宽列移动(见 chat-dots 样式注释)
    <>
    <div className={`chatwrap${askPending ? ' ask-focus' : ''}`} ref={wrapRef}>
      <div className="chat-scroll">
        <div className={`chat${suppressIn ? ' no-anim' : ''}`} ref={scrollRef} onScroll={() => { updateActiveDot(); hideDotTip(); }}>
          {messages.length === 0 && (
            <div className="empty">
              <img className="empty-logo" src="/logo-256.png" alt="" />
              <div>{connected ? '连接服务器、选择工作区后,即可让 Agent 在远程服务器上工作' : '未连接服务器 · 选择本地工作区后,即可让 Agent 在本机工作'}</div>
              <div className="muted">例如:「帮我看一下这个项目结构,然后修复 main.js 里的 bug」</div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}${m.compaction ? ' compaction-msg' : ''}`} ref={(el) => { userMsgRefs.current[i] = el; }}>
              {m.compaction && (
                // 上下文压缩标记行(手动/自动):折叠展示摘要,展开看正文(样式参照 harness CompactionItem)
                <CompactionRow content={m.content || ''} dropCount={m.compaction.dropCount} manual={m.compaction.manual} />
              )}
              {m.role === 'notice' && <div className={`bubble ${m.retryNotice ? 'retry-bubble' : 'notice-bubble'}`}>⚠ {m.content}</div>}
              {m.role === 'user' && !m.compaction && (
                <>
                  <div className="bubble user-bubble">{m.content}</div>
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
                      // 流式时仅最后一段标记 running 获得扫光)
                      if (seg.kind === 'reasoning') {
                        return (seg.text && seg.text.trim())
                          ? <ReasoningRow key={si} text={seg.text.trim()} running={m.streaming && si === (m.segments || []).length - 1} />
                          : null;
                      }
                      return <div key={si}>{renderAssistantContent(seg.text || '') || <AssistantText text={seg.text || ''} />}</div>;
                    })}
                    {m.streaming && (m.segments || []).length === 0 && <span className="cursor" aria-hidden="true" />}
                  </div>
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
        </div>
      </div>
      {/* 跳转点悬停内容提示:fixed 定位防裁剪,两行截断 + 省略号 */}
      {dotTip && (
        <div className="dot-tip" style={{ top: dotTip.top, left: dotTip.left }}>{dotTip.text}</div>
      )}
      {errorMsg && <div className="error">{errorMsg}</div>}
      {/* 任务计划面板:输入区玻璃面板之外,独立玻璃卡片悬浮(默认折叠,无计划时隐藏) */}
      <TodoPanel todos={todos} />
      <div className="composer">
        {/* 模型提问面板(ask_user_question):内联显示在输入框上方,无遮罩;作答/取消前锁定输入 */}
        <AskPanel sid={sid} onPendingChange={setAskPending} />
        {/* 待执行消息队列:对话进行中发送的消息在此排队等待,当前轮结束后按 FIFO 自动执行 */}
        <QueuePanel queue={queue} onRunNow={runQueueNow} onEdit={editQueueItem} onDelete={deleteQueueItem} />
        <div className="composer-box">
          {/* / 命令菜单:输入 / (行首或空格后)时浮在输入框上方,前缀优先+模糊匹配过滤 */}
          {slashOpen && (
            <SlashMenu
              items={slashAll}
              query={slashQuery}
              active={slashActive}
              onActiveChange={setSlashActive}
              onPick={pickSlash}
              onClose={closeSlash}
            />
          )}
          <div className="composer-input">
            {/* 高亮叠加层:文字透明只露出 /技能名 高亮底;pointer-events 穿透,不挡输入 */}
            <div className="composer-overlay" ref={overlayRef} aria-hidden="true">
              {tokenizeInput(input).map((s, i) => s.t === 'skill'
                ? <span className="composer-token" key={i}>{s.v}</span>
                : <span key={i}>{s.v}</span>)}
              {input.endsWith('\n') && <span> </span>}
            </div>
            <textarea ref={taRef} rows={1} value={input}
              onChange={(e) => { const v = e.target.value; updateInput(v); syncSlash(v); }}
              onScroll={syncOverlayScroll}
              placeholder={!connected && !localWorkspace ? '未连接服务器 · 选择本地工作区后即可对话'
                : connected && !workspace ? '请先选择远程工作区'
                : askPending ? '请先在提问面板中作答或取消…'
                : working ? 'Agent 工作中,发送后将进入队列等待执行…'
                : hasSkillToken ? '输入需求…' : '输入 / 可唤起命令与技能菜单…'}
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
                // 退格整词删除:光标紧邻完整 /技能名(行首/空白后、后跟空白或结尾)时,
                // 一整个删除(连同其后单个空格,避免留下双空格)
                if (!slashOpen && e.key === 'Backspace') {
                  const el = e.currentTarget as HTMLTextAreaElement;
                  if (el.selectionStart === el.selectionEnd) {
                    const pre = el.value.slice(0, el.selectionStart);
                    const m = /(^|\s)(\/[a-z0-9][a-z0-9-]*[ \t]?)$/i.exec(pre);
                    if (m) {
                      e.preventDefault();
                      let end = el.selectionStart;
                      // m[2] 未带尾随空格且光标后紧跟一个空格时一并删掉,避免留下双空格
                      if (!/[ \t]$/.test(m[2]) && /[ \t]/.test(el.value[end] || '')) end += 1;
                      const start = el.selectionStart - m[2].length;
                      const next = el.value.slice(0, start) + el.value.slice(end);
                      updateInput(next);
                      syncSlash(next);
                      requestAnimationFrame(() => {
                        const t = taRef.current;
                        if (t) { t.setSelectionRange(start, start); t.focus(); }
                      });
                      return;
                    }
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                else if (e.key === 'Escape') updateInput('');
              }} />
          </div>
          <div className="composer-foot">
            <span className="muted composer-tip">Enter 发送 · Shift+Enter 换行</span>
            <ContextMeter messages={messages} input={composedInput}
              contextWindow={llm.effModelContext?.contextWindow || 0} />
            {/* 工作中且输入框为空:显示停止按钮;有内容时变为发送按钮,
                发送后默认进入待执行队列等待执行 */}
            {working && !askPending && !input.trim()
              ? <button className="send-btn stop" onClick={stop} title="停止当前任务">⏹</button>
              : <button className="send-btn"
                  title={working ? 'Agent 工作中,发送后进入队列等待执行' : '发送'}
                  disabled={!canSend || !input.trim()} onClick={send}>➤</button>}
          </div>
        </div>
        {/* 工作区 + 模型:工作区在左,模型在右;模型为二级菜单(模型清单按提供商分组 / 推理等级) */}
        <div className="wsbar-row">
          {connected && (
            <div className="wsbar" ref={wsBarRef}>
              <button
                className={`ws-chip ${workspace ? '' : 'none'}`}
                onClick={() => { setWsMenuOpen((v) => !v); setLocalWsMenuOpen(false); }}
              >
                <span className="ws-chip-path">{workspace ? `📂 ${lastPathSegment(workspace)}` : '选择远程工作区'}</span>
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
              className={`ws-chip local ${localWorkspace ? '' : 'none'}`}
              onClick={() => { setLocalWsMenuOpen((v) => !v); setWsMenuOpen(false); }}
            >
              <span className="ws-chip-path">{localWorkspace ? `🖥 ${lastPathSegment(localWorkspace)}` : '选择本地工作区'}</span>
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