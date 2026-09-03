// 网络搜索结果卡视图(照搬 deepseek-harness 的 web-search 卡片语义):
// 后端 web_search 工具在 tool_result 附加结构化 sources(标题/摘要/链接/发布时间),
// 这里逐条渲染成可点击来源列表。摘要行复用 ToolRow 的 search 变体(标题 = 查询词)。

import React from 'react';
import type { ToolCallInfo, WebSearchSourceMeta } from '../../types';
import { ToolRow } from '../ToolRow';
import { IconBrowseOutline16 } from '../icons';
import { toolRowModel } from '../../utils/toolRowModel';

export function WebSearchRow({ call, inspect }: {
  call: ToolCallInfo;
  inspect?: () => void;
}) {
  const m = toolRowModel(call);
  // 结构化来源来自 meta;无 meta(历史兼容/异常)时退回纯文本输出
  const sources: WebSearchSourceMeta[] = call.ok !== undefined ? (call.meta?.sources ?? []) : [];
  const card = call.ok !== undefined && sources.length > 0 ? (
    <div className="dsh-webs" data-kind="web">
      <div className="dsh-search-header">{sources.length} 条搜索结果</div>
      {sources.map((s, i) => (
        <a
          key={s.url}
          className="dsh-web"
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="dsh-web-rank">{i + 1}</span>
          <span className="dsh-web-body">
            <span className="dsh-web-title">{s.title || s.url}</span>
            {s.snippet && <span className="dsh-web-snippet">{s.snippet}</span>}
            <span className="dsh-web-meta">
              <span className="dsh-web-url">{s.url}</span>
              {s.publishedAt && <span className="dsh-web-date">{s.publishedAt}</span>}
            </span>
          </span>
        </a>
      ))}
    </div>
  ) : null;
  return (
    <ToolRow
      variant="search"
      toolName={call.tool}
      icon={<IconBrowseOutline16 size={14} />}
      title={m.title}
      summary={m.summary}
      output={m.output}
      errorSummary={m.errorSummary}
      state={m.state}
      card={card}
      inspect={inspect}
    />
  );
}
