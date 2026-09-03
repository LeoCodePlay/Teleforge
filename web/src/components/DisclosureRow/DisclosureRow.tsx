// 共享折叠行基元(照搬 deepseek-harness ui-primitives/DisclosureRow):
// 24px 行高 + 16px 前导槽 + 6px 间隙 + 14/24 标题 + 折叠摘要,图标悬停/展开时
// 交叉淡入 chevron。expandOnRowClick 时整行可点(Enter/Space 支持);否则前导是独立按钮。

import React, { useState } from 'react';
import type { ReactNode } from 'react';
import { IconChevronDownOutline14 } from '../icons/icons';
import './DisclosureRow.scss';

export interface DisclosureRowProps {
  icon: ReactNode;
  title: string;
  open: boolean;
  expandable: boolean;
  onToggle: () => void;
  /** 整行作为展开触发(点击/Enter/Space) */
  expandOnRowClick?: boolean;
  /** 折叠摘要行展开后仍保留 */
  keepContentWhenOpen?: boolean;
  collapsedContent?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function DisclosureRow({
  icon,
  title,
  open,
  expandable,
  onToggle,
  expandOnRowClick = false,
  keepContentWhenOpen = false,
  collapsedContent,
  children,
  className,
}: DisclosureRowProps) {
  const rowExpands = expandable && expandOnRowClick;
  const previewChevron = expandable;
  const toggleFromKeyboard = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!rowExpands || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onToggle();
  };
  const collapsedLeading = previewChevron ? (
    <>
      <span className="dsh-iconIdle">{icon}</span>
      <IconChevronDownOutline14 className="dsh-chevronHover" />
    </>
  ) : icon;
  const leading = open
    ? <IconChevronDownOutline14 className="dsh-chevron" />
    : collapsedLeading;

  return (
    <div className={`dsh-row ${className || ''}`} data-open={open || undefined}>
      <div
        className="dsh-row-inner"
        data-expandable={rowExpands || undefined}
        role={rowExpands ? 'button' : undefined}
        tabIndex={rowExpands ? 0 : undefined}
        aria-expanded={rowExpands ? open : undefined}
        onClick={rowExpands ? onToggle : undefined}
        onKeyDown={rowExpands ? toggleFromKeyboard : undefined}
      >
        {expandable && !rowExpands ? (
          <button type="button" className="dsh-leading" aria-expanded={open} onClick={onToggle}>
            {leading}
          </button>
        ) : (
          <span className="dsh-leading">{leading}</span>
        )}
        <span className="dsh-title">{title}</span>
        {(keepContentWhenOpen || !open) && collapsedContent}
      </div>
      {open && children}
    </div>
  );
}

// 便于组件内本地折叠状态的 hook 复用
export function useDisclosure(initial = false) {
  const [open, setOpen] = useState(initial);
  return { open, toggle: () => setOpen((v) => !v) };
}