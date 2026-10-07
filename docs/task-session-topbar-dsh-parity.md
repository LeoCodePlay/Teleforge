# 任务:顶部栏对齐 deepseek-harness(子智能体 / 后台运行任务)

> **交给正在做 dsh 移植的那个会话**(它已持有所需上下文)。
> 不要与本会话同时改 `web/src/App.tsx`、`web/src/components/RightSidebar/*`。

## 用户原话(需求原文,别走样)

> 子智能体打开后,不是会直接跳转到对话页面替换吗?!?!?不是打开侧边栏!!!
> 右上角的呈现方式也不要了!!而是直接对齐 deepseek-harness 的顶部栏
> 的呈现子智能体、后台运行任务的方式以及布局和交互!!!!

拆成三条:

1. **点子智能体 = 主对话区直接替换**成该子智能体的会话视图(**不是**打开右栏);
2. **去掉右上角那套呈现**(即 `ActivityDock` 的「悬浮胶囊 + 右侧抽屉」形态);
3. **顶部栏**改为 dsh 的样子来呈现 **子智能体** 与 **后台运行任务**(布局与交互都对齐 dsh)。

## 现状(本会话已核实的事实)

- 顶部现在是两个东西叠着:
  - `components/SessionHeader/SessionHeader.tsx` —— 标题面包屑 + 子智能体 catalog(`useSubagentRuns(sid)`);props:`sid / sessionTitle / openRunId / onOpenSubagent / onOpenSubagentAside / onBackToSession`。**这份就是 dsh 形态的雏形**;
  - `components/ActivityDock/ActivityDock.tsx` —— 悬浮胶囊 + 右侧抽屉(props:`active / sid / subagentRunId / onOpenSubagent / onCloseSubagent`)。**用户要去掉的就是它**。
- App.tsx 里的接线(本会话刚恢复的,位置约 1390 行附近):
  ```tsx
  <SessionHeader … onOpenSubagent={openSubagentPanel}
     onOpenSubagentAside={(runId, title) => openInSidebar('subagent', runId, title)}
     onBackToSession={() => setSubagentRunId(null)} />
  <ActivityDock active={effActiveTabId === 'agent'} sid={…} subagentRunId={subagentRunId}
     onOpenSubagent={openSubagentPanel} onCloseSubagent={closeSubagentPanel} />
  ```
- **子智能体走侧栏的那条路**就是 `onOpenSubagentAside` —— 按需求 1,它不该再进侧栏;`renderBody` 里的 `subagent` 分支(`SubagentConversation`)也就随之可去(或保留但不再被调用)。
- 后台运行任务的数据源:`hooks/useRunningTermSessions`(**App 已 import**),`ActivityDock` 内部也用它;`.tabstrip` 区域是另一个可能落点。
- `ChatPanel` 的 props 里已有 `onOpenSubagent`(见 `ChatPanel.tsx` 的 `ChatPanelProps`),所以"主区替换"这条路 App 已有现成开关:`subagentRunId` + `openSubagentPanel(runId)`。

## 要做的(建议顺序)

1. **确认主区替换链路**:`openSubagentPanel(runId)` → `subagentRunId` 设置后,主区应渲染 `components/SubagentConversation/SubagentConversation.tsx`(不是 ChatPanel)。若现在不是,先接这一条 —— 这是需求 1 的核心。
2. **去掉 `ActivityDock`**:App 里删掉它的 import 与 JSX(文件先别删,等确认无引用;`AiTermPanel`/`SubagentPanel` 由它引用,之前被误删过,是 `git checkout HEAD -- web/src/components/{ActivityDock,AiTermPanel,SubagentPanel}` 恢复回来的)。
3. **顶部栏对齐 dsh**:读 dsh 源码里顶部栏的实现再照做 —— 起点建议:
   - `E:\RJ\DmRJ\deepseek-harness\packages\client\ui-session-header\`(若存在)
   - 或 `packages/client/ui-sidebar-right/src/client/session-view.ts` / `shell/RightbarRoot.tsx`(会话头那部分)
   - 关键词:`subagent`、`background`、`catalog`、`running`、`SessionHeader`
   把它呈现「子智能体 + 后台运行任务」的**结构/间距/交互**搬过来(本项目的运输方式见 `docs/handoff-sidebar-remaining.md` §1:别名 + 产物消费 + 适配层)。
4. **子智能体行的交互**:行点击 → 主区替换;行尾按钮若 dsh 有别的语义按 dsh 来,但**不要**再开右栏。

## 验收

- 点子智能体行 → 主对话区**变成**该子智能体的会话(不出现右栏);
- 界面里**找不到**右上角悬浮胶囊/抽屉;
- 顶部栏能看到:标题面包屑、子智能体列表(数量)、后台运行任务,且排布与 dsh 一致;
- `npx tsc --noEmit -p tsconfig.json` = 0、`npm run build` ✓、`:4000` 目视确认。

## 已知坑(务必先读)

见 `docs/handoff-sidebar-remaining.md` §0 与 §4:命令里 `cd` 不生效、**不要用脚本改源文件**(本会话曾把 App.tsx 截断)、JSX 属性之间不能写 `{/* */}`、移植的 TS 不要进应用编译程序。
