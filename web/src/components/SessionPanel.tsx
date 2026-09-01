import React, { useState } from 'react';
import type { Session } from '../types';

interface SessionPanelProps {
  sessions?: Session[];
  activeId: string | null;
  busyIds?: string[];
  onNew: () => void;
  onSwitch: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

// 历史会话面板:新建/切换/重命名/删除会话
// 多会话并行:busyIds 是正在运行任务的会话集合——随时可新建/切换,切回运行中的会话可看到进行中的状态
export default function SessionPanel({ sessions = [], activeId, busyIds = [], onNew, onSwitch, onRename, onDelete }: SessionPanelProps) {
  const [editing, setEditing] = useState<string | null>(null); // 正在重命名的会话 id
  const [editText, setEditText] = useState('');

  const fmtTime = (t: string | number | undefined) => {
    if (!t) return '';
    const d = new Date(t);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };

  const startEdit = (s: Session) => { setEditing(s.id); setEditText(s.title || ''); };
  const commitEdit = (id: string) => {
    const t = editText.trim();
    setEditing(null);
    if (t) onRename(id, t);
  };

  return (
    <div className="panel">
      <div className="panel-title row" style={{ justifyContent: 'space-between' }}>
        <span>历史会话</span>
        <button className="sm" title="新建会话(原会话的任务继续在后台运行,可随时切换回来)" onClick={() => onNew()}>＋ 新建</button>
      </div>
      {sessions.length === 0 && <div className="muted" style={{ fontSize: 12 }}>暂无历史会话,点「＋ 新建」开始</div>}
      <div className="sessions">
        {sessions.map((s) => {
          const running = busyIds.includes(s.id);
          return (
            <div key={s.id} className={`session-item ${s.id === activeId ? 'active' : ''}`}
              title={running ? '任务进行中,点击切换查看' : s.id === activeId ? '当前会话' : '点击切换到此会话'}>
              {editing === s.id ? (
                <input className="s-edit grow" autoFocus value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={() => commitEdit(s.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(s.id); if (e.key === 'Escape') setEditing(null); }}
                  onClick={(e) => e.stopPropagation()} />
              ) : (
                <>
                  {running && <span className="s-run" title="任务进行中">●</span>}
                  <span className="s-title" onClick={() => s.id !== activeId && onSwitch(s.id)}>
                    {s.title || '新会话'}
                  </span>
                </>
              )}
              <span className="s-meta">{s.msgCount ?? 0}条 {fmtTime(s.updatedAt)}</span>
              <span className="s-actions" onClick={(e) => e.stopPropagation()}>
                <button title="重命名" onClick={() => (editing === s.id ? commitEdit(s.id) : startEdit(s))}>✎</button>
                <button className="danger" title={running ? '任务进行中,不能删除' : '删除会话'} disabled={running || s.id === activeId}
                  onClick={() => onDelete(s.id)}>🗑</button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}