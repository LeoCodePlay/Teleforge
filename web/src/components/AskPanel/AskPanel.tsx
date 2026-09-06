// 模型向用户提问面板(ask_user_question 工具):
// 收到 agent 事件 ask_user 后,在会话页输入框上方以内联玻璃卡片展示(无遮罩)。
// 支持单选/多选/"其它"自定义,多道提问可"上一道/下一道"或点头部进度段逐道作答,最后统一提交。
// 提问挂起期间通过 onPendingChange 通知父组件锁定输入框与停止按钮(未作答前不能继续输入/暂停);
// 取消/超时/停止 Agent 时自动关闭并恢复输入;页面刷新后挂载时经 ask_user_list
// 从服务端拉回全部挂起提问恢复面板(全部前端断开且 20s 宽限期内未回来才会真正作废)。
// 所有会话的提问都会入队(带 sid,
// 不按当前会话过滤),切走会话时面板随会话隐藏、切回仍可见;背景会话提出的
// 问题切回去也会重新展示,不会因事件被过滤而永久丢失。
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { AskAnswerItem, AskQuestion, AskRequest } from '../../types';
import './AskPanel.scss';

interface AskPanelProps {
  /** 当前会话 id:只显示属于该会话的提问(与 ChatPanel 的事件路由一致) */
  sid: string | null;
  /** 提问挂起状态变化(父组件据此禁用输入框与停止按钮) */
  onPendingChange?: (pending: boolean) => void;
  /** 启动检查期变化:刷新后拉取挂起提问期间为 true。父组件据此暂不渲染输入区,
   *  避免"输入框先出现、面板恢复后再整体替换"的一瞬间布局抖动 */
  onBootChange?: (checking: boolean) => void;
}

