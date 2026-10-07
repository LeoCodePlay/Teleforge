// 目标条(移植自 deepseek-harness client/ui-goal 的 GoalBar):
// 停靠在输入卡上方的目标指示条 —— 目标图标 + 阶段标签 + 目标正文 + 图标动作
// (暂停/恢复/编辑/清除)。目标创建只走 /目标 命令,不在这里;已完成的目标不渲染。
// 阶段语义与 harness 的 zh 词条一致:进行中的目标 / 已暂停的目标 / 受阻的目标。
import React, { useEffect, useRef, useState } from 'react';
import type { GoalInfo } from '../../types';
import './GoalBar.scss';

/** 目标图标(旗标):与 harness IconGoalOutlineRegular 同形的极简轮廓 */
function GoalGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.6 14V2.4h7.2l-1.2 2.6 1.2 2.6H3.6" stroke="currentColor" strokeWidth="1.3"
        strokeLinejoin="round" strokeLinecap="round" />
      <circle cx="3.6" cy="2.4" r="1" fill="currentColor" />
    </svg>
  );
}

/** 阶段标签:active 还要看进程内授权(未激活 = 不会自动续跑) */
function phaseLabel(goal: GoalInfo): string {
  switch (goal.phase) {
    case 'active': return goal.activation === 'armed' ? '进行中的目标' : '未激活的目标';
    case 'paused': return '已暂停的目标';
    case 'blocked': return '受阻的目标';
    default: return '已完成的目标';
  }
}

export interface GoalBarProps {
  goal: GoalInfo | null | undefined;
  /** 动作回调:走服务端的 /目标 子命令(edit 传新目标描述) */
  onEdit: (objective: string) => void | Promise<void>;
  onPause: () => void | Promise<void>;
  onResume: () => void | Promise<void>;
  onClear: () => void | Promise<void>;
  /** 动作进行中(禁用按钮,避免重复提交) */
  pending?: boolean;
}

export default function GoalBar({ goal, onEdit, onPause, onResume, onClear, pending = false }: GoalBarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 目标身份变化(被清除/替换/完成)时作废本地编辑态:
  // 否则残留草稿的回车会写到**新**目标上(harness GoalBar 的同一防护)
  const goalId = goal?.id;
  useEffect(() => { setEditing(false); }, [goalId]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  // 加载中 / 无目标 / 已完成:目标条不出现(harness 同款)
  if (goal === undefined || goal === null || goal.phase === 'complete') return null;

  const showResume = goal.phase === 'paused' || (goal.phase === 'active' && goal.activation === 'disarmed');
  const title = goal.phase === 'blocked' && goal.blockedReason
    ? `受阻:${goal.blockedReason.code} — ${goal.blockedReason.message}`
    : `目标第 ${goal.roundsStarted}/${goal.maxGoalRounds} 轮`;

  const submitEdit = () => {
    const v = draft.trim();
    if (!v || pending) return;
    Promise.resolve(onEdit(v)).then(() => setEditing(false)).catch(() => {});
  };

  return (
    <div className="goal-bar" data-phase={goal.phase}>
      <span className="goal-glyph"><GoalGlyph /></span>
      <span className="goal-phase">{phaseLabel(goal)}</span>
      {editing ? (
        <span className="goal-edit">
          <input
            ref={inputRef}
            className="goal-edit-input"
            value={draft}
            aria-label="目标内容"
            placeholder="新的目标描述"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submitEdit(); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }}
          />
          <button type="button" className="goal-icon-btn" title="保存目标" disabled={pending || !draft.trim()}
            onClick={submitEdit}>✓</button>
          <button type="button" className="goal-icon-btn" title="取消编辑" disabled={pending}
            onClick={() => setEditing(false)}>✕</button>
        </span>
      ) : (
        <>
          <span className="goal-objective" title={title}>{goal.objective}</span>
          <span className="goal-rounds" title={title}>{goal.roundsStarted}/{goal.maxGoalRounds} 轮</span>
          <span className="goal-actions">
            {goal.phase === 'active' && goal.activation === 'armed' && (
              <button type="button" className="goal-icon-btn" title="暂停目标" disabled={pending}
                onClick={() => { void onPause(); }}>⏸</button>
            )}
            {showResume && (
              <button type="button" className="goal-icon-btn" title="恢复目标" disabled={pending}
                onClick={() => { void onResume(); }}>▶</button>
            )}
            <button type="button" className="goal-icon-btn" title="编辑目标" disabled={pending}
              onClick={() => { setDraft(goal.objective); setEditing(true); }}>✎</button>
            <button type="button" className="goal-icon-btn danger" title="清除目标" disabled={pending}
              onClick={() => { void onClear(); }}>🗑</button>
          </span>
        </>
      )}
    </div>
  );
}
