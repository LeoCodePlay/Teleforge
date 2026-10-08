// 模型向用户提问面板(ask_user_question 工具):
// 收到 agent 事件 ask_user 后,在会话页输入框上方以内联卡片展示(无遮罩)。
// 布局对齐 harness 的提问面板(ui-user-questions/QuestionComposer):题目正文直接做卡片标题,
// 选项是整行可点的编号行(单选=序号 / 多选=勾选框),自定义回答是与选项同形的输入行,
// 顶部一条按题切片的进度轨(绿=已答 / 强调色=当前 / 灰=未答,可点跳题),底部只放翻题与提交。
// 单选点选项即作答并自动进入下一题;最后一题作答完、且所有题目都已作答时才自动提交。
// 提问挂起期间通过 onPendingChange 通知父组件锁定输入框与停止按钮(未作答前不能继续输入/暂停);
// 取消/超时/停止 Agent 时自动关闭并恢复输入;页面刷新后挂载时经 ask_user_list
// 从服务端拉回全部挂起提问恢复面板(全部前端断开且 20s 宽限期内未回来才会真正作废)。
// 所有会话的提问都会入队(带 sid,
// 不按当前会话过滤),切走会话时面板随会话隐藏、切回仍可见;背景会话提出的
// 问题切回去也会重新展示,不会因事件被过滤而永久丢失。
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { AskAnswerItem, AskQuestion, AskRequest } from '../../types';
import { IconArrowLeft16, IconArrowRight16, IconCheck16, IconClose16, IconPencil16 } from '../icons/icons';
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

/** 一道题的作答草稿 */
interface AskDraft {
  selected: string[];
  custom: string;
}

/** 未作答的空草稿共享同一个常量,避免每次读取都新建对象 */
const NO_DRAFTS: Record<number, AskDraft> = {};

/** 自动跳题后的冷却窗口:挡住同一次连点 / 重复回车落到下一题同一位置的选项上 */
const ADVANCE_COOLDOWN_MS = 260;

/**
 * 拆出选项 label 末尾的「(推荐)/(recommended)」后缀做角标展示。
 * 回传给模型的答案仍是**原始 label**,展示与取值不共用同一个字符串。
 */
function splitRecommended(label: string): { text: string; recommended: boolean } {
  const suffix = /\s*[（(](?:推荐|recommended)[)）]\s*$/i;
  return suffix.test(label)
    ? { text: label.replace(suffix, ''), recommended: true }
    : { text: label, recommended: false };
}

export default function AskPanel({ sid, onPendingChange, onBootChange }: AskPanelProps) {
  const [queue, setQueue] = useState<AskRequest[]>([]);
  const [qIndex, setQIndex] = useState(0);
  // 作答草稿按「题目下标」存,不按模型给的题目 id 存:服务端对 id 只做 String(q.id || 随机),
  // 模型给多道题重复 id(或给了同一个语义 id)时不会报错,前端若按 id 归档答案,
  // 第 1 题的选择就会串进第 2 题 —— 表现为"选完自己跳到第二题、第一题像没选过"。
  // 草稿连 askId 一起存:换批次时旧草稿整体失效,不会有一帧读到上一批的答案。
  const [drafts, setDrafts] = useState<{ askId: string; map: Record<number, AskDraft> }>({ askId: '', map: {} });
  const [hint, setHint] = useState<string | null>(null);
  // 启动检查期:挂载后向服务端确认有无挂起提问,期间父组件先扣住输入区不渲染
  const [checking, setChecking] = useState(true);

  // 当前显示会话的 ref(订阅只挂一次,事件按此判断"是否插到当前会话的第一道题")
  const sidRef = useRef(sid);
  sidRef.current = sid;
  const bodyRef = useRef<HTMLDivElement>(null);
  // 跳题后把焦点移出选项行:键盘回车/空格重复触发时不会二次命中新一题同一位置的按钮
  const wantFocusRef = useRef(false);
  const advanceUntilRef = useRef(0);

  // 只取属于当前会话的提问;切走会话(旧会话仍有挂起提问)时面板隐藏,切回仍可见。
  // 检查期内要求 sid 已恢复且能对上号才显示(sid 刚刷新时还是 null,宽松匹配会让
  // 他席提问先闪现、sid 恢复后面板又消失,造成二次抖动);检查期结束回到宽松匹配
  const active: AskRequest | null = queue.find((x) => {
    if (checking) return sid != null && (!x.sid || x.sid === sid);
    return !sid || !x.sid || x.sid === sid;
  }) || null;
  // 当前挂起批次一变(切会话、或换成另一批提问)就把作答指针归零。
  // 旧逻辑只在"当前会话来了新 ask_user 事件"时归零,背景会话的提问不归零:
  // 若上一批停在第二/第三题,切走再切回(或切回一个题数更少的背景提问),
  // 就会沿用越界下标 —— active 存在却取不到题,面板渲染 null,
  // 而父组件仍按 pending 锁死输入区,表现为"卡在提问、没有面板、也没有输入框"。
  const activeAskId = active ? active.askId : null;
  useLayoutEffect(() => {
    setQIndex(0);
    setHint(null);
    advanceUntilRef.current = 0;
  }, [activeAskId]);
  // 夹取下标兜底:批次切换与上面 effect 之间可能隔一帧,保证有挂起提问就一定取得到题
  const idx = active ? Math.min(Math.max(qIndex, 0), active.questions.length - 1) : 0;
  const q: AskQuestion | null = active ? active.questions[idx] || null : null;
  // 只有面板真能渲染出来才锁定输入区:否则会陷入"输入被锁死、面板却是空的"死局
  const pending = !!active && !!q;

  // 挂起状态上抛:父组件据此禁用输入框/发送/停止按钮
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
  // 检查期状态上抛:父组件据此在检查完成前先不渲染输入区(防抖动)
  useEffect(() => { onBootChange?.(checking); }, [checking, onBootChange]);

  // 跳题后把焦点交给新一题:有选项交给正文容器(焦点不落在某一行上,
  // 键盘继续输入/回车都不会误触上一题同一位置的按钮);没选项直接给输入框,跳过去就能打字
  useEffect(() => {
    if (!wantFocusRef.current) return;
    wantFocusRef.current = false;
    const body = bodyRef.current;
    if (!body) return;
    const target = body.querySelector('.ask-opt') ? body : body.querySelector<HTMLElement>('.ask-custom');
    target?.focus({ preventScroll: true });
  }, [idx, activeAskId]);

  useEffect(() => {
    // 订阅不过滤会话:所有会话的 ask_user 事件都入队(带 sid)——
    // 否则切到别的会话时,原会话背景中提出的问题会被直接丢弃,
    // 切回来时服务端又不会重发,提问面板永久缺失(agent 干等,界面看不到选项)。
    // 是否显示由上方 active 按 sid 匹配,切回该会话即自动重新展示并锁定输入。
    const off = api.on('agent', (m: any) => {
      if (m.event === 'ask_user' && m.askId && Array.isArray(m.questions) && m.questions.length > 0) {
        setQueue((prev) => {
          // 只有真的是新批次才把作答指针拨回第一道:同一 askId 的重复投递
          // (重连重放 / 多路径广播)不能把用户正在答的题悄悄拨回第一题
          if (prev.some((x) => x.askId === m.askId)) return prev;
          const cur = sidRef.current;
          if (!cur || !m.sid || m.sid === cur) { setQIndex(0); setHint(null); }
          return [...prev, { askId: m.askId, questions: m.questions, sid: m.sid }];
        });
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

  const total = active.questions.length;
  const draftMap = drafts.askId === activeAskId ? drafts.map : NO_DRAFTS;
  const draftAt = (i: number): AskDraft => draftMap[i] || { selected: [], custom: '' };
  const answeredIn = (map: Record<number, AskDraft>, i: number): boolean => {
    const d = map[i];
    return !!d && (d.selected.length > 0 || d.custom.trim().length > 0);
  };
  const answered = (i: number) => answeredIn(draftMap, i);
  const writeDraft = (i: number, next: AskDraft) => {
    setDrafts((prev) => ({
      askId: activeAskId || '',
      map: { ...(prev.askId === activeAskId ? prev.map : {}), [i]: next },
    }));
    setHint(null);
  };

  const submit = (map: Record<number, AskDraft> = draftMap) => {
    const firstUnanswered = active.questions.findIndex((_, i) => !answeredIn(map, i));
    if (firstUnanswered >= 0) {
      wantFocusRef.current = true;
      setQIndex(firstUnanswered);
      setHint('还有题目未作答,已跳到那一题');
      return;
    }
    const answers: AskAnswerItem[] = active.questions.map((qn, i) => {
      const item: AskAnswerItem = { id: qn.id, selected: map[i]?.selected || [] };
      const custom = (map[i]?.custom || '').trim();
      if (custom) item.custom = custom;
      return item;
    });
    api.send('ask_user_answer', { askId: active.askId, answers });
    setQueue((prev) => prev.filter((x) => x.askId !== active.askId));
  };

  /** 选一个候选选项:多选是勾/取消勾;单选即作答,并自动进入下一题 */
  const choose = (label: string) => {
    if (Date.now() < advanceUntilRef.current) return;
    const cur = draftAt(idx);
    if (q.multi_select) {
      const selected = cur.selected.includes(label)
        ? cur.selected.filter((l) => l !== label)
        : [...cur.selected, label];
      writeDraft(idx, { selected, custom: cur.custom });
      return;
    }
    // 单选语义下选项与自定义文本互斥(选选项清空自定义,输入自定义清空选项),
    // 免得回传的答案里两者同时存在、模型不知道该听哪个
    const next: AskDraft = { selected: [label], custom: '' };
    writeDraft(idx, next);
    const merged = { ...draftMap, [idx]: next };
    if (idx < total - 1) {
      advanceUntilRef.current = Date.now() + ADVANCE_COOLDOWN_MS;
      wantFocusRef.current = true;
      setQIndex(idx + 1);
      return;
    }
    // 最后一题:所有题目都已作答才自动提交,否则留在原地等用户补
    if (active.questions.every((_, i) => answeredIn(merged, i))) submit(merged);
  };

  const setCustom = (v: string) => {
    const cur = draftAt(idx);
    writeDraft(idx, { selected: q.multi_select ? cur.selected : [], custom: v });
  };

  const cancel = () => {
    api.send('ask_user_cancel', { askId: active.askId });
    setQueue((prev) => prev.filter((x) => x.askId !== active.askId));
  };

  const goPrev = () => {
    setHint(null);
    wantFocusRef.current = true;
    setQIndex(Math.max(0, idx - 1));
  };

  const goNext = () => {
    // 本题没作答就不许越过:否则一路"下一道"会把前面的题悄悄跳过
    if (!answered(idx)) {
      setHint(q.options?.length ? '先选一项,或填写自定义回答' : '先填写回答');
      return;
    }
    setHint(null);
    if (idx < total - 1) {
      wantFocusRef.current = true;
      setQIndex(idx + 1);
      return;
    }
    submit();
  };

  const isFirst = idx === 0;
  const isLast = idx === total - 1;

  return (
    <div className="ask-panel" role="dialog" aria-modal="false" aria-labelledby={`ask-title-${active.askId}-${idx}`}>
      {/* 顶部进度轨:多题时按题切片(绿=已答 / 强调色=当前 / 灰=未答),点击跳题;
          单题时是一条整条强调色,表示"当前只有这一问" */}
      <div
        className={`ask-rail${total > 1 ? ' split' : ''}`}
        role={total > 1 ? 'group' : undefined}
        aria-label={total > 1 ? '题目进度,点击跳转' : undefined}
      >
        {total > 1
          ? active.questions.map((qn, i) => (
              <div
                key={i}
                role="button"
                tabIndex={0}
                className={`ask-seg${answered(i) ? ' done' : ''}${i === idx ? ' cur' : ''}`}
                aria-label={`第 ${i + 1} 题,${answered(i) ? '已作答' : '未作答'}`}
                aria-current={i === idx ? 'step' : undefined}
                data-tip={`第 ${i + 1} 题 · ${answered(i) ? '已作答' : '未作答'}`}
                onClick={() => { setHint(null); setQIndex(i); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHint(null); setQIndex(i); } }}
              />
            ))
          : <div className="ask-seg cur" />}
      </div>

      {/* 头部:题面即标题(可选分类小标签在标题上方),右上角关闭 */}
      <div className="ask-head">
        <div className="ask-heading">
          {q.header && <div className="ask-eyebrow">{q.header}</div>}
          <h2 className="ask-title" id={`ask-title-${active.askId}-${idx}`}>{q.question}</h2>
        </div>
        <button className="ghost ask-close" onClick={cancel} aria-label="取消提问" title="取消提问">
          <IconClose16 size={14} />
        </button>
      </div>

      <div className="ask-body" key={`${active.askId}:${idx}`} ref={bodyRef} tabIndex={-1}>
        {/* 长正文(如计划模式 exit_plan_mode 送审的完整计划):等宽正文 + 独立滚动,
            不让长计划把选项按钮挤到屏幕外(harness 的计划审阅同款呈现) */}
        {q.detail && <pre className="ask-detail" tabIndex={0}>{q.detail}</pre>}

        <div
          className={`ask-opts${q.multi_select ? ' multi' : ''}`}
          role={q.options?.length ? (q.multi_select ? 'group' : 'radiogroup') : undefined}
          aria-label={q.options?.length ? (q.multi_select ? '多选' : '单选') : undefined}
        >
          {(q.options || []).map((opt, i) => {
            const on = draftAt(idx).selected.includes(opt.label);
            const display = splitRecommended(opt.label);
            return (
              <button
                key={i}
                type="button"
                className={`ask-opt${on ? ' on' : ''}`}
                role={q.multi_select ? 'checkbox' : 'radio'}
                aria-checked={on}
                aria-label={display.recommended ? `${display.text}(推荐)` : display.text}
                style={{ '--i': i } as React.CSSProperties}
                onClick={() => choose(opt.label)}
              >
                {/* 前导标记:单选=序号,多选=圆角方框 + 圆头对勾(形状在 SCSS 中按选中态着色) */}
                <span className={`ask-mark${q.multi_select ? ' box' : ''}`} aria-hidden>
                  {q.multi_select ? (
                    <svg viewBox="0 0 16 16">
                      <rect className="ask-mark-box" x="1.25" y="1.25" width="13.5" height="13.5" rx="4" />
                      <path className="ask-mark-check" d="M4.6 8.6 7 11 11.6 5.6" pathLength="12" />
                    </svg>
                  ) : i + 1}
                </span>
                <span className="ask-opt-main">
                  <span className="ask-opt-label">{display.text}</span>
                  {display.recommended && <span className="ask-badge">推荐</span>}
                  {opt.description && <span className="ask-opt-desc">{opt.description}</span>}
                </span>
              </button>
            );
          })}

          {/* 自定义回答:有选项时是与选项同形的输入行(前导标记换成铅笔/勾选框),
              没有选项时它本身就是要填的正文框 */}
          {q.options?.length ? (
            <label className={`ask-custom-row${(draftAt(idx).custom || '').trim() ? ' filled' : ''}`}>
              <span className={`ask-mark${q.multi_select ? ' box' : ''}`} aria-hidden>
                {q.multi_select
                  ? <svg viewBox="0 0 16 16">
                      <rect className="ask-mark-box" x="1.25" y="1.25" width="13.5" height="13.5" rx="4" />
                      <path className="ask-mark-check" d="M4.6 8.6 7 11 11.6 5.6" pathLength="12" />
                    </svg>
                  : <IconPencil16 size={13} />}
              </span>
              <input
                className="ask-custom"
                type="text"
                value={draftAt(idx).custom}
                placeholder="其它(自定义回答,可不填)…"
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); goNext(); } }}
              />
            </label>
          ) : (
            <label className="ask-custom-block">
              <input
                className="ask-custom"
                type="text"
                value={draftAt(idx).custom}
                placeholder="在这里输入你的回答…"
                autoFocus
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); goNext(); } }}
              />
            </label>
          )}
        </div>
      </div>

      {/* 底部:取消在左,校验提示居中,翻题/提交在右 */}
      <div className="ask-foot">
        <button className="ghost sm ask-cancel" onClick={cancel}>取消提问</button>
        <div className="ask-hint" role="status">{hint}</div>
        <div className="ask-nav">
          {total > 1 && (
            <button className="ghost sm icon-btn" disabled={isFirst} onClick={goPrev}>
              <IconArrowLeft16 size={13} />上一道
            </button>
          )}
          <button className={`${isLast ? 'primary' : 'ghost'} sm icon-btn`} onClick={goNext}>
            {isLast ? '提交' : '下一道'}{isLast ? <IconCheck16 size={13} /> : <IconArrowRight16 size={13} />}
          </button>
        </div>
      </div>
    </div>
  );
}
