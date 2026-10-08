// 助手正文/思考段的渲染原子:markdown 解析(marked + DOMPurify)+ 折叠 thinking 块 +
// 按 text 引用 memo。对话区与「子代理回看面板」共用同一套渲染 —— 子代理的对话因此
// 和正常对话长得一模一样(同一气泡、同一工具行、同一思考行),只是不能发送。
import React, { memo, useEffect, useRef, useState } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { writeClipboard } from '../../dsh/ui-primitives/clipboard.ts';
import { IconCheck16, IconCopy16 } from '../icons/icons';
import { ReasoningRow } from '../ReasoningRow/ReasoningRow';

// 完整 Markdown 解析(marked + DOMPurify):
// gfm 支持表格/任务列表等,breaks 保留单换行即换行的聊天习惯;
// 输出再经 DOMPurify 白名单清洗,AI 内容里即使夹带 HTML 也不会注入。
const mdParser = new Marked({ gfm: true, breaks: true });

export function renderMarkdown(text = '') {
  if (!text || !text.trim()) return '';
  // Marked 同步模式下 parse 返回 string(异步 mode 才返回 Promise)
  const html = mdParser.parse(text) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

// 提取 ```thinking …``` 块为折叠行(ReasoningRow,与 reasoning 通道同款呈现),
// 剩余文本交给 AssistantText 继续渲染;当正文只由 thinking 块组成(纯推理回复)时,返回 null。
function renderAssistantContent(content = '') {
  const blocks: React.ReactElement[] = [];
  const rest = content.replace(/```thinking\s*([\s\S]*?)```/g, (_m, t) => {
    blocks.push(<ReasoningRow key={blocks.length} text={t.trim()} />);
    return '';
  });
  if (!blocks.length) return null; // 无 thinking 块:交给调用方直接渲染
  const restHtml = rest.trim();
  return (
    <>
      {blocks}
      {restHtml && <AssistantText text={rest} />}
    </>
  );
}

// 围栏代码块:语言条 + 复制按钮 + 代码体。
// 复制取的是剥掉围栏与语言标注后的原文(与显示一致),不会把 ``` 或语言名带进剪贴板。
const FencedCode = memo(function FencedCode({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current); }, []);
  const onCopy = () => {
    if (copied) return;
    void writeClipboard(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      timerRef.current = setTimeout(() => { timerRef.current = null; setCopied(false); }, 1200);
    });
  };
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang}</span>
        <button type="button" className="md-code-copy action-icon" aria-label="复制代码"
          data-tip={copied ? '已复制' : '复制代码'} onClick={onCopy}>
          {copied ? <IconCheck16 size={14} /> : <IconCopy16 size={14} />}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
});

// 拆出单个围栏的「语言标注 + 代码体」:首行(` ```lang `)是信息串,不参与显示与复制。
function parseFence(part: string): { lang: string; code: string } {
  const m = /^```([^\n]*)\r?\n?([\s\S]*?)```$/.exec(part);
  if (!m) return { lang: '', code: part.slice(3, Math.max(3, part.length - 3)) };
  return { lang: (m[1] || '').trim(), code: m[2].replace(/\n$/, '') };
}

// 文本段 memo:按 text 引用判定,未变化的历史段整体跳过重渲染(含 markdown 解析)。
// 流式增量每次赋值新字符串,正在流的段仍正常更新。
export const AssistantText = memo(function AssistantText({ text }: { text: string }) {
  const spans: React.ReactNode[] = [];
  const parts = text.split(/(```[\s\S]*?```)/g);
  parts.forEach((part, i) => {
    if (part.startsWith('```')) {
      const { lang, code } = parseFence(part);
      spans.push(<FencedCode key={i} lang={lang} code={code} />);
    } else if (part.trim()) {
      spans.push(<div key={i} className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(part) }} />);
    }
  });
  return <>{spans}</>;
});

// 段级渲染 memo(正文/思考):历史段内容引用未变时整体跳过,长会话的流式更新、
// 输入与面板重渲染不再拖着全部消息重跑 thinking 提取与 markdown 解析;
// 正在流式更新的段(text 每次增量都是新字符串)依旧正常渲染。
export const AssistantSegment = memo(function AssistantSegment({ text }: { text: string }) {
  // dsh-ai-text:助手回复段(过程流里按 dsh 的 --dsh-chat-flow-gap 与相邻项隔 12px)
  return <div className="dsh-ai-text">{renderAssistantContent(text) || <AssistantText text={text} />}</div>;
});

export const ReasoningSegment = memo(function ReasoningSegment({ text, running }: { text: string; running?: boolean }) {
  return text && text.trim() ? <ReasoningRow text={text.trim()} running={running} /> : null;
});
