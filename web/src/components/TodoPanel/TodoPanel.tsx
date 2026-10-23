// 任务计划面板(照搬 deepseek-harness 的 TodoPanel):
// - 位置:对话输入框上方(composer 停靠区),对齐 harness 的 conversation.input.dock
// - 数据:todo_write 工具写入的整表快照(经 todo_update 事件 / get_history 载入);
//   生命周期(跨轮存活的 standing plan):清单里还有未完成项就一直显示——用户接着发
//   消息时面板不消失,后端会把剩余计划拼进新指令让模型按计划继续;全部 completed
//   (或清单为空)则收起,不再打扰。新一轮不再清空未完成的计划(见 foldTodos)
// - 交互:默认折叠,点击头部展开/收起;折叠时显示进度摘要;清单为空或已全部完成时整体隐藏
import React, { useState } from 'react';
import type { TodoItem } from '../../types';
import {
  IconCheckCircle16, IconChecklistOutline14, IconChevronDownOutline14, IconPendingCircle16, IconProgressCircle16
} from '../icons/icons';
import './TodoPanel.scss';

/** 计划项状态图标:与全站 LINE 图标同源(16 号网格、1.6 描边、圆端点)。 */
function StatusGlyph({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') return <IconCheckCircle16 size={14} className="glyph-completed" />;
  if (status === 'in_progress') return <IconProgressCircle16 size={14} className="glyph-progress" />;
  return <IconPendingCircle16 size={14} className="glyph-pending" />;
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
            <IconChecklistOutline14 size={14} />
          </span>
          <span className="todo-title">任务计划</span>
        </span>
        <span className="todo-right">
          <span className="todo-progress">{progressLabel(todos)}</span>
          <span className="todo-chevron" aria-hidden>
            <IconChevronDownOutline14 size={12} />
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
