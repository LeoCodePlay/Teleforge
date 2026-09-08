// 液态玻璃自定义下拉(GlassSelect):替代原生 <select>,保持整体 UI 风格统一
// 用法:
//   <GlassSelect value={v} onChange={fn}
//     options={[{ value, label, hint?, disabled?, group? }]}
//     placeholder="请选择…" title="提示" className="tb-model"
//     dir="up|down"   // 菜单弹出方向(首选方向空间不足时自动翻到另一侧)
//     align="left|right" // 菜单对齐方式
//     full={true}     // 宽度占满父容器
//   />
// 交互:点击外部 / Esc 关闭;↑↓ 移动高亮 + Enter 选择(与原生 select 键盘行为对齐)
// 菜单层:portal 到 body + fixed 定位(与 PermissionSelect / SlashMenu 同款处理)。
// 触发器总是嵌在带 backdrop-filter 的祖先里(.settings / .modal / .composer-box),而 Chromium 的
// backdrop-root 机制会把这类祖先变成后代 backdrop 的采样边界——菜单 blur 只采到祖先那块半透明
// 平色,磨不出细节,液态玻璃退化成透明(直接看穿底下的正文);祖先的 overflow 还会顺手裁掉菜单。
// portal 到 body 后菜单与 .ctxmenu/.perm-menu 同层,复用同一条玻璃配方,观感与其它下拉完全一致
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './GlassSelect.scss';

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

/** 菜单与触发器的间距(与 .msm-menu/.perm-menu 的 calc(100% + 8px) 同语义) */
const MENU_GAP = 8;
/** 视口安全边距 */
const EDGE = 8;

export default function GlassSelect({
  value, onChange, options = [], placeholder = '请选择…',
  title = '', className = '', disabled = false,
  dir = 'down', align = 'left', full = false
}: GlassSelectProps) {
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState<number | null>(null); // 键盘高亮:null = 无高亮(纯鼠标打开,不默认点亮第一项)
  const [, setPosTick] = useState(0); // 滚动/缩放后强制重渲染,重算 fixed 坐标
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const enabled = options.filter((o) => !o.disabled);
  // 当前选中项在可选项中的索引(作为键盘导航起点)
  const selIdx = enabled.findIndex((o) => o.value === value);

  // 点击外部 / Esc 关闭。菜单 portal 到了 body,不再位于 .gselect 子树内,
  // 故"外部"判定必须同时放过触发器与 portal 出去的菜单,否则点选项会先被当成点外部关掉
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 打开期间跟踪触发器位置:任意层滚动(capture 捕获弹窗 modal-body 等内层滚动)
  // 或窗口缩放都重新计算菜单坐标,避免菜单脱离触发器停在原地
  useEffect(() => {
    if (!open) return;
    const bump = () => setPosTick((n) => n + 1);
    document.addEventListener('scroll', bump, true);
    window.addEventListener('resize', bump);
    return () => {
      document.removeEventListener('scroll', bump, true);
      window.removeEventListener('resize', bump);
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
    const move = (d: number) => setHl((i) => {
      const base = i == null ? (selIdx >= 0 ? selIdx : 0) : i;
      const next = base + d;
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

  // 菜单 fixed 坐标:每次渲染按触发器当前视口位置重算(与 PermissionSelect 同法)。
  // 向上弹出用 bottom 锚定,不用 top + translateY(-100%)——入场动画 glass-pop 的 transform
  // 会临时覆盖静态位移,导致菜单先垂在下方、动画结束才瞬移到位
  const menuStyle = (): React.CSSProperties | undefined => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return undefined;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const est = Math.min(340, vh * 0.58); // 菜单最大高度,与 .gselect-menu 的 max-height 同式
    const spaceUp = r.top - MENU_GAP;
    const spaceDown = vh - r.bottom - MENU_GAP;
    // 首选方向装得下就按首选;装不下则挑更宽裕的一侧
    const up = (dir === 'up' ? spaceUp : spaceDown) >= est ? dir === 'up' : spaceUp > spaceDown;
    const minW = Math.floor(r.width);
    // fixed 下百分比尺寸相对视口而非触发器,故不能用 min-width:100% / max-width:min(300px,80vw):
    // 改给绝对像素 —— 下限不窄于触发器,上限沿用原 300px 观感,并保证不溢出视口
    const room = align === 'right' ? Math.floor(r.right) - EDGE : vw - Math.floor(r.left) - EDGE;
    const style: React.CSSProperties = {
      minWidth: minW,
      maxWidth: Math.max(minW, Math.min(Math.max(minW, 300), room)),
    };
    if (up) style.bottom = Math.max(EDGE, vh - r.top + MENU_GAP);
    else style.top = Math.min(vh - EDGE, r.bottom + MENU_GAP);
    if (align === 'right') style.right = Math.max(EDGE, vw - r.right);
    else style.left = Math.max(EDGE, r.left);
    return style;
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

  const menu = open && !disabled && createPortal(
    <div ref={menuRef} className="gselect-menu" style={menuStyle()}
      // 菜单在 React 树里仍是本组件后代,事件会沿组件树冒泡到外层 .modal-overlay 的 onClick
      // (点选项连带把整个弹窗关掉),故在此截断;keydown 同原因在菜单上再挂一次,
      // 保证焦点进入菜单项后 ↑↓/Enter 仍然可用
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}>
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
    </div>,
    document.body
  );

  return (
    <div ref={ref} onKeyDown={onKeyDown}
      className={`gselect ${open ? 'open' : ''} ${className || ''} ${full ? 'full' : ''}`}>
      <button type="button" className="gselect-trigger" disabled={disabled} data-tip={title}
        onClick={() => { if (!disabled) { setHl(null); setOpen((v) => !v); } }}>
        <span className="gselect-val">{selected ? selected.label : placeholder}</span>
        <span className="gselect-arrow">▾</span>
      </button>
      {menu}
    </div>
  );
}
