// @deepseek-ai/dsh-client-ui-primitives 的**按需桶**。
//
// 为什么不全量转发(`export * from '../../../dsh/ui-primitives/index.ts'`):
// ui-primitives 的总入口会把 markdown 渲染(要 katex / micromark / mdast)、终端 ANSI(要 anser)、
// office 预览(要 fortune-sheet / xlsx)整条依赖链拉进类型检查 —— 而**侧栏外壳**根本不用它们。
// 这里从 dsh 的原件里逐个挑出侧栏用得到的符号(原件仍是 dsh 的代码,我们只挑入口)。
//
// 约定:**每移植一个面板,就把它用到的符号补到这里**;补到某个面板确实需要 markdown/office 时,
// 再决定是装齐那些依赖,还是把该分支砍掉(记进方案文档)。
export * from '../../dsh/ui-primitives/icons/index.tsx';
export * from '../../dsh/ui-primitives/Tooltip.tsx';
export * from '../../dsh/ui-primitives/MenuSurface.tsx';
export * from '../../dsh/ui-primitives/Menu.tsx';
export * from '../../dsh/ui-primitives/Button.tsx';
export * from '../../dsh/ui-primitives/focus.ts';
export * from '../../dsh/ui-primitives/keyboard-composition.ts';
// 文件树面板要的三个:FileTypeIcon(+classifyFileType/fileExtension)、PathLabel
export * from '../../dsh/ui-primitives/FileTypeIcon.tsx';
export * from '../../dsh/ui-primitives/PathLabel.tsx';
export * from '../../dsh/ui-primitives/Modal.tsx';
export * from '../../dsh/ui-primitives/useModalLayer.ts';
// ---- 会话头部弹层(子智能体 catalog / 后台任务)用到的原件 ----
// StateDot:状态点(含 idle);TerminalBlock:后台任务的实时输出块(ansi 解析自带,不拉 markdown/office);
// useDismissOnOutsidePointer:点外部关闭。这些同样只是「挑入口」,原件仍是 dsh 的代码。
export * from '../../dsh/ui-primitives/StateDot.tsx';
export * from '../../dsh/ui-primitives/Pill.tsx';
export * from '../../dsh/ui-primitives/TerminalBlock.tsx';
export * from '../../dsh/ui-primitives/useDismissOnOutsidePointer.ts';
// ---- 过程分组(工具调用折叠行)用到的原件 ----
// TextShimmer:harness 行内文字的扫光动画(分组标题运行中就靠它),原件一字不改。
export * from '../../dsh/ui-primitives/TextShimmer.tsx';
// ---- 文档预览面板(右栏)用到的原件 ----
// CodeBlock:dsh 唯一的语法高亮渲染器(同步 shiki 核心 + CSS 变量主题 + 行号槽 + 折行 + 复制),
// languageForPath:按扩展名给语法提示。补这两个会把 ui-primitives/markdown/highlight.ts 的 shiki 链
// 拉进编译程序与打包图 —— 这是刻意的:预览面板就是要有高亮。语法表来自搬进来的 dsh-util-code-language。
export { CodeBlock } from '../../dsh/ui-primitives/markdown/CodeBlock.tsx';
export type { CodeBlockProps } from '../../dsh/ui-primitives/markdown/CodeBlock.tsx';
export { CODE_HIGHLIGHT_EXTENSIONS, languageForPath, useCodeHighlighter } from '../../dsh/ui-primitives/code-highlighting.ts';
