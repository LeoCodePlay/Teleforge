// 兜底工具卡(照搬 harness ui-tool/toolviews/GenericToolCard):
// 未注册专属视图的工具都落这里:toolRowModel 分类 variant、选图标、派生摘要/展开体。
// singleFile(read/write/edit)工具不暴露 args body,摘要即路径链接。

import React from 'react';
import type { ToolCallInfo } from '../../types';
import { ToolRow } from '../ToolRow/ToolRow';
import {
  IconApiOutline14, IconBrowseOutline16, IconChecklistOutline14, IconCodeOutline16,
  IconEditOutline16, IconQuestionOutline14, IconSearchOutline16, IconSparkle16,
} from '../icons/icons';
import { toolRowModel, type ToolRowVariant } from '../../utils/toolRowModel';

const VARIANT_ICONS: Record<ToolRowVariant, React.ReactNode> = {
  search: <IconSearchOutline16 size={14} />,
  read: <IconBrowseOutline16 size={14} />,
  bash: <IconApiOutline14 size={14} />,
  write: <IconEditOutline16 size={14} />,
  edit: <IconEditOutline16 size={14} />,
  code: <IconCodeOutline16 size={14} />,
  todo: <IconChecklistOutline14 size={14} />,
  ask: <IconQuestionOutline14 size={14} />,
  others: <IconSparkle16 size={14} />,
};

const SINGLE_FILE_VARIANTS: ReadonlySet<ToolRowVariant> = new Set(['read', 'write', 'edit']);

export function GenericToolCard({ call, onOpenFile, inspect }: {
  call: ToolCallInfo;
  onOpenFile?: (path: string) => void;
  inspect?: () => void;
}) {
  const m = toolRowModel(call);
  const singleFile = SINGLE_FILE_VARIANTS.has(m.variant);
  return (
    <ToolRow
      variant={m.variant}
      toolName={call.tool}
      icon={VARIANT_ICONS[m.variant]}
      title={m.title}
      summary={m.summary}
      body={singleFile ? null : m.body}
      output={m.output}
      errorSummary={m.errorSummary}
      state={m.state}
      filePath={m.filePath}
      onOpenFile={onOpenFile}
      inspect={inspect}
    />
  );
}