import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// ---------------- 轻量 markdown 渲染(转义后安全输出) ----------------
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderMarkdown(text = '') {
  const html = escapeHtml(text)
    .replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${code}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>');
  return html;
}

function AssistantText({ text }) {
  const spans = [];
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

function ToolCard({ call }) {
  const [open, setOpen] = useState(false);
  const icon = call.ok === undefined ? '🔧' : call.ok ? '✅' : '❌';
  return (
    <div className="toolcard">
      <div className="toolcard-head" onClick={() => setOpen(!open)}>
        <span>{icon} <b>{call.tool}</b></span>
        <span className="muted">{call.ms != null ? `${call.ms}ms` : ''}</span>
      </div>
      <details style={{ display: open ? 'block' : 'none' }}>
        <pre className="args">参数<br/>{call.args || '{}'}</pre>
        {call.result !== undefined && <pre className={`res ${call.ok ? '' : 'err'}`}>{call.result}</pre>}
      </details>
    </div>
  );
}

export default function ChatPanel({ connected, workspace, busy }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [agentState, setAgentState] = useState('idle'); // idle | working | done | error
  const [iter, setIter] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const scrollRef = useRef(null);

  const push = (fn) => setMessages((m) => fn(m));

  useEffect(() => {
    const subs = [
      api.on('agent', (m) => {
        switch (m.event) {
          case 'start':
            setAgentState('working'); setIter(0); setErrorMsg('');
            push((msgs) => [...msgs, { role: 'user', content: m.text }]);
            push((msgs) => [...msgs, { role: 'assistant', content: '', tools: [], streaming: true }]);
            break;
          case 'iteration':
            setIter(m.iter);
            break;
          case 'text_delta':
            push((msgs) => {
              const copy = [...msgs];
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') last.content += m.text;
              return copy;
            });
            break;
          case 'tool_call':
            push((msgs) => {
              const copy = [...msgs];
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') last.tools = [...last.tools, { tool: m.tool, args: m.args, ok: undefined, ms: undefined, result: undefined }];
              return copy;
            });
            break;
          case 'tool_result':
            push((msgs) => {
              const copy = [...msgs];
              const last = copy[copy.length - 1];
              const idx = (last.tools || []).findIndex((t) => t.tool === m.tool && t.ok === undefined);
              if (idx >= 0) last.tools[idx] = { ...last.tools[idx], ok: m.ok, ms: m.ms, result: m.result };
              return copy;
            });
            break;
          case 'done':
            setAgentState('done');
            push((msgs) => {
              const copy = [...msgs];
              const last = copy[copy.length - 1];
              if (last?.role === 'assistant') { last.streaming = false; last.content += m.text; }
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
        }
      })
    ];
    return () => subs.forEach((off) => off());
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const text = input.trim();
    if (!text || !connected || !workspace || busy) return;
    setInput('');
    setMessages((m) => [...m]);
    api.send('speak', { text });
  };

  const stop = () => api.send('stop_agent', {});

  const canSend = connected && workspace && !busy;

  return (
    <div className="chatwrap">
      <div className="chat-head">
        <span className="muted">
          {busy ? `Agent 工作中 · 迭代 #${iter}` : agentState === 'error' ? '出现错误' : agentState === 'done' ? '已完成' : '空闲'}
        </span>
        {busy && <button className="ghost sm" onClick={stop}>⏹ 停止</button>}
      </div>
      <div className="chat" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty">
            <div>🤖 连接服务器、选择工作区后,即可让 Agent 在远程服务器上工作</div>
            <div className="muted">例如:「帮我看一下这个项目结构,然后修复 main.js 里的 bug」</div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'user' && <div className="bubble user-bubble">{m.content}</div>}
            {m.role === 'assistant' && (
              <div className="bubble ai-bubble">
                {m.content ? <AssistantText text={m.content} /> : null}
                <div className="toolrun">
                  {(m.tools || []).map((t, ti) => <ToolCard key={ti} call={t} />)}
                </div>
                {m.streaming && !m.content && (m.tools || []).length === 0 && <span className="cursor">▍</span>}
              </div>
            )}
          </div>
        ))}
      </div>
      {errorMsg && <div className="error">{errorMsg}</div>}
      <div className="composer">
        <textarea value={input} onChange={(e) => setInput(e.target.value)}
          placeholder={!connected ? '请先连接 SSH' : !workspace ? '请先选择远程工作区' : '输入指令,Enter 发送,Shift+Enter 换行'}
          disabled={!canSend}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }} rows={2} />
        <button className="primary" disabled={!canSend || !input.trim()} onClick={send}>发送</button>
      </div>
    </div>
  );
}