// 成果物卡片:模型经 present 工具显式交付给用户的文件。
//
// 为什么与「N 个文件已更改」是两张卡、而不是合并成一张(参照 deepseek-harness 的 deliverables 分层):
//   - 「文件已更改」是宿主观察到的**事实**:本轮工作区里哪些文件被动了(可能包含模型从没提过的文件);
//   - 本卡片是模型声明的**交付意图**:"这几个是给你用的最终产物",每个还带一句人话说明。
//   合成一张会丢掉"哪个是给我用的"这个信息 —— 那恰恰是用户唯一关心的。
//
// 只显示路径与说明,**不复制内容**:点击文件名打开的就是那个路径上的**当前**文件。
// 因此卡片永远不会显示"过期副本";代价是文件被删掉后点击会失败(失败由打开逻辑自己提示)。
// 行内与「文件已更改」卡一致:点**文件名**打开文件,点**路径**复制完整路径(原地短暂显示「已复制」)。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PresentedFile } from '../../types';
import { IconEye16 } from '../icons/icons';
import { writeClipboard } from '../../dsh/ui-primitives/clipboard.ts';
import './DeliverablesCard.scss';

/** 「已复制」提示的停留时长(ms):够看清,又不至于让路径一直不可读 */
const COPY_FEEDBACK_MS = 1200;

// 只取路径最后一段(文件名),兼容 / 与 \ 分隔;根路径原样返回
function baseName(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i >= 0 ? t.slice(i + 1) : t;
}

// 按扩展名给一个粗略的类别标签,用于卡片右侧的类型提示(拿不到就不显示)
function kindLabel(name: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  const table: Record<string, string> = {
    doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel', csv: '表格', tsv: '表格',
    ppt: '演示', pptx: '演示', pdf: 'PDF', md: 'Markdown', txt: '文本', json: 'JSON',
    png: '图片', jpg: '图片', jpeg: '图片', gif: '图片', webp: '图片', svg: '图片',
    zip: '压缩包', tar: '压缩包', gz: '压缩包', html: '网页', htm: '网页'
  };
  return table[ext] || ext.toUpperCase();
}

export default function DeliverablesCard({ files, cwd, onOpen, onOpenAside }: {
  files: PresentedFile[];
  /** 当前工作目录:用于把绝对路径显示成相对路径(拿不到就显示原路径) */
  cwd?: string | null;
  /**
   * 打开文件:**整条声明**交给调用方 —— 服务端在 `local` 里记了归属侧(本机/远程),
   * 调用方据此直接选通道,不必再靠路径前缀猜(相对路径根本猜不出来)。
   */
  onOpen?: (file: PresentedFile) => void;
  /** 在**右侧栏**打开(对照阅读用;未提供则该入口不出现) */
  onOpenAside?: (file: PresentedFile) => void;
}) {
  // 「已复制」只标在刚点过的那一行:记录路径,复制成功后才亮,过一会儿自动熄灭
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  const copyPath = useCallback((path: string) => {
    void writeClipboard(path).then((ok) => {
      if (!ok) return;
      setCopiedPath(path);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        setCopiedPath(null);
        copyTimer.current = null;
      }, COPY_FEEDBACK_MS);
    });
  }, []);
  // 组件卸载(如切换会话)时清掉计时器,避免迟到的 setState
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);
  if (!files.length) return null;

  // 显示用路径:在 cwd 之下就截成相对路径(与「文件已更改」卡口径一致),否则原样显示
  const shownPath = (p: string): string => {
    if (!cwd) return p;
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
    const c = norm(cwd); const q = norm(p);
    return q.startsWith(c + '/') ? q.slice(c.length + 1) : p;
  };

  return (
    <div className="deliverables" data-deliverables={files.length} aria-label={`已交付 ${files.length} 个文件`}>
      <div className="deliverables-head">
        <span className="deliverables-title">{files.length === 1 ? '交付文件' : `交付 ${files.length} 个文件`}</span>
      </div>
      <ul className="deliverables-list">
        {files.map((f) => {
          const name = baseName(f.path) || f.path;
          const kind = kindLabel(name);
          const shown = shownPath(f.path);
          const copied = copiedPath === f.path;
          return (
            <li key={f.path} className={onOpenAside ? 'has-aside' : undefined}>
              {/* 主行不再是整行按钮:文件名 = 打开文件,路径 = 复制完整路径 */}
              <div className="deliverables-row" data-deliverable={f.path}>
                <span className="deliverables-ico" aria-hidden><IconEye16 size={15} /></span>
                {onOpen ? (
                  <button type="button" className="deliverables-name deliverables-open"
                    data-open-file={f.path} data-tip={`点击打开 ${f.path}`}
                    aria-label={`打开 ${f.path}`} onClick={() => onOpen(f)}>
                    {name}
                  </button>
                ) : (
                  <span className="deliverables-name" data-tip={f.path}>{name}</span>
                )}
                {/* 说明是模型写的人话;没有就不占位(而不是拿文件名凑数) */}
                {f.description && <span className="deliverables-desc">{f.description}</span>}
                <span className="deliverables-gap" />
                {kind && <span className="deliverables-kind">{kind}</span>}
                {/* 相对路径帮助区分同名文件;悬停提示与复制内容都是完整路径 */}
                <button type="button" className={`deliverables-path${copied ? ' copied' : ''}`}
                  data-copy-path={f.path}
                  data-tip={copied ? '已复制到剪贴板' : `点击复制路径:${f.path}`}
                  aria-label={`复制路径 ${f.path}`}
                  onClick={() => copyPath(f.path)}>
                  {copied ? '已复制' : shown}
                </button>
              </div>
              {/* 次要入口:侧栏对照阅读。默认隐藏,悬停/聚焦才出现 */}
              {onOpenAside && (
                <button type="button" className="deliverables-aside" data-deliverable-aside={f.path}
                  data-tip={`在右侧栏打开 ${f.path}`} aria-label={`在右侧栏打开 ${f.path}`}
                  onClick={() => onOpenAside(f)}>侧栏</button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