export default function AskPanel({ sid, onPendingChange, onBootChange }: AskPanelProps) {
  const [queue, setQueue] = useState<AskRequest[]>([]);
  const [qIndex, setQIndex] = useState(0);
  // 每题的选择:questionId -> 已选 option label;自定义文本:questionId -> 输入
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [customs, setCustoms] = useState<Record<string, string>>({});
  // 启动检查期:挂载后向服务端确认有无挂起提问,期间父组件先扣住输入区不渲染
  const [checking, setChecking] = useState(true);

  // 当前显示会话的 ref(订阅只挂一次,事件按此判断"是否插到当前会话的第一道题")
  const sidRef = useRef(sid);
  sidRef.current = sid;

  // 只取属于当前会话的提问;切走会话(旧会话仍有挂起提问)时面板隐藏,切回仍可见。
  // 检查期内要求 sid 已恢复且能对上号才显示(sid 刚刷新时还是 null,宽松匹配会让
  // 他席提问先闪现、sid 恢复后面板又消失,造成二次抖动);检查期结束回到宽松匹配
  const active: AskRequest | null = queue.find((x) => {
    if (checking) return sid != null && (!x.sid || x.sid === sid);
    return !sid || !x.sid || x.sid === sid;
  }) || null;
  const q: AskQuestion | null = active ? active.questions[qIndex] || null : null;
  const pending = !!active;

  // 挂起状态上抛:父组件据此禁用输入框/发送/停止按钮
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
  // 检查期状态上抛:父组件据此在检查完成前先不渲染输入区(防抖动)
  useEffect(() => { onBootChange?.(checking); }, [checking, onBootChange]);

  useEffect(() => {
    // 订阅不过滤会话:所有会话的 ask_user 事件都入队(带 sid)——
    // 否则切到别的会话时,原会话背景中提出的问题会被直接丢弃,
    // 切回来时服务端又不会重发,提问面板永久缺失(agent 干等,界面看不到选项)。
    // 是否显示由上方 active 按 sid 匹配,切回该会话即自动重新展示并锁定输入。
    const off = api.on('agent', (m: any) => {
      if (m.event === 'ask_user' && m.askId && Array.isArray(m.questions) && m.questions.length > 0) {
        setQueue((prev) => prev.some((x) => x.askId === m.askId) ? prev : [...prev, { askId: m.askId, questions: m.questions, sid: m.sid }]);
        // 只有当前正在看的会话来了新一批提问,才把作答指针重置到第一道;
        // 背景会话的提问只入队,不打扰正在显示的批次
        const cur = sidRef.current;
        if (!cur || !m.sid || m.sid === cur) setQIndex(0);
      } else if (m.event === 'ask_user_cancelled' && m.askId) {
        // 作答/取消/超时/停止统一走该事件:从队列移除对应批次
        setQueue((prev) => prev.filter((x) => x.askId !== m.askId));
      }
    });
    return () => { off(); };
  }, []);

  useEffect(() => {
    // 刷新/重连后恢复挂起提问:ask_user 事件只在提出时广播一次,刷新后组件重建、
    // 事件不会再来,而 agent 仍在阻塞等回答。挂载时向服务端拉一次全量挂起列表
    // (含所有会话,展示仍由上方 active 按 sid 过滤),切会话/切回的逻辑不受影响。
    let alive = true;
    // 兜底时限:WS 迟迟未连通/服务端过旧不识别 ask_user_list 时,输入区不被无限期扣住
    const cap = setTimeout(() => { if (alive) setChecking(false); }, 400);
    api.request('ask_user_list', {}).then((r: any) => {
      if (!alive || !Array.isArray(r?.asks)) return;
      setQueue((prev) => {
        const merged = [...prev];
        for (const a of r.asks) {
          if (!a?.askId || !Array.isArray(a.questions) || !a.questions.length) continue;
          if (merged.some((x) => x.askId === a.askId)) continue;
          merged.push({ askId: String(a.askId), questions: a.questions, sid: a.sid });
        }
        return merged;
      });
    }).catch(() => { /* 服务端暂不可用:下次事件仍会正常入队 */ }).finally(() => {
      clearTimeout(cap);
      if (alive) setChecking(false);
    });
    return () => { alive = false; clearTimeout(cap); };
  }, []);

  if (!active || !q) return null;

  const answered = (qn: AskQuestion) => {
    const sel = (selections[qn.id] || []).length > 0;
    const custom = (customs[qn.id] || '').trim().length > 0;
    return sel || custom;
  };

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
      {/* 头部:左侧身份(徽标+标题),右侧题目进度段(可点跳转)+ 关闭。
          原先挤在标题后的"第 x/y 题 · 已答 x/y"文字由进度段的颜色语义承担:
          绿=已答,冰蓝=当前题,灰=未答;单道提问时不渲染进度段,头部保持极简 */}
      <div className="ask-head">
        <div className="ask-id">
          <span className="ask-badge" aria-hidden>?</span>
          <span className="ask-title">AI 需要你确认</span>
        </div>
        <div className="ask-head-side">
          {total > 1 && (
            <div className="ask-steps" role="group" aria-label="题目进度,点击跳转">
              {active.questions.map((qn, i) => (
                /* 进度段不用 <button>:全局按钮样式的投影/hover 会一层层渗进来,
                   div + cursor:pointer 一劳永逸;键盘可达性用 role + 回车/空格补齐 */
                <div
                  key={qn.id}
                  role="button"
                  tabIndex={0}
                  className={`ask-step ${i === qIndex ? 'cur' : ''} ${answered(qn) ? 'done' : ''}`}
                  aria-label={`第 ${i + 1} 题,${answered(qn) ? '已作答' : '未作答'}`}
                  aria-current={i === qIndex ? 'step' : undefined}
                  title={`第 ${i + 1} 题 · ${answered(qn) ? '已作答' : '未作答'}`}
                  onClick={() => setQIndex(i)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setQIndex(i); } }}
                />
              ))}
            </div>
          )}
          <button className="ghost sm ask-close" onClick={cancel} aria-label="取消提问">✕</button>
        </div>
      </div>

      <div className="ask-body" key={q.id}>
        {q.header && <div className="ask-header">{q.header}</div>}
        <div className="ask-question">{q.question}</div>

        {q.options && q.options.length > 0 && (
          <div
            className={`ask-opts ${q.multi_select ? 'multi' : ''}`}
            role={q.multi_select ? 'group' : undefined}
            aria-label={q.multi_select ? '多选' : '单选'}
          >
            {q.options.map((opt, i) => {
              const on = (selections[q.id] || []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={`ask-opt ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  style={{ '--i': i } as React.CSSProperties}
                  onClick={() => toggleOption(opt.label)}
                >
                  {/* 选中标记为内联 SVG 图标:单选=同心圆环靶标(外环+中心实心圆),
                      多选=圆角方框+圆头对勾;形状描边在 SCSS 中按选中态着色 */}
                  <span className="ask-opt-mark" aria-hidden>
                    {q.multi_select ? (
                      <svg viewBox="0 0 16 16">
                        <rect className="ask-mark-box" x="1.25" y="1.25" width="13.5" height="13.5" rx="4" />
                        <path className="ask-mark-check" d="M4.6 8.6 7 11 11.6 5.6" pathLength="12" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16">
                        <circle className="ask-mark-ring" cx="8" cy="8" r="6.75" />
                        <circle className="ask-mark-core" cx="8" cy="8" r="3.4" />
                      </svg>
                    )}
                  </span>
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

        <label className="ask-custom-wrap">
          <span className="ask-custom-icon" aria-hidden>✎</span>
          <input
            className="ask-custom"
            type="text"
            value={customs[q.id] || ''}
            placeholder={q.options?.length ? '其它(自定义回答,可不填)…' : '在这里输入你的回答…'}
            autoFocus={!q.options?.length}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); goNext(); } }}
          />
        </label>
      </div>

      {/* 底部只保留动作:取消在左,翻题/提交在右;进度展示已上移到头部进度段 */}
      <div className="ask-foot">
        <button className="ghost sm ask-cancel" onClick={cancel}>取消提问</button>
        <div className="ask-nav">
          {total > 1 && (
            <button className="ghost sm" disabled={isFirst} onClick={() => setQIndex(qIndex - 1)}>‹ 上一道</button>
          )}
          <button className={isLast ? 'primary sm' : 'ghost sm'} onClick={goNext}>
            {isLast ? '提交 ✓' : '下一道 ›'}
          </button>
        </div>
      </div>
    </div>
  );
}
