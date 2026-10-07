# 任务:子代理会话的工具调用,对齐主对话的渲染链路

## 用户原话

> 子代理的对话页面的工具调用也要跟主对话的工具调用链路显示一样啊!!该折叠折叠,该分组分组

## 已查清的事实(不要重复排查)

**工具卡片本身已经是同一套**:
- `components/ToolCallList/ToolCallList.tsx` —— 平铺工具调用,内部 `GenericToolCard` → `ToolRow`(用 `DisclosureRow` 折叠)+ `components/toolviews/*` 分派(Read/Search/Diff/Terminal/Subagent/Todo/WebSearch/Browser/AskQuestion/Skill…)
- `utils/toolRowModel.ts` —— `toolRowModel(call)` 做 variant/图标/摘要派生
- 子代理侧 `components/SubagentConversation/conversation.tsx:87` **已经在用** `<ToolCallList tools={seg.tools || []} />`
- 旧的 `components/SubagentPanel/SubagentPanel.tsx:102` 也是同一写法(该组件现在已不被 App 引用)

**所以差异在"调用点",不在组件**。主对话的调用点(`components/ChatPanel/ChatPanel.tsx:2644-2660`)是这样的:

```tsx
<ProcessGroup collapsed={groupedFor(TRANSCRIPT_MODE, !!m.streaming)}>   {/* ← 分组/折叠容器 */}
  {u.memberIndexes.map((si) => {
    const seg = segs[si];
    if (!seg) return null;
    if (seg.kind === 'tools') {
      return (
        <ToolCallList key={si} tools={seg.tools || []}
          workspace={(connected ? workspace : localWorkspace) ?? undefined}   {/* ← 相对路径靠它 */}
          onOpenSubagent={onOpenSubagent} onOpenImage={setLightbox} />        {/* ← 行内动作 */}
      );
    }
    // 思考段:折叠展示(照搬 dsh 的 ReasoningRow);流式时仅最后一段标记 running
    return <ReasoningSegment key={si} text={seg.text || ''}
      running={m.streaming && si === segs.length - 1} />;
  })}
</ProcessGroup>
```

对照 `components/SubagentConversation/conversation.tsx` 的同位置(第 87 行附近),它的差别就是**少了三件事**:

1. 没有 `ProcessGroup` 包住「思考 + 工具调用」这一组(所以该分组的地方没分组、该折叠的地方没折叠);
2. `ToolCallList` 没传 `workspace`(所以工具行里的路径是绝对路径,不与主对话一致);
3. 没传 `onOpenSubagent` / `onOpenImage`(工具行上的动作点不了)。

## 要做的

改 `components/SubagentConversation/conversation.tsx`,把它的分段渲染**逐字对齐** `ChatPanel.tsx:2644-2660`:

1. import 主对话用的同一批: `ProcessGroup`、`ReasoningSegment`(路径同 ChatPanel 的 import);
2. 用 `<ProcessGroup collapsed={…}>` 包住 `u.memberIndexes.map(...)` 的整段;
3. 工具段传 `workspace={…}`(子代理没有 connected 概念 → 直接用会话的 cwd/工作区;由宿主把 `workspace` 传进 `SubagentConversation` → `conversation`。App 里有 `status.workspace` / `status.localWorkspace` 可取);
4. 思考段改用 `<ReasoningSegment text running />`(主对话同款),而不是本地自写样式;
5. `onOpenSubagent` / `onOpenImage` 若子代理场景没有对应能力,就按主对话的语义接上(App 的 `openSubagentPanel` 与 lightbox)。

> `groupedFor(TRANSCRIPT_MODE, !!m.streaming)` 的判定也照抄;子代理的 `run.messages` 与主对话的 `messages` 结构一致(都用 `Conversation` 渲染),所以这一段可直接复用。

## 验收

- 子代理会话里连续的工具调用出现与主对话**完全一致**的分组/折叠行(24px 折叠态、14px 标题、chevron 展开);
- 工具行里的文件路径是**相对路径**(与主对话一致);
- 工具行上的动作(打开子代理/看图片)可用;
- `npx tsc --noEmit -p tsconfig.json` = 0、`npm run build` ✓、浏览器目视对比主对话与子代理对话的同一段。

## 注意

- 不要新建第三份渲染实现 —— 目标就是**共用同一套**;
- 改完立刻跑 tsc + build(本仓库有历史事故:曾用脚本改文件导致截断,一律用精确编辑);
- 目前 `web/src/components/RightSidebar/FilesPanelHost.tsx` 还有 2 个 tsc 错误(`cache.current` 空判、缺 `SessionProvider`),与本任务无关,但会让 `tsc` 不为 0。
