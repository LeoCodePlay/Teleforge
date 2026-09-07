// 访问权限模式选择器(输入框左下角;交互照搬 deepseek-harness 的 PermissionSelect):
// - 触发器:盾牌图标 + 当前模式名 + 箭头,向上弹出菜单(composer 在页面底部);
// - 四档模式:变更前确认 / 自动编辑 / 计划模式 / 完全访问,菜单行带图标与一句话说明;
// - 菜单 portal 到 body 并悬于输入卡上方(照搬 SlashMenu 的定位与理由:嵌在
//   composer-box 的 backdrop-filter 内时 Chromium 不应用 backdrop-filter,玻璃失效);
// - 完全访问风险确认:对齐 harness 的 RiskConfirmation 语义,先弹确认框(危险样式),
//   用户确认后才提交 permission_set;其余模式直接切换(乐观更新,失败由父级回滚)。
import React, { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useFeedback } from '../../context/feedback';
import './PermissionSelect.scss';

export type PermissionMode = 'confirm' | 'auto-edit' | 'plan' | 'full-access';

export const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; name: string; description: string }> = [
  { value: 'confirm', name: '变更前确认', description: '写文件、编辑、删除与执行命令前,先请求你批准' },
  { value: 'auto-edit', name: '自动编辑', description: '文件写入与编辑自动执行;执行命令前仍需批准' },
  { value: 'plan', name: '计划模式', description: '只读研究:AI 只调研并给出计划,不执行任何变更' },
  { value: 'full-access', name: '完全访问', description: '全部操作自动执行,不再询问(高危命令拦截仍生效)' }
];

const MODE_VALUES = new Set(PERMISSION_MODE_OPTIONS.map((o) => o.value));
/** 运行时校验:事件/历史里来的模式值是否合法(旧服务端/脏数据回落默认) */
export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && MODE_VALUES.has(v as PermissionMode);
}

const MODE_INDEX = new Map(PERMISSION_MODE_OPTIONS.map((o) => [o.value, o]));

/* 盾牌族图标(参照 harness PermissionSelect 的 design set:同一盾形轮廓,内部各表其义):
   对勾 = 确认、铅笔 = 编辑、横线 = 计划清单、叹号 = 完全访问;currentColor 随行文字着色 */
const SHIELD_OUTLINE = 'M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z';

const modeGlyphs: Record<PermissionMode, React.ReactNode> = {
  'confirm': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={SHIELD_OUTLINE} stroke="currentColor" strokeWidth="1.32" strokeLinejoin="round" />
      <path d="M5.4 8.2l2 2 3.5-4.4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  'auto-edit': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={SHIELD_OUTLINE} stroke="currentColor" strokeWidth="1.32" strokeLinejoin="round" />
      <path d="M10.6 4.9l.9.9-3.7 3.7-1.4.5.5-1.4 3.7-3.7z" fill="currentColor" />
    </svg>
  ),
  'plan': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={SHIELD_OUTLINE} stroke="currentColor" strokeWidth="1.32" strokeLinejoin="round" />
      <path d="M5 5.4h6M5 8h6M5 10.6h3.6" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
    </svg>
  ),
  'full-access': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={SHIELD_OUTLINE} stroke="currentColor" strokeWidth="1.32" strokeLinejoin="round" />
      <path d="M9.1 4.5v4.26H7.6V4.5h1.5z" fill="currentColor" />
      <path d="M9.1 9.81V11.5H7.6V9.81h1.5z" fill="currentColor" />
    </svg>
  )
};

export default function PermissionSelect({ value, disabled = false, onChange, anchorRef }: {
  value: PermissionMode;
  /** 仅会话切换中锁定;草稿态(新会话)不锁:所选模式先存本地,随 session_create 落地 */
  disabled?: boolean;
  onChange: (mode: PermissionMode) => void;
  /** 输入卡锚点(composer-box):菜单 portal 到 body 后按其位置做 fixed 定位 */
  anchorRef?: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { confirm } = useFeedback();
  const current = MODE_INDEX.get(value) || PERMISSION_MODE_OPTIONS[0];

  // 点击组件(chip + portal 出去的菜单)之外关闭:与工作区 chip 的弹窗同款规则
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current && rootRef.current.contains(t)) return;
      if (t instanceof Element && t.closest('.perm-menu')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = async (mode: PermissionMode) => {
    setOpen(false);
    if (mode === value || disabled) return;
    // 完全访问:先风险确认(harness RiskConfirmation 语义),确认后才切换
    if (mode === 'full-access') {
      const ok = await confirm({
        title: '开启完全访问?',
        message: '完全访问模式下,AI 对文件的写入、编辑、删除与命令执行都将自动进行,不再逐项请求确认(毁灭性命令的拦截仍然生效)。请确认当前工作区可以承受无人值守的自动变更。',
        confirmLabel: '开启完全访问',
        danger: true
      });
      if (!ok) return;
    }
    onChange(mode);
  };

  // portal 定位(每次渲染重算):菜单底边锚定在触发 chip 上方 8px(与 msm/ws-pick 的
  // bottom: calc(100% + 8px) 同语义)。用 bottom 而非 top+translateY(-100%):
  // 入场动画 glass-pop 的 transform 会临时覆盖静态位移,导致菜单先垂在下方、动画
  // 结束才瞬移到位;bottom 锚定不依赖 transform,入场只有原生的弹入动效
  const chipR = rootRef.current?.getBoundingClientRect();
  const boxR = anchorRef?.current?.getBoundingClientRect();
  const anchor = chipR ?? boxR;
  const pos = anchor
    ? { left: Math.max(8, anchor.left), bottom: Math.max(12, window.innerHeight - anchor.top + 8) }
    : undefined;

  return (
    <div className="perm-select" ref={rootRef}>
      <button
        type="button"
        className={`perm-chip${value === 'plan' ? ' plan' : ''}${value === 'full-access' ? ' danger' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={current.description}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="perm-chip-icon" aria-hidden="true">{modeGlyphs[value] || modeGlyphs.confirm}</span>
        <span className="perm-chip-label">{current.name}</span>
        <span className={`perm-chip-arrow${open ? ' open' : ''}`}>▾</span>
      </button>
      {open && createPortal(
        <div className="perm-menu" role="menu" style={pos}>
          {PERMISSION_MODE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              className={`perm-menu-item${o.value === value ? ' on' : ''}`}
              onClick={() => pick(o.value)}
            >
              <span className="perm-menu-icon" aria-hidden="true">{modeGlyphs[o.value]}</span>
              <span className="perm-menu-text">
                <span className="perm-menu-name">{o.name}</span>
                <span className="perm-menu-desc">{o.description}</span>
              </span>
              {o.value === value && <span className="perm-menu-cur">✓</span>}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
