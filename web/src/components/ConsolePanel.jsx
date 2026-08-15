import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const QUICK = ['pwd', 'ls -la', 'node -v', 'python3 --version', 'git status', 'df -h .'];

export default function ConsolePanel({ connected }) {
  const [cmd, setCmd] = useState('');
  const [lines, setLines] = useState([]); // {stream:'stdout'|'stderr'|'info', text}
  const [running, setRunning] = useState(false);
  const [exit, setExit] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    const subs = [
      api.on('exec', (m) => {
        if (m.event === 'start') {
          setRunning(true); setExit(null);
          setLines((l) => [...l, { stream: 'info', text: `$ ${m.command}` }]);
        } else if (m.event === 'output') {
          setLines((l) => [...l, { stream: m.stream, text: m.data }]);
        } else if (m.event === 'exit') {
          setRunning(false);
          setExit(m.error ? -1 : m.code);
          if (m.error) setLines((l) => [...l, { stream: 'stderr', text: m.error }]);
          else if (m.code === -1) setLines((l) => [...l, { stream: 'stderr', text: '(被终止/超时)' }]);
        }
      })
    ];
    return () => subs.forEach((off) => off());
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const run = (c) => {
    if (!c?.trim() || !connected || running) return;
    api.send('run_command', { command: c });
  };

  return (
    <div className="consolewrap">
      <div className="console" ref={scrollRef}>
        {lines.length === 0 && <div className="muted">命令输出将显示在这里(默认在工作区目录内执行,可通过 cd 切换)</div>}
        {lines.map((l, i) => (
          <div key={i} className={`cline ${l.stream === 'stderr' ? 'cerr' : l.stream === 'info' ? 'cinfo' : ''}`}>{l.text}</div>
        ))}
        {running && <div className="cline cinfo">…</div>}
      </div>
      <div className="composer">
        <div className="quick">
          {QUICK.map((q) => <button key={q} className="chip-btn" disabled={!connected} onClick={() => { setCmd(q); run(q); }}>{q}</button>)}
          <button className="chip-btn" disabled={!lines.length} onClick={() => setLines([])}>清空</button>
        </div>
        <textarea value={cmd} onChange={(e) => setCmd(e.target.value)}
          placeholder="输入远程命令,Enter 执行"
          disabled={!connected || running}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(cmd); } }} rows={2} />
        <div className="row gap">
          <button className="primary grow" disabled={!connected || running || !cmd.trim()} onClick={() => run(cmd)}>执行 (Enter)</button>
          {exit !== null && <span className={`exit ${exit === 0 ? 'ok' : 'err'}`}>退出码 {exit}</span>}
        </div>
      </div>
    </div>
  );
}