import React, { useEffect, useRef, useState } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../api';
import { useLlm } from '../llm-context';
import type { ChatMessage, MsgSegment, ToolCallInfo, TodoItem } from '../types';
import DirBrowser from './DirBrowser';
import GlassSelect from './GlassSelect';
import ContextMeter from './ContextMeter';
import TodoPanel from './TodoPanel';
import SlashMenu, { rankSlashItems } from './SlashMenu';
import type { SlashItem } from './SlashMenu';
import type { GlassOption } from './GlassSelect';
import { useFeedback } from '../feedback';

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
// 思考块:整体默认折叠,头部显示 "思考 (N 字符)"
function ThinkingBlock({ text = '' }: { text?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="thinking" open={open}>
      <summary onClick={(e) => { e.preventDefault(); setOpen(!open); }}>
        <span className="muted">🧠 思考 ({text.length} 字符) {open ? '▾' : '▸'}</span>
      </summary>
      <div className="tf-body">{text.split('\n').map((l, i) => <div key={i} className="tf-line">{l}</div>)}</div>
    </details>
  );
}

// 提取 ```thinking …``` 块为折叠卡片,剩余文本交给 AssistantText 继续渲染;
// 当正文只由 thinking 块组成(纯推理回复)时,返回 null,仅显示思考卡片。
function renderAssistantContent(content = '') {
  const blocks: React.ReactElement[] = [];
  const rest = content.replace(/```thinking\s*([\s\S]*?)```/g, (_m, t) => {
    blocks.push(<ThinkingBlock key={blocks.length} text={t.trim()} />);
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

function ToolCard({ call }: { call: ToolCallInfo }) {
  const [open, setOpen] = useState(false);
  const icon = call.ok === undefined ? '🔧' : call.ok ? '✅' : '❌';
  return (
    <div className="toolcard">
      <div className="toolcard-head" onClick={() => setOpen(!open)} title={open ? '收起详情' : '展开参数/结果'}>
        <span>
          <span className="tc-arrow">{open ? '▾' : '▸'}</span>
          {icon} <b>{call.tool}</b>
          {call.ms != null && <span className="muted">{call.ms}ms</span>}
        </span>
        {!open && call.ok === undefined && <span className="muted">进行中</span>}
      </div>
      {open && (
        <>
          {call.args != null && <pre className="args">参数<br />{call.args || '{}'}</pre>}
          {call.result !== undefined && <pre className={`res ${call.ok ? '' : 'err'}`}>{call.result || (call.ok === undefined ? '…' : '(无输出)')}</pre>}
          {call.ok === undefined && !call.result && <pre className="res pending">执行中…</pre>}
        </>
      )}
    </div>
  );
}

// 连续的工具调用合并为一组折叠条(默认收起);展开后每张卡片独立折叠
function ToolRun({ tools = [] }: { tools?: ToolCallInfo[] }) {
  const [open, setOpen] = useState(false);
  const count = tools.length;
  if (!count) return null;
  const ok = tools.filter((t) => t.ok === true).length;
  const fail = tools.filter((t) => t.ok === false).length;
  const pending = tools.filter((t) => t.ok === undefined).length;
  const status = pending ? `(${ok + fail + pending} 次调用,进行中)` : fail ? `(${ok} 成功 / ${fail} 失败)` : `(全部 ${ok} 次成功)`;
  return (
    <div className="toolrun">
      <div className="toolrun-head" onClick={() => setOpen(!open)} title={open ? '收起这组工具调用' : '展开这组工具调用'}>
        <span className="tc-arrow">{open ? '▾' : '▸'}</span>
        <span>🔧 工具调用 × {count}</span>
        <span className="muted">{status}</span>
      </div>
      {open && <div className="toolrun-body">{tools.map((t, ti) => <ToolCard key={ti} call={t} />)}</div>}
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
        toolById.set(id, { tool: t.tool_name, args: t.tool_args, ok: t.ok ?? true, ms: t.ms, result: t.content || '' });
      }
      // 工具结果并入所在回复,该消息的分支点随之推进到这条 turn
      const last = out[out.length - 1];
      if (last) last.forkTail = ti;
      continue; // tool 消息本身不渲染,只作为结果并入上游工具组
    }
    if (t.role === 'user') { out.push({ role: 'user', content: t.content || '', forkTail: ti }); continue; }
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

interface ChatPanelProps {
  connected: boolean;
  workspace: string | null;
  busy: boolean;
  sessionSeq?: number;
  sid?: string | null;
  home?: string | null;
  savedWs?: string[];
  onWorkspaceSet: (ws: string) => void;
  /** 在新对话中分支:由 App 执行 session_fork 并刷新会话(at 为 turns 索引,-1 表示从尾部;缺省时隐藏分支按钮) */
  onFork?: (at: number) => void;
}

export default function ChatPanel({ connected, workspace, busy, sessionSeq = 0, sid = null, home = null, savedWs = [], onWorkspaceSet, onFork }: ChatPanelProps) {
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
  const userMsgRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [activeDot, setActiveDot] = useState(-1);
  // 悬停跳转点时的自定义内容提示(不用原生 title,支持两行截断省略)
  const [dotTip, setDotTip] = useState<{ top: number; left: number; text: string } | null>(null);
  const hasLive = useRef(false); // 用户已发起新对话时置 true,避免历史覆盖新消息
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
  useEffect(autoGrow, [input]);

  const push = (fn: (m: ChatMessage[]) => ChatMessage[]) => setMessages(fn);

  useEffect(() => {
    const subs = [
      api.on('history_cleared', () => setMessages([])),
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
                  if (target) Object.assign(target, { ok: m.ok, ms: m.ms, result: m.result });
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

  // 挂载或会话切换时,载入当前活跃会话的历史(失败静默回到空态)
  useEffect(() => {
    let alive = true;
    hasLive.current = false; // 切换会话:重置"已有新对话"标记,让新会话历史立即显示
    forkTurnRef.current = 0; lastIterRef.current = 0; // 分支点计数器随会话重置
    setMessages([]);
    setTodos([]);
    setAgentState('idle'); setIter(0); setErrorMsg('');
    api.request('get_history', {}, 8000)
      .then((r) => {
        if (!alive || hasLive.current) return;
        // 历史 turns 长度即该会话已累计的消息面 turn 数,作为后续流式递增的基准
        forkTurnRef.current = (r.turns || []).length;
        const msgs = turnsToMessages(r.turns || []);
        // 切回一个仍在运行中的会话:末条回复标记为流式中,继续接收后续增量事件
        if (busyRef.current) {
          const last = msgs[msgs.length - 1];
          if (last?.role === 'assistant') last.streaming = true;
        }
        setMessages(msgs);
        setTodos(Array.isArray(r.todos) ? r.todos : []); // 该会话当前的任务计划
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [sessionSeq]);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    updateActiveDot();
  }, [messages]);

  // 跳转点悬停提示:取不被裁剪的 fixed 定位,按当前点视口坐标弹出到右侧
  const showDotTip = (e: React.MouseEvent<HTMLButtonElement>, text: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setDotTip({ top: r.top + r.height / 2, left: r.right + 8, text });
  };
  const hideDotTip = () => setDotTip(null);

  const send = () => {
    const text = input.trim();
    // 工作中仍可发送:服务端会把消息转为 steer(补充指令注入下一步)
    if (!text || !connected || !workspace) return;
    setInput('');
    setMessages((m) => [...m]);
    api.send('speak', { text, reasoning });
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

  // 输入 / 唤醒菜单:仅当整行以 / 开头(最多一个空格前)时开启,对齐 harness 的 leadingInput 判定
  const syncSlash = (text: string) => {
    const m = /^\/([a-z0-9-]*)/i.exec(text);
    const trigger = m !== null && text.length <= (m[1]?.length || 0) + 1;
    if (trigger) {
      setSlashQuery(m![1] || '');
      setSlashOpen(true);
      if (slashActive < 0) setSlashActive(0);
      openSlash(); // 首次打开时拉取技能列表
    } else {
      setSlashOpen(false);
    }
  };
  const closeSlash = () => { setSlashOpen(false); setSlashActive(-1); };

  // 选中命令/技能:
  // - 技能:改写输入为 "/技能名 ",用户在后面继续输入需求再 Enter 发送(对齐 harness onPick 落字)
  // - 系统命令:直接执行(dispatch)
  const pickSlash = (item: SlashItem, query: string) => {
    if (item.kind === 'skill') {
      setInput(`/${item.name} `);
      setSlashOpen(false);
      setSlashActive(-1);
      requestAnimationFrame(() => { const el = taRef.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
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
  const wsbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wsMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wsbarRef.current && !wsbarRef.current.contains(e.target as Node)) setWsMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [wsMenuOpen]);

  const setWorkspace = async (p: string) => {
    try {
      await api.request('set_workspace', { path: p }, 20000);
      onWorkspaceSet(p); setWsBrowserOpen(false); setWsMenuOpen(false);
    } catch (e) { toast.error((e as Error).message); }
  };

  // 发送后等待回答 / agent 工作期间都应允许暂停:busy(服务端 status) 与 agentState 任一命中即视为工作中
  const working = busy || agentState === 'working';
  // 工作中也允许输入发送(自动作为运行中补充指令);仅未连接/未选工作区时禁用
  const canSend = connected && workspace;

  return (
    <div className="chatwrap">
      <div className="chat-head">
        <span className="muted">
          {working ? `Agent 工作中 · 迭代 #${iter}` : agentState === 'error' ? '出现错误' : agentState === 'done' ? '已完成' : '空闲'}
        </span>
        <span className="row gap">
          {working && <button className="ghost sm" onClick={stop}>⏹ 停止</button>}
          {messages.length > 0 && <button className="ghost sm" title="清空对话历史(含服务端持久化)" onClick={clearAll}>🗑 清空</button>}
        </span>
      </div>
      <div className="chat-scroll">
        <div className="chat" ref={scrollRef} onScroll={() => { updateActiveDot(); hideDotTip(); }}>
          {messages.length === 0 && (
            <div className="empty">
              <div>🤖 连接服务器、选择工作区后,即可让 Agent 在远程服务器上工作</div>
              <div className="muted">例如:「帮我看一下这个项目结构,然后修复 main.js 里的 bug」</div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`} ref={(el) => { userMsgRefs.current[i] = el; }}>
              {m.role === 'notice' && <div className="bubble notice-bubble">⚠ {m.content}</div>}
              {m.role === 'user' && <div className="bubble user-bubble">{m.content}</div>}
              {m.role === 'assistant' && (
                <div className="msg-col">
                  <div className="bubble ai-bubble">
                    {(m.segments || []).map((seg, si) => {
                      if (seg.kind === 'tools') return <ToolRun key={si} tools={seg.tools} />;
                      // 思考段:穿插在文本/工具组之间,折叠展示(对齐 dsh 的 ReasoningRow 逐块渲染)
                      if (seg.kind === 'reasoning') {
                        return (seg.text && seg.text.trim()) ? <ThinkingBlock key={si} text={seg.text.trim()} /> : null;
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
      <div className="composer">
        {/* 任务计划面板:输入框上方,默认折叠(照搬 deepseek-harness 的 TodoPanel 停靠位) */}
        <TodoPanel todos={todos} />
        <div className="composer-box">
          {/* / 命令菜单:输入以 / 开头时浮在输入框上方,前缀优先+模糊匹配过滤 */}
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
          <textarea ref={taRef} rows={1} value={input}
            onChange={(e) => { const v = e.target.value; setInput(v); syncSlash(v); }}
            placeholder={!connected ? '请先连接 SSH' : !workspace ? '请先选择远程工作区'
              : working ? 'Agent 工作中,输入内容将作为补充指令注入下一步…' : '输入 / 可唤起命令与技能菜单…'}
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
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              else if (e.key === 'Escape') setInput('');
            }} />
          <div className="composer-foot">
            <span className="muted composer-tip">Enter 发送 · Shift+Enter 换行</span>
            <ContextMeter messages={messages} input={input}
              contextWindow={llm.effModelContext?.contextWindow || 0} />
            {working
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
        {/* 工作区:单个可点击条目,点击弹出下拉(切换该服务器保存过的工作区 / 浏览选择新工作区) */}
        <div className="wsbar" ref={wsbarRef}>
          <button
            className={`ws-chip ${workspace ? '' : 'none'}`}
            disabled={!connected}
            title={workspace ? (connected ? '点击切换/选择工作区' : workspace) : (connected ? '点击选择工作区' : '未连接服务器')}
            onClick={() => setWsMenuOpen((v) => !v)}
          >
            <span className="ws-chip-path">{workspace ? `📂 ${workspace}` : '选择工作区'}</span>
            <span className="ws-chip-arrow">{wsMenuOpen ? '▾' : '▸'}</span>
          </button>
          {wsMenuOpen && (
            <div className="ws-pick" onClick={(e) => e.stopPropagation()}>
              {!connected ? (
                <div className="muted ws-pick-empty">未连接服务器</div>
              ) : (
                <>
                  {savedWs.length === 0 ? (
                    <div className="muted ws-pick-empty">还没有已保存的工作区</div>
                  ) : (
                    <div className="ws-pick-list">
                      {savedWs.map((p) => (
                        <button key={p} className={`ws-pick-item ${workspace === p ? 'on' : ''}`}
                          title={workspace === p ? '当前工作区' : `切换工作区到 ${p}`}
                          onClick={() => setWorkspace(p)}>
                          <span className="ws-pick-path">{p}</span>
                          {workspace === p && <span className="ws-pick-cur">✓</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="ctx-sep" />
                  <button className="ws-pick-item" onClick={() => { setWsMenuOpen(false); setWsBrowserOpen(true); }}>
                    📁 浏览选择其他目录…
                  </button>
                  {home && (
                    <button className="ws-pick-item" onClick={() => setWorkspace(home)} title={`设为家目录 ${home}`}>
                      🏠 家目录
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {wsBrowserOpen && (
        <DirBrowser initial={workspace || home || '/'} home={home} onClose={() => setWsBrowserOpen(false)} onPick={setWorkspace} />
      )}
    </div>
  );
}