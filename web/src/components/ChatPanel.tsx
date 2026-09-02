import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../api';
import { useLlm } from '../llm-context';
import type { ChatMessage, MsgSegment, ToolCallInfo, TodoItem, SkillInjected } from '../types';
import DirBrowser from './DirBrowser';
import LocalDirBrowser from './LocalDirBrowser';
import GlassSelect from './GlassSelect';
import ContextMeter from './ContextMeter';
import TodoPanel from './TodoPanel';
import SlashMenu, { rankSlashItems } from './SlashMenu';
import type { SlashItem } from './SlashMenu';
import type { GlassOption } from './GlassSelect';
import { useFeedback } from '../feedback';
import AskPanel from './AskPanel';
import { ToolCallList } from './ToolCallList';
import { ReasoningRow } from './ReasoningRow';
import { refreshOverlayScrollbar } from '../scrollbar-ui';

// 完整 Markdown 解析(marked + DOMPurify):
// gfm 支持表格/任务列表等,breaks 保留单换行即换行的聊天习惯;
// 输出再经 DOMPurify 白名单清洗,AI 内容里即使夹带 HTML 也不会注入。
const mdParser = new Marked({ gfm: true, breaks: true });

// 推理等级 = 模型的 reasoning_effort 参数,共 6 档:
// Default(不传,用提供方默认)/ Off(关闭思考,thinking.type=disabled)/
// Low / High / Xhigh / Max。Off 即关闭思考,无需单独的思考开关。
const REASONING_LEVELS = [
  { id: 'default', label: '默认', title: 'DeepSeek v4 显式开启思考(不传 effort);其余模型用提供方默认推理强度' },
  { id: 'off', label: '关闭', title: '关闭思考模式(thinking.type=disabled),直接作答,最快' },
  { id: 'low', label: '低', title: 'reasoning_effort=low,轻量推理' },
  { id: 'high', label: '高', title: 'reasoning_effort=high,标准推理强度' },
  { id: 'xhigh', label: '较高', title: 'reasoning_effort=xhigh,更强推理' },
  { id: 'max', label: '最高', title: 'reasoning_effort=max,极限推理,适合复杂 Agent 任务' }
];

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

// 已加载技能折叠行(参考 harness ContextInjectionRow 的披露行设计):
// 折叠头一行带过(图标+标题+分隔点+技能名),点击展开看每个技能的描述与指令预览;
// 与 ToolRun 共用一套玻璃折叠条视觉,保持对话流内记录组件的一致节奏
function SkillRun({ skills = [] }: { skills?: SkillInjected[] }) {
  const [open, setOpen] = useState(false);
  if (!skills.length) return null;
  return (
    <div className="skillrun">
      <div className="skillrun-head" onClick={() => setOpen(!open)} title={open ? '收起技能详情' : '展开技能详情'}>
        <span className="tc-arrow">{open ? '▾' : '▸'}</span>
        <span className="skillrun-title">📚 已加载技能</span>
        {skills.map((s) => (
          <span key={s.name} className="skillrun-item">
            <span className="skillrun-sep" aria-hidden />
            <code className="skillrun-name">{s.name}</code>
          </span>
        ))}
        <span className="muted">{skills.length > 1 ? `${skills.length} 个技能指令已注入本轮对话` : '技能指令已注入本轮对话'}</span>
      </div>
      {open && (
        <div className="skillrun-body">
          {skills.map((s) => (
            <div key={s.name} className="skillrun-card">
              <div className="skillrun-card-head">
                <code className="skillrun-name">{s.name}</code>
                {s.description && <span className="muted">{s.description}</span>}
              </div>
              {s.preview && <pre className="skillrun-preview">{s.preview}{s.preview.length >= 600 ? '\n…(完整指令已注入模型上下文)' : ''}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
      <button type="button" className="msg-action" aria-label="复制"
        title={copied ? '已复制' : '复制'} onClick={onCopy}>
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
      {onBranch && (
        <button type="button" className="msg-action" aria-label="在新对话中分支"
          title="在新对话中从此处分支继续(保留此条回复之前的内容,之后另起炉灶)"
          onClick={onBranch}>
          <IconBranch />
        </button>
      )}
    </div>
  );
}

// 把服务端的 skillsInjected 归一化为 SkillInjected[]:
// 新格式为对象数组(name+description+preview),旧会话可能持久化过纯名字数组(string[]),做兼容
function normalizeSkills(raw: any): SkillInjected[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillInjected[] = [];
  for (const s of raw) {
    if (typeof s === 'string') { out.push({ name: s }); continue; }
    if (s && typeof s === 'object' && typeof s.name === 'string') {
      out.push({
        name: s.name,
        description: s.description ? String(s.description) : '',
        preview: s.preview ? String(s.preview) : ''
      });
    }
  }
  return out;
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
  const toolById = new Map<string, ToolCallInfo>(); // tool_call_id -> {tool, ok, ms?, result}
  for (let ti = 0; ti < turns.length; ti++) {
    const t = turns[ti];
    if (t.role === 'tool') {
      if (t.tool_call_id) {
        const id = String(t.tool_call_id);
        toolById.set(id, { tool: t.tool_name, args: t.tool_args, ok: t.ok ?? true, ms: t.ms, result: t.content || '', meta: t.meta });
      }
      // 工具结果并入所在回复,该消息的分支点随之推进到这条 turn
      const last = out[out.length - 1];
      if (last) last.forkTail = ti;
      continue; // tool 消息本身不渲染,只作为结果并入上游工具组
    }
    if (t.role === 'user') {
      out.push({ role: 'user', content: t.content || '', forkTail: ti });
      // 手动调用技能(/技能名)注入过:紧跟一条"已加载技能"折叠行,历史/分支回放时同样可恢复
      const sk = normalizeSkills(t.skillsInjected);
      if (sk.length) out.push({ role: 'skilltag', skills: sk, forkTail: ti });
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
}

export default function ChatPanel({ connected, workspace, localWorkspace, busy, sessionSeq = 0, sid = null, home = null, savedWs = [], localHome = null, savedLocalWs = [], onWorkspaceSet, onLocalWorkspaceSet, onDeleteWs, onDeleteLocalWs, onFork }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [input, setInput] = useState('');
  // / 命令菜单(照搬 harness 的行内命令交互):slashOpen=true 时输入以 / 开头,
  // slashQuery 为斜杠后的过滤词;技能候选来自 skills_list(未连接时仍返回内置+本机技能)
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashActive, setSlashActive] = useState(-1);
  const [slashSkills, setSlashSkills] = useState<SlashItem[]>([]);
  const [agentState, setAgentState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [iter, setIter] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  // 会话切换加载指示:切换期间保留上一会话内容 + 顶部提示,历史到达后再整体替换,避免空白闪烁
  const [switching, setSwitching] = useState(false);
  // 会话历史缓存:切回已加载过的会话时秒开(零网络),后台静默刷新保持最新
  const histCache = useRef(new Map<string, { msgs: ChatMessage[]; todos: TodoItem[] }>());
  // 模型提问挂起(ask_user_question):未作答前锁定输入框与停止按钮
  const [askPending, setAskPending] = useState(false);
  const [reasoning, setReasoning] = useState(() => {
    // 迁移旧设置:以前独立存的 thinkingMode=off 等价于现在的推理等级 off;其余回落到 high/默认
    const tm = localStorage.getItem('sshai.thinkingMode');
    const saved = localStorage.getItem('sshai.reasoning') || localStorage.getItem('sshai.thinking') || '';
    if (tm === 'off' || saved === 'off') return 'off';
    if (saved === 'max' || saved === 'low' || saved === 'xhigh') return saved;
    return 'default';
  });
  const scrollRef = useRef<HTMLDivElement>(null);
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

  // 对话提供方下拉:仅显示已保存且配置了 API Key 的提供商;预置提供商只作为添加时的模板,不进切换列表
  const keyedProviders = llm.userProviders.filter((p) => p.apiKey);
  const curInKeyed = keyedProviders.some((p) => p.id === llm.providerId);
  const providerOptions: GlassOption[] = [
    // 当前使用的提供商若不在列表(如预置未配 Key / mock),置顶显示为占位,提示需配置
    ...(!curInKeyed ? [{ value: llm.providerId, label: llm.provider.name, hint: llm.isMock ? '联调模式' : '未配 Key', disabled: true }] : []),
    ...keyedProviders.map((p) => ({ value: p.id, label: `★ ${p.name}`, hint: 'Key ✓' }))
  ];

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
      }),
      api.on('agent', (m: any) => {
        // 多会话并行:只处理当前活跃会话的事件,其他会话(后台运行中)的流不进入本视图
        if (m.sid && activeRef.current && m.sid !== activeRef.current) return;
        switch (m.event) {
          case 'status':
            setAgentState(m.status === 'running' ? 'working' : 'idle');
            if (m.status !== 'running') {
              push((msgs) => { const c = [...msgs]; const l = c[c.length - 1]; if (l?.streaming) l.streaming = false; return c; });
            }
            break;
          case 'start':
            hasLive.current = true;
            // 本轮首条 user/message 计入分支点计数
            forkTurnRef.current += 1; lastIterRef.current = 0;
            setAgentState('working'); setIter(0); setErrorMsg('');
            setTodos([]); // 开启新一轮:上一轮的任务计划清空(对齐 harness 的 standing plan 语义)
            push((msgs) => [...msgs, { role: 'user', content: m.text, forkTail: forkTurnRef.current - 1 }]);
            push((msgs) => [...msgs, { role: 'assistant', segments: [], streaming: true, forkTail: forkTurnRef.current - 1 }]);
            break;
          case 'todo_update':
            // todo_write 工具写入的任务计划整表快照
            setTodos(Array.isArray(m.todos) ? m.todos : []);
            break;
          case 'iteration':
            setIter(m.iter);
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
          case 'skill_loaded':
            // 用户手动调用技能(/技能名 命中注入):显示"已加载技能"折叠行,插到流式回复之前
            push((msgs) => {
              const c = [...msgs];
              const last = c[c.length - 1];
              const tag = { role: 'skilltag', skills: normalizeSkills(m.skills) };
              if (last?.role === 'assistant' && last.streaming) c.splice(c.length - 1, 0, tag);
              else c.push(tag);
              return c;
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
          case 'steer':
            // 运行中补充的指令:显示为用户消息,并另起一条流式 assistant 气泡接收后续输出
            // (后端会写入一条 steer 的 user/message,计入分支点计数)
            forkTurnRef.current += 1;
            push((msgs) => {
              const c = [...msgs];
              const l = c[c.length - 1];
              if (l?.streaming) l.streaming = false;
              c.push({ role: 'user', content: m.text, forkTail: forkTurnRef.current - 1 });
              c.push({ role: 'assistant', segments: [], streaming: true, forkTail: forkTurnRef.current - 1 });
              return c;
            });
            break;
        }
      })
    ];
    return () => subs.forEach((off) => off());
  }, []);

  // 挂载或会话切换时,载入当前活跃会话的历史。
  // 不先清空消息:保留上一会话内容 + 「正在加载会话」提示,新会话历史到达后再整体替换,
  // 避免切换出现空白闪烁;已加载过的会话走缓存秒开,后台静默刷新保持最新。
  useEffect(() => {
    let alive = true;
    const target = sid; // 本次要加载的会话 id(防止异步响应串到别的会话)
    hasLive.current = false; // 切换会话:重置"已有新对话"标记,让新会话历史立即显示
    justSwitchedRef.current = true; // 切换会话:绘制后兜底重测滚底/拇指,见下方 [messages] 兜底 effect
    forkTurnRef.current = 0; lastIterRef.current = 0; // 分支点计数器随会话重置
    setTodos([]);
    setAgentState('idle'); setIter(0); setErrorMsg('');
    // 有缓存则立即显示(切回已看过的会话零等待);无缓存时保留旧内容 + 加载指示
    const cached = histCache.current.get(target ?? '');
    if (cached) { setMessages(cached.msgs); setTodos(cached.todos); setSwitching(false); }
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
        setMessages(msgs);
        setTodos(Array.isArray(r.todos) ? r.todos : []); // 该会话当前的任务计划
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
  };

  // 用户消息索引(左侧跳转点数据源:每条用户消息对应一个点)
  const userMsgIndices = messages.reduce((acc: number[], m, i) => {
    if (m.role === 'user') acc.push(i);
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

  const send = () => {
    // 工作中仍可发送:服务端会把消息转为 steer(补充指令注入下一步);
    // 提问挂起时禁止发送(须先作答或取消)
    if (!input.trim() || !canSend || askPending) return;
    setInput('');
    setMessages((m) => [...m]);
    api.send('speak', { text: composedInput, reasoning });
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
          if (r.compacted) setErrorMsg(`✔ 已压缩 ${r.dropCount} 条早期消息`);
          else setErrorMsg('当前历史较短,无需压缩');
        } catch (e) {
          setErrorMsg((e as Error).message);
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
        if (!onFork) { setErrorMsg('分支功能不可用'); return true; }
        onFork(-1); return true; // /fork 从会话尾部整体分支
      }
    },
    {
      name: 'help', kind: 'command',
      description: '查看可用命令',
      run: (q: string) => {
        api.send('speak', { text: '请用一句话列出当前可用的斜杠命令及其用途。', reasoning });
        setInput('');
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
      setInput(next);
      syncSlash(next);
      setSlashOpen(false);
      setSlashActive(-1);
      requestAnimationFrame(() => { const el = taRef.current; if (el) el.focus(); });
      return;
    }
    closeSlash();
    setInput('');
    item.run?.(query);
  };

  const stop = () => api.send('stop_agent', {});

  // ---- 工作区切换(输入框下方):点击弹出下拉,切换/浏览选择工作区 ----
  const [wsBrowserOpen, setWsBrowserOpen] = useState(false);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  // ---- 本地工作区:与远程工作区并排,同样支持多个本地工作区 ----
  const [localWsBrowserOpen, setLocalWsBrowserOpen] = useState(false);
  const [localWsMenuOpen, setLocalWsMenuOpen] = useState(false);
  const wsbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wsMenuOpen && !localWsMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wsbarRef.current && !wsbarRef.current.contains(e.target as Node)) { setWsMenuOpen(false); setLocalWsMenuOpen(false); }
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
  // 工作中也允许输入发送(自动作为运行中补充指令);连接时需远程工作区,本地模式需本地工作区;
  // 模型提问挂起时锁定输入与暂停(须先作答或取消提问);会话切换加载中也锁定,避免发到错误会话
  const canSend = (connected ? !!workspace : !!localWorkspace) && !askPending && !switching;

  return (
    <div className="chatwrap">
      <div className="chat-head">
        <span className="muted">
          {switching ? '正在加载会话…' : askPending ? '等待你回答问题…' : working ? `Agent 工作中 · 迭代 #${iter}` : agentState === 'error' ? '出现错误' : agentState === 'done' ? '已完成' : '空闲'}
        </span>
        <span className="row gap">
          {working && !askPending && <button className="ghost sm" onClick={stop}>⏹ 停止</button>}
          {messages.length > 0 && <button className="ghost sm" title="清空对话历史(含服务端持久化)" onClick={clearAll}>🗑 清空</button>}
        </span>
      </div>
      <div className="chat-scroll">
        <div className="chat" ref={scrollRef} onScroll={() => { updateActiveDot(); hideDotTip(); }}>
          {messages.length === 0 && (
            <div className="empty">
              <div>{connected ? '连接服务器、选择工作区后,即可让 Agent 在远程服务器上工作' : '未连接服务器 · 选择本地工作区后,即可让 Agent 在本机工作'}</div>
              <div className="muted">例如:「帮我看一下这个项目结构,然后修复 main.js 里的 bug」</div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`} ref={(el) => { userMsgRefs.current[i] = el; }}>
              {m.role === 'notice' && <div className="bubble notice-bubble">⚠ {m.content}</div>}
              {m.role === 'skilltag' && <SkillRun skills={m.skills} />}
              {m.role === 'user' && <div className="bubble user-bubble">{m.content}</div>}
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
                    {m.streaming && (m.segments || []).length === 0 && <span className="cursor">▍</span>}
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
      {/* 用户消息跳转点:absolute 贴对话区(main 内、sidebar 右侧)最左侧,
          不随限宽的聊天内容移动,也不钉在浏览器窗口最左 */}
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
              onChange={(e) => { const v = e.target.value; setInput(v); syncSlash(v); }}
              onScroll={syncOverlayScroll}
              placeholder={!connected && !localWorkspace ? '未连接服务器 · 选择本地工作区后即可对话'
                : connected && !workspace ? '请先选择远程工作区'
                : askPending ? '请先在提问面板中作答或取消…'
                : working ? 'Agent 工作中,输入内容将作为补充指令注入下一步…'
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
                      setInput(next);
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
                else if (e.key === 'Escape') setInput('');
              }} />
          </div>
          <div className="composer-foot">
            <span className="muted composer-tip">Enter 发送 · Shift+Enter 换行</span>
            <ContextMeter messages={messages} input={composedInput}
              contextWindow={llm.effModelContext?.contextWindow || 0} />
            {working && !askPending
              ? <button className="send-btn stop" title="停止 (Ctrl+C 也可)" onClick={stop}>⏹</button>
              : <button className="send-btn" disabled={!canSend || !input.trim()} title="发送" onClick={send}>➤</button>}
          </div>
        </div>
        <div className="composer-toolbar">
          <span className="muted toolbar-label" title="模型的推理强度,对应 reasoning_effort 参数(Default/Off/Low/High/Xhigh/Max)">推理等级</span>
          <GlassSelect className="tb-reasoning" dir="up" value={reasoning}
            title={REASONING_LEVELS.find((lv) => lv.id === reasoning)?.title}
            onChange={changeReasoning}
            options={REASONING_LEVELS.map((lv) => ({ value: lv.id, label: lv.label }))} />
          <div className="grow" />
          <GlassSelect className="tb-provider" dir="up" align="right" value={llm.providerId}
            onChange={(v) => llm.switchProvider(v)}
            title="切换 AI 提供方(仅显示已保存并配置密钥的提供商)"
            placeholder="选择提供方"
            options={providerOptions} />
          {llm.isMock ? (
            <span className="muted tb-model" title="mock 联调模式,无需 API Key">mock 模式</span>
          ) : llm.provider.models.length > 0 ? (
            <GlassSelect className="tb-model" dir="up" title="切换模型"
              value={llm.provider.models.includes(llm.effModel) ? llm.effModel : '__custom__'}
              onChange={(v) => llm.setModel(v)}
              options={[
                ...llm.provider.models.map((m) => ({ value: m, label: m })),
                { value: '__custom__', label: '自定义…' }
              ]} />
          ) : (
            <input className="tb-model" title="模型名"
              value={llm.model} onChange={(e) => llm.setModel(e.target.value)} placeholder="模型名" />
          )}
          {llm.model === '__custom__' && !llm.isMock && llm.provider.models.length > 0 && (
            <input className="tb-model" title="自定义模型名"
              value={llm.customModel} onChange={(e) => llm.setCustomModel(e.target.value)} placeholder="自定义模型名" />
          )}
        </div>
        {/* 工作区:远程 + 本地并排,各自点击弹出下拉(切换保存过的工作区 / 浏览选择新工作区) */}
        <div className="wsbar-row" ref={wsbarRef}>
          {connected && (
            <div className="wsbar">
              <button
                className={`ws-chip ${workspace ? '' : 'none'}`}
                title={workspace ? (connected ? '点击切换/选择工作区' : workspace) : (connected ? '点击选择工作区' : '未连接服务器')}
                onClick={() => { setWsMenuOpen((v) => !v); setLocalWsMenuOpen(false); }}
              >
                <span className="ws-chip-path">{workspace ? `📂 ${workspace}` : '选择工作区'}</span>
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
                            title={workspace === p ? '当前工作区' : `切换工作区到 ${p}`}
                            onClick={() => setWorkspace(p)}>
                            <span className="ws-pick-path">{p}</span>
                            {workspace === p && <span className="ws-pick-cur">✓</span>}
                          </button>
                          <button type="button" className="ws-pick-del" aria-label={`从历史中删除工作区 ${p}`}
                            title="从历史记录中删除(不影响远程目录)"
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
                    <button className="ws-pick-item ws-pick-action" onClick={() => setWorkspace(home)} title={`设为家目录 ${home}`}>
                      🏠 家目录
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="wsbar">
            <button
              className={`ws-chip local ${localWorkspace ? '' : 'none'}`}
              title={localWorkspace ? '点击切换/选择本地工作区' : '点击选择本地工作区'}
              onClick={() => { setLocalWsMenuOpen((v) => !v); setWsMenuOpen(false); }}
            >
              <span className="ws-chip-path">{localWorkspace ? `🖥 ${localWorkspace}` : '选择本地工作区'}</span>
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
                          title={localWorkspace === p ? '当前本地工作区' : `切换本地工作区到 ${p}`}
                          onClick={() => setLocalWorkspace(p)}>
                          <span className="ws-pick-path">{p}</span>
                          {localWorkspace === p && <span className="ws-pick-cur">✓</span>}
                        </button>
                        <button type="button" className="ws-pick-del" aria-label={`从历史中删除本地工作区 ${p}`}
                          title="从历史记录中删除(不影响本地目录)"
                          onClick={() => removeLocalWs(p)}>🗑</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="ctx-sep" />
                <button className="ws-pick-item ws-pick-action" onClick={() => { setLocalWsMenuOpen(false); setLocalWsBrowserOpen(true); }}>
                  🖥 浏览选择其他本地目录…
                </button>
                {localHome && (
                  <button className="ws-pick-item ws-pick-action" onClick={() => setLocalWorkspace(localHome)} title={`设为家目录 ${localHome}`}>
                    🏠 家目录
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {wsBrowserOpen && (
        <DirBrowser initial={workspace || home || '/'} home={home} onClose={() => setWsBrowserOpen(false)} onPick={setWorkspace} />
      )}
      {localWsBrowserOpen && (
        <LocalDirBrowser initial={localWorkspace || localHome || undefined} home={localHome} onClose={() => setLocalWsBrowserOpen(false)} onPick={setLocalWorkspace} />
      )}
    </div>
  );
}