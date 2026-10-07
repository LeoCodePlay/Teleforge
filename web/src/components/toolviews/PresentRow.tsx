// present 工具的专属行(对齐 dsh:ui-deliverables 用 key `present` 注册 tool.call.toolview)。
//
// 为什么需要一个专属视图而不是走通用卡:
//   present 的参数就是"交付了哪些文件 + 每个的说明",这是结构化的、用户最关心的信息。
//   通用 IN/OUT 卡会把 JSON 原样摊开(带 path/description 字段名和转义),用户得自己从
//   JSON 里找文件名 —— 而这个工具存在的全部意义就是"把交付物摆给用户看"。
//
// 与成果物卡片(DeliverablesCard)的分工:
//   这里是**工具调用行**在对话流中的位置(可折叠,展开看原始参数);
//   卡片是**回合末**的交付汇总(在气泡下方常显)。两者用同一份数据、不同呈现层级。
import React from 'react';
import { ToolRow } from '../ToolRow/ToolRow';
import { StateDot } from '../StateDot/StateDot';
import { IconEye16 } from '../icons/icons';
import type { ToolCallInfo } from '../../types';

/** 从 present 的参数里取出交付清单(解析失败就退化为空数组,由通用摘要兜底) */
function parseFiles(argsRaw: string | null | undefined): Array<{ path: string; description?: string }> {
  const raw = String(argsRaw || '').trim();
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw);
    const files = obj?.files;
    if (!Array.isArray(files)) return [];
    return files
      .filter((f) => f && typeof f === 'object' && typeof f.path === 'string' && f.path)
      .map((f) => ({ path: String(f.path), ...(f.description ? { description: String(f.description) } : {}) }));
  } catch { return []; }
}

function baseName(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i >= 0 ? t.slice(i + 1) : t;
}

export function PresentRow({ call, inspect }: { call: ToolCallInfo; inspect?: () => void }) {
  const files = parseFiles(call.args);
  const running = call.ok === undefined;
  const failed = call.ok === false;
  // 摘要:文件名清单(最多 3 个 + 余量)。没有可解析的清单时留空,让 ToolRow 用原始参数兜底
  const names = files.map((f) => baseName(f.path));
  const shown = names.slice(0, 3).join('、');
  const summary = names.length === 0 ? '' : (names.length > 3 ? `${shown} 等 ${names.length} 个文件` : shown);
  // 展开体:每个成果物一行「文件名 + 说明」,而不是原始 JSON
  const body = files.length === 0 ? (call.args || null) : null;
  const output = failed ? String(call.result || '交付失败') : null;

  return (
    <ToolRow
      variant="others"
      toolName="present"
      icon={<IconEye16 size={14} />}
      title="交付文件"
      summary={summary}
      body={body}
      output={output}
      errorSummary={failed ? String(call.result || '').split('\n')[0] : null}
      state={running ? 'running' : failed ? 'error' : call.ms === undefined ? 'running' : 'ok'}
      inspect={inspect}
      card={files.length > 0 ? (
        <ul className="dsh-presentList">
          {files.map((f) => (
            <li key={f.path} className="dsh-presentItem">
              <span className="dsh-presentIcon" aria-hidden><IconEye16 size={13} /></span>
              <span className="dsh-presentName">{baseName(f.path)}</span>
              {f.description && <span className="dsh-presentDesc">{f.description}</span>}
              <span className="dsh-presentPath" title={f.path}>{f.path}</span>
            </li>
          ))}
        </ul>
      ) : null}
    >
      {running && (
        <div className="dsh-presentRunning">
          <StateDot state="ongoing" size={9} />正在交付…
        </div>
      )}
    </ToolRow>
  );
}
