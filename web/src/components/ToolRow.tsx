// 共享单行工具摘要行(照搬 deepseek-harness ui-tool/components/ToolRow):
// 16px 前导槽(状态点/工具图标,悬停/展开变 chevron)+ 标题 + 2x2 分隔点 +
// FILL 截断摘要;展开体为 IN/OUT 卡或专属卡片(Terminal/Read/Search/Diff)。
// 进行中:300px 扫光带循环;错误:红色 StateDot + 失败首行红字摘要。

import React from 'react';
import type { ReactNode } from 'react';
import { DisclosureRow, useDisclosure } from './DisclosureRow';
import { StateDot } from './StateDot';
import type { ToolRowState, ToolRowVariant } from '../toolRowModel';
import { IconInspectOutline12 } from './icons';

export interface ToolRowProps {
  variant: ToolRowVariant;
  toolName?: string;
  icon: ReactNode;
  title: string;
  summary: string;
  summarySuffix?: string | null;
  /** 展开体输入文本(pretty args);null = 无输入段 */
  body?: string | null;
  /** 展开体输出文本;null/缺省 = 无输出段 */
  output?: string | null;
  /** 错误行折叠摘要(失败首行红字);缺省用 summary */
  errorSummary?: string | null;
  state: ToolRowState;
  /** 文件路径链接(展开/摘要点击打开文件) */
  filePath?: string | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  /** 专属卡片渲染(由各 toolview 传入,替代 IN/OUT 通用卡) */
  card?: ReactNode | null;
  inspect?: (() => void) | undefined;
  children?: ReactNode;
}

/** 前导槽状态替换:error=红点、stopped=琥珀点;running 保留图标(扫光承载在行上) */
function leadingFor(state: ToolRowState, icon: ReactNode): ReactNode {
  switch (state) {
    case 'error': return <StateDot state="error" />;
    case 'stopped': return <StateDot state="warning" />;
    default: return icon;
  }
}

function stateStatus(state: ToolRowState): string | null {
  switch (state) {
    case 'running': return '进行中';
    case 'error': return '失败';
    case 'stopped': return '已中断';
    default: return null;
  }
}

export function ToolRow({
  variant,
  toolName,
  icon,
  title,
  summary,
  summarySuffix,
  body,
  output,
  errorSummary,
  state,
  filePath,
  onOpenFile,
  card,
  inspect,
  children,
}: ToolRowProps) {
  const { open, toggle } = useDisclosure(false);
  const hasBody = body != null && body !== '';
  const hasOutput = output != null && output !== '';
  const expandable = hasBody || hasOutput || !!card || !!children;
  const openState = open && expandable;
  const status = stateStatus(state);
  const failureLine = state === 'error' ? (errorSummary ?? null) : null;
  const summaryText = failureLine ?? summary;
  const suffix = failureLine === null ? (summarySuffix ?? null) : null;
  const fileLink = filePath !== undefined && onOpenFile !== undefined && failureLine === null;

  return (
    <div className="dsh-tool" data-variant={variant} data-tool={toolName} data-state={state}>
      {status !== null && <span className="dsh-visuallyHidden">{status}</span>}
      <DisclosureRow
        icon={leadingFor(state, icon)}
        title={title}
        open={openState}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggle}
        collapsedContent={summaryText !== '' && (
          <>
            <span className="dsh-sep" aria-hidden />
            {fileLink ? (
              <button
                type="button"
                className="dsh-fileLink"
                onClick={(e) => { e.stopPropagation(); onOpenFile?.(filePath); }}
              >
                {summaryText}
              </button>
            ) : (
              <span className={`dsh-summary ${failureLine !== null ? 'dsh-errorSummary' : ''}`}>
                {summaryText}
              </span>
            )}
            {suffix !== null && <span className="dsh-summarySuffix">{suffix}</span>}
          </>
        )}
      >
        <div className="dsh-bodyWrap">
          {card}
          {!card && (hasBody || hasOutput) && (
            <div className="dsh-ioCard">
              {hasBody && (
                <div className="dsh-ioSection">
                  <span className="dsh-ioLabel">IN</span>
                  <span className="dsh-ioText">{body}</span>
                </div>
              )}
              {hasBody && hasOutput && <span className="dsh-ioDivider" aria-hidden />}
              {hasOutput && (
                <div className="dsh-ioSection">
                  <span className="dsh-ioLabel">OUT</span>
                  <span className="dsh-ioText" data-error={state === 'error' || undefined}>
                    {output}
                  </span>
                </div>
              )}
            </div>
          )}
          {children}
          {inspect !== undefined && (
            <button type="button" className="dsh-inspectButton" onClick={inspect}>
              <IconInspectOutline12 size={12} />
              Inspect
            </button>
          )}
        </div>
      </DisclosureRow>
    </div>
  );
}