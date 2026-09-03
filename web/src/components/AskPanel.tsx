// 模型向用户提问面板(ask_user_question 工具):
// 收到本会话的 agent 事件 ask_user 后,在会话页输入框上方以内联玻璃卡片展示(无遮罩)。
// 支持单选/多选/"其它"自定义,多道提问可"上一道/下一道"逐道作答,最后统一提交。
// 提问挂起期间通过 onPendingChange 通知父组件锁定输入框与停止按钮(未作答前不能继续输入/暂停);
// 取消/超时/停止 Agent 时自动关闭并恢复输入。切走会话时面板随会话隐藏,切回仍可见。
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { AskAnswerItem, AskQuestion, AskRequest } from '../types';

interface AskPanelProps {
  /** 当前会话 id:只显示属于该会话的提问(与 ChatPanel 的事件路由一致) */
  sid: string | null;
  /** 提问挂起状态变化(父组件据此禁用输入框与停止按钮) */
  onPendingChange?: (pending: boolean) => void;
}

export default function AskPanel({ sid, onPendingChange }: AskPanelProps) {
  const [queue, setQueue] = useState<AskRequest[]>([]);
  const [qIndex, setQIndex] = useState(0);
  // 每题的选择:questionId -> 已选 option label;自定义文本:questionId -> 输入
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [customs, setCustoms] = useState<Record<string, string>>({});

  // 只取属于当前会话的提问;切走会话(旧会话仍有挂起提问)时面板隐藏,切回仍可见
  const active: AskRequest | null = queue.find((x) => !sid || !x.sid || x.sid === sid) || null;
  const q: AskQuestion | null = active ? active.questions[qIndex] || null : null;
  const pending = !!active;

  // 挂起状态上抛:父组件据此禁用输入框/发送/停止按钮
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);

  useEffect(() => {
    const off = api.on('agent', (m: any) => {
      if (m.sid && sid && m.sid !== sid) return; // 非本会话的提问不处理
      if (m.event === 'ask_user' && m.askId && Array.isArray(m.questions) && m.questions.length > 0) {
        setQueue((prev) => prev.some((x) => x.askId === m.askId) ? prev : [...prev, { askId: m.askId, questions: m.questions, sid: m.sid }]);
        setQIndex(0); // 新一批提问从第一道开始
      } else if (m.event === 'ask_user_cancelled' && m.askId) {
        setQueue((prev) => prev.filter((x) => x.askId !== m.askId));
      }
    });
    return () => { off(); };
  }, [sid]);

  if (!active || !q) return null;

  const answered = (qn: AskQuestion) => {
    const sel = (selections[qn.id] || []).length > 0;
    const custom = (customs[qn.id] || '').trim().length > 0;
    return sel || custom;
  };
  const answeredCount = active.questions.filter(answered).length;

  const toggleOption = (label: string) => {
    const cur = selections[q.id] || [];
    if (q.multi_select) {
      setSelections({ ...selections, [q.id]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] });
    } else {
      setSelections({ ...selections, [q.id]: cur.includes(label) ? [] : [label] });
    }
  };

  const setCustom = (v: string) => setCustoms({ ...customs, [q.id]: v });

  const submit = () => {
    const firstUnanswered = active.questions.findIndex((qn) => !answered(qn));
    if (firstUnanswered >= 0) { setQIndex(firstUnanswered); return; }
    const answers: AskAnswerItem[] = active.questions.map((qn) => {
      const item: AskAnswerItem = { id: qn.id, selected: selections[qn.id] || [] };
      const custom = (customs[qn.id] || '').trim();
      if (custom) item.custom = custom;
      return item;
    });
    api.send('ask_user_answer', { askId: active.askId, answers });
    setQueue((prev) => prev.filter((x) => x.askId !== active.askId));
  };

  const cancel = () => {
    api.send('ask_user_cancel', { askId: active.askId });
    setQueue((prev) => prev.filter((x) => x.askId !== active.askId));
  };

  const goNext = () => {
    if (qIndex < active.questions.length - 1) setQIndex(qIndex + 1);
    else submit();
  };

  const total = active.questions.length;
  const isFirst = qIndex === 0;
  const isLast = qIndex === total - 1;

  return (
    <div className="ask-panel" role="dialog" aria-modal="false" aria-label="AI 需要你确认">
      <div className="ask-head">
        <span>
          <span className="ask-badge">❓</span> AI 需要你确认
          <span className="ask-head-meta">
            {total > 1 ? ` · 第 ${qIndex + 1}/${total} 题` : ''} · 已答 {answeredCount}/{total}
          </span>
        </span>
        <button className="ghost sm" onClick={cancel}>✕</button>
      </div>

      <div className="ask-body" key={q.id}>
        {q.header && <div className="ask-header">{q.header}</div>}
        <div className="ask-question">{q.question}</div>

        {q.options && q.options.length > 0 && (
          <div className="ask-opts" role={q.multi_select ? 'group' : undefined} aria-label={q.multi_select ? '多选' : '单选'}>
            {q.options.map((opt) => {
              const on = (selections[q.id] || []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={`ask-opt ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggleOption(opt.label)}
                >
                  <span className="ask-opt-mark">{q.multi_select ? (on ? '☑' : '☐') : (on ? '◉' : '○')}</span>
                  <span className="ask-opt-main">
                    <span className="ask-opt-label">{opt.label}</span>
                    {opt.description && <span className="ask-opt-desc">{opt.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {(!q.options || q.options.length === 0) && (
          <div className="hint ask-noopts">可直接在下方填写回答</div>
        )}

        <input
          className="ask-custom"
          type="text"
          value={customs[q.id] || ''}
          placeholder={q.options?.length ? '其它(自定义回答,可不填)…' : '在这里输入你的回答…'}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); goNext(); } }}
        />
      </div>

      <div className="ask-foot">
        <button className="ghost sm" onClick={cancel}>取消提问</button>
        <div className="ask-nav">
          <button className="ghost sm" disabled={isFirst} onClick={() => setQIndex(qIndex - 1)}>‹ 上一道</button>
          <div className="ask-dots" aria-hidden>
            {active.questions.map((qn, i) => (
              <span key={qn.id} className={`ask-dot ${i === qIndex ? 'cur' : ''} ${answered(qn) ? 'done' : ''}`} data-tip={answered(qn) ? '已作答' : '未作答'} />
            ))}
          </div>
          <button
            className={isLast ? 'primary sm' : 'ghost sm'}
            onClick={goNext}
          >
            {isLast ? '提交 ✓' : '下一道 ›'}
          </button>
        </div>
      </div>
    </div>
  );
}