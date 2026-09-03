// 液态玻璃自定义下拉(GlassSelect):替代原生 <select>,保持整体 UI 风格统一
// 用法:
//   <GlassSelect value={v} onChange={fn}
//     options={[{ value, label, hint?, disabled?, group? }]}
//     placeholder="请选择…" title="提示" className="tb-model"
//     dir="up|down"   // 菜单弹出方向(底部工具栏用 up)
//     align="left|right" // 菜单对齐方式
//     full={true}     // 宽度占满父容器
//   />
// 交互:点击外部 / Esc 关闭;↑↓ 移动高亮 + Enter 选择(与原生 select 键盘行为对齐)
import React, { useEffect, useRef, useState } from 'react';

export interface GlassOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  group?: string;
}

interface GlassSelectProps {
  value: string;
  onChange: (v: string) => void;
  options?: GlassOption[];
  placeholder?: string;
  title?: string;
  className?: string;
  disabled?: boolean;
  dir?: 'up' | 'down';
  align?: 'left' | 'right';
  full?: boolean;
}

export default function GlassSelect({
  value, onChange, options = [], placeholder = '请选择…',
  title = '', className = '', disabled = false,
  dir = 'down', align = 'left', full = false
}: GlassSelectProps) {
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState<number | null>(null); // 键盘高亮:null = 无高亮(纯鼠标打开,不默认点亮第一项)
  const ref = useRef<HTMLDivElement>(null);

  const enabled = options.filter((o) => !o.disabled);
  // 当前选中项在可选项中的索引(作为键盘导航起点)
  const selIdx = enabled.findIndex((o) => o.value === value);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 键盘交互:↑↓ 高亮、Enter 选中、Esc 关闭(高亮起点 = 当前选中项)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); setHl(selIdx >= 0 ? selIdx : 0); setOpen(true);
      }
      return;
    }
    const move = (dir: number) => setHl((i) => {
      const base = i == null ? (selIdx >= 0 ? selIdx : 0) : i;
      const next = base + dir;
      if (next < 0) return enabled.length - 1;
      if (next >= enabled.length) return 0;
      return next;
    });
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const o = enabled[hl == null ? (selIdx >= 0 ? selIdx : 0) : hl];
      if (o) { onChange(o.value); setOpen(false); }
    } else if (e.key === 'Escape') { setOpen(false); }
  };

  // 按 group 分组渲染(空字符串 = 无分组)
  const groups: string[] = [];
  const byGroup: Record<string, GlassOption[]> = {};
  options.forEach((o) => {
    const g = o.group || '';
    if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
    byGroup[g].push(o);
  });

  const selected = options.find((o) => o.value === value);
  // 键盘高亮映射到可选项索引(null 时不高亮,避免纯鼠标打开时第一项误显示悬浮态)
  const isHl = (o: GlassOption) => hl !== null && !o.disabled && enabled.indexOf(o) === hl;

  return (
    <div ref={ref} onKeyDown={onKeyDown}
      className={`gselect ${open ? 'open' : ''} ${className || ''} ${full ? 'full' : ''}`}>
      <button type="button" className="gselect-trigger" disabled={disabled} data-tip={title}
        onClick={() => { if (!disabled) { setHl(null); setOpen((v) => !v); } }}>
        <span className="gselect-val">{selected ? selected.label : placeholder}</span>
        <span className="gselect-arrow">▾</span>
      </button>
      {open && !disabled && (
        <div className={`gselect-menu ${dir} ${align === 'right' ? 'right' : ''}`}>
          {options.length === 0 && <div className="gselect-empty">暂无选项</div>}
          {groups.map((g, gi) => (
            <div key={g || gi}>
              {g && <div className="gselect-group">{g}</div>}
              {byGroup[g].map((o) => {
                const hlCls = isHl(o) ? ' hl' : '';
                return (
                  <button key={o.value} type="button"
                    className={`gselect-item ${o.value === value ? 'on' : ''} ${o.disabled ? 'disabled' : ''}${hlCls}`}
                    disabled={o.disabled}
                    onClick={() => { if (!o.disabled) { onChange(o.value); setOpen(false); } }}>
                    <span className="gselect-item-label">{o.label}</span>
                    {o.hint && <span className="gselect-hint">{o.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}