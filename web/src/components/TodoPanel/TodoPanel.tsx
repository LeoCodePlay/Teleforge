// 任务计划面板(照搬 deepseek-harness 的 TodoPanel):
// - 位置:对话输入框上方(composer 停靠区),对齐 harness 的 conversation.input.dock
// - 数据:todo_write 工具写入的整表快照(经 todo_update 事件 / get_history 载入);
//   生命周期(跨轮存活的 standing plan):清单里还有未完成项就一直显示——用户接着发
//   消息时面板不消失,后端会把剩余计划拼进新指令让模型按计划继续;全部 completed
//   (或清单为空)则收起,不再打扰。新一轮不再清空未完成的计划(见 foldTodos)
// - 交互:默认折叠,点击头部展开/收起;折叠时显示进度摘要;清单为空或已全部完成时整体隐藏
import React, { useState } from 'react';
import type { TodoItem } from '../../types';
import './TodoPanel.scss';

// 状态图标(照搬 harness 的 14×14 SVG 画板):
// completed 实心勾圆 / in_progress 旋转渐变环(动画在 CSS)/ pending 虚线环
function CompletedGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className="glyph-completed">
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ProgressGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className="glyph-progress">
      <defs>
        <linearGradient id="todo-prog" x1="2.5" y1="12" x2="10.5" y2="3.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="7" cy="7" r="6.4" stroke="url(#todo-prog)" strokeWidth="1.2" />
    </svg>
  );
}

function PendingGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className="glyph-pending">
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" />
    </svg>
  );
}

function StatusGlyph({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') return <CompletedGlyph />;
  if (status === 'in_progress') return <ProgressGlyph />;
  return <PendingGlyph />;
}

/** 头部进度摘要:"N 已完成 · M 进行中 · K 待办",零计数段省略(照搬 harness) */
function progressLabel(todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.filter((t) => t.status === 'in_progress').length;
  const pending = todos.length - done - active;
  return [
    ...(done > 0 ? [`${done} 已完成`] : []),
    ...(active > 0 ? [`${active} 进行中`] : []),
    ...(pending > 0 ? [`${pending} 待办`] : [])
  ].join(' · ');
}

export default function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const [collapsed, setCollapsed] = useState(true); // 默认折叠
  // 隐藏条件:没有计划,或计划已全部完成(收尾清单不再占据输入区上方的停靠空间)。
  // 只要还剩 pending/in_progress 项,面板就跨轮保持显示——与会话端的 foldTodos
  // (未完成的计划不被新一轮作废)是同一条规则的两侧。
  if (!todos || todos.length === 0) return null;
  if (todos.every((t) => t.status === 'completed')) return null;
  return (
    <section className="todo-panel" aria-label="任务计划">
      <button
        type="button"
        className="todo-header"
        aria-expanded={!collapsed}
        data-tip={collapsed ? '展开任务计划' : '收起任务计划'}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="todo-left">
          <span className="todo-lead" aria-hidden>
            <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
              <path d="M2 3.5h7M2 7h10M2 10.5h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M11.2 2.6l.9.9-1.9 1.9-.9-.9z" fill="currentColor" />
            </svg>
          </span>
          <span className="todo-title">任务计划</span>
        </span>
        <span className="todo-right">
          <span className="todo-progress">{progressLabel(todos)}</span>
          <span className="todo-chevron" aria-hidden>
            <svg width={12} height={12} viewBox="0 0 12 12" fill="none">
              <path d="M3.2 4.6L6 7.4l2.8-2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
      </button>
      {!collapsed && (
        <ul className="todo-list">
          {todos.map((item, i) => (
            <li key={i} className="todo-item" data-status={item.status}>
              <span className="todo-glyph" aria-hidden><StatusGlyph status={item.status} /></span>
              <span className="todo-content">{item.content}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
