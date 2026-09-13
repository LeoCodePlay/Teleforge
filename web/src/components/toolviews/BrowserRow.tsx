// 浏览器预览工具卡:展示 browser_* 工具操作的地址、SSH 隧道说明与截图,
// 并提供「在预览标签打开」按钮 —— AI 打开的页面,用户点一下就跳到同一个预览会话。
import React from 'react';
import type { ToolCallInfo } from '../../types';
import { ToolRow } from '../ToolRow/ToolRow';
import { IconBrowseOutline16 } from '../icons/icons';
import { toolRowModel } from '../../utils/toolRowModel';
import { openPreview, isPreviewUrl } from '../../utils/preview';
import './BrowserRow.scss';

export function BrowserRow({ call, inspect }: {
  call: ToolCallInfo;
  inspect?: () => void;
}) {
  const m = toolRowModel(call);
  const meta: any = call.ok !== undefined ? call.meta : undefined;
  const url = String(meta?.direct || meta?.url || '');
  const shot = meta?.screenshot;
  const hasCard = !!(url || shot?.url);
  const card = hasCard ? (
    <div className="dsh-browser">
      {url && (
        <div className="dsh-browser-bar">
          <span className="dsh-browser-url" title={url}>{url}</span>
          {isPreviewUrl(url) && (
            <button type="button" className="dsh-browser-open" onClick={() => openPreview(url)}>
              在预览标签打开
            </button>
          )}
        </div>
      )}
      {meta?.note && <div className="dsh-browser-note">{String(meta.note)}</div>}
      {shot?.url && (
        <a className="dsh-browser-shotwrap" href={String(shot.url)} target="_blank" rel="noopener noreferrer">
          <img className="dsh-browser-shot" src={String(shot.url)} alt={String(shot.name || '页面截图')} loading="lazy" />
        </a>
      )}
    </div>
  ) : null;
  return (
    <ToolRow
      variant="others"
      toolName={call.tool}
      icon={<IconBrowseOutline16 size={14} />}
      title={m.title}
      summary={m.summary}
      body={m.body}
      output={m.output}
      errorSummary={m.errorSummary}
      state={m.state}
      card={card}
      inspect={inspect}
    />
  );
}
