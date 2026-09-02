import React, { useState } from 'react';
import type { Session } from '../types';

interface SessionPanelProps {
  sessions?: Session[];
  activeId: string | null;
  busyIds?: string[];
  /** 当前作用域标签(连接的服务器或「本地工作区」) */
  scopeLabel?: string;
  /** 当前作用域键(username@host:port 或 'local');用于识别其他服务器后台运行的会话 */
  scopeKey?: string | null;
  onNew: () => void;
  onSwitch: (id: string) => void;
  /** 点击其他服务器正在运行的会话:切回该服务器并打开它 */
  onSwitchForeign?: (id: string, connKey: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

// 历史会话面板:新建/切换/重命名/删除会话(当前作用域的会话)
// 多会话并行:busyIds 是正在运行任务的会话集合——随时可新建/切换,切回运行中的会话可看到进行中的状态
// 跨服务器:其他服务器仍在后台运行的会话也显示在列表里(带所属服务器标记与「运行中」,
// 点击可切回该服务器查看);它们只在运行期间可见,结束后回到各自服务器的会话列表。
export default function SessionPanel({ sessions = [], activeId, busyIds = [], scopeLabel, scopeKey, onNew, onSwitch, onSwitchForeign, onRename, onDelete }: SessionPanelProps) {
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

  // 其他服务器后台运行的会话:connKey 与当前作用域不同,且仅在运行中(服务端只下发运行中的)
  const foreign = scopeKey ? (sessions || []).filter((s) => s.connKey && s.connKey !== scopeKey) : [];
  const mine = (sessions || []).filter((s) => !foreign.includes(s));
  const foreignLabel = (s: Session) => s.connKey === 'local' ? '本地工作区' : String(s.connKey || '');

  return (
    <div className="panel">
      <div className="panel-title row" style={{ justifyContent: 'space-between' }}>
        <span>历史会话</span>
        <button className="sm" title="新建会话(原会话的任务继续在后台运行,可随时切换回来)" onClick={() => onNew()}>＋ 新建</button>
      </div>
      {scopeLabel && <div className="s-scope" title="当前范围:会话列表只显示该服务器/本地工作区的对话">📡 {scopeLabel}</div>}
      {mine.length === 0 && <div className="muted" style={{ fontSize: 12 }}>暂无历史会话,点「＋ 新建」开始</div>}
      <div className="sessions">
        {mine.map((s) => {
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
                  {/* 点击始终触发切换请求(含当前会话):重载失败/加载中的会话可再次点击重试,
                      而非被 activeId 守卫挡成 no-op */}
                  <span className="s-title" onClick={() => onSwitch(s.id)}>
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
      {foreign.length > 0 && (
        <div className="s-foreign">
          <div className="s-foreign-title">其他服务器后台运行中</div>
          {foreign.map((s) => (
            <div key={s.id} className="session-item foreign" title="该服务器上仍在后台运行,点击切回查看">
              <span className="s-run" title="任务进行中">●</span>
              <span className="s-title" onClick={() => onSwitchForeign?.(s.id, s.connKey || '')}>
                {s.title || '新会话'}
                <span className="s-foreign-badge">📡 {foreignLabel(s)}</span>
              </span>
              <span className="s-meta">{s.msgCount ?? 0}条</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}