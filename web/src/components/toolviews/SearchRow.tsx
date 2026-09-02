// 搜索结果卡视图(照搬 harness ui-tool/toolviews/search-row + SearchBlock):
// 解析 result 的 `path:line:content` 行为按文件分组,每个文件一个可折叠头 +
// 行号 + 匹配行。兼容 rg / grep / findstr 三种输出形态(都含 path:line:content)。

import React from 'react';
import type { ToolCallInfo } from '../../types';
import { ToolRow } from '../ToolRow';
import { IconSearchOutline16 } from '../icons';
import { toolRowModel, relativizeToCwd } from '../../toolRowModel';

interface MatchLine { n: string; text: string; }
interface MatchFile { path: string; lines: MatchLine[]; }

/** 解析 rg/grep/findstr 的 'path:line:content' 行(Windows 路径含冒号,故非贪婪匹配到 ':数字:') */
function parseMatches(result?: string | null, workspace?: string): MatchFile[] {
  const text = String(result ?? '');
  const files = new Map<string, MatchFile>();
  const re = /^(.+?):(\d+):(.*)$/;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    // 跳过表头 '匹配结果(...):' 与空行
    if (!line || /^匹配结果/.test(line)) continue;
    const m = line.match(re);
    if (!m) continue;
    const path = relativizeToCwd(m[1].trim(), workspace);
    const entry = files.get(path) || { path, lines: [] };
    entry.lines.push({ n: m[2], text: m[3] });
    files.set(path, entry);
  }
  return [...files.values()];
}

export function SearchRow({ call, workspace, inspect }: {
  call: ToolCallInfo;
  workspace?: string;
  inspect?: () => void;
}) {
  const m = toolRowModel(call);
  const files = call.ok !== undefined ? parseMatches(call.result, workspace) : [];
  const total = files.reduce((a, f) => a + f.lines.length, 0);
  const searchCard = call.ok !== undefined && files.length > 0 ? (
    <div className="dsh-search" data-kind="matches">
      <div className="dsh-search-header">{total} 处匹配 · {files.length} 个文件</div>
      {files.map((f, i) => (
        <div key={i} className="dsh-search-file">
          <div className="dsh-search-fileHeader">
            <span className="dsh-search-filePath">{f.path}</span>
            <span className="dsh-search-fileCount">{f.lines.length}</span>
          </div>
          {f.lines.slice(0, 50).map((l, j) => (
            <div key={j} className="dsh-search-line">
              <span className="dsh-search-lineNumber">{l.n}: </span>
              <span className="dsh-search-lineText">{l.text}</span>
            </div>
          ))}
          {f.lines.length > 50 && <div className="dsh-search-more">… 还有 {f.lines.length - 50} 行</div>}
        </div>
      ))}
    </div>
  ) : null;
  return (
    <ToolRow
      variant="search"
      toolName={call.tool}
      icon={<IconSearchOutline16 size={14} />}
      title={m.title}
      summary={m.summary}
      output={m.output}
      errorSummary={m.errorSummary}
      state={m.state}
      card={searchCard}
      inspect={inspect}
    />
  );
}