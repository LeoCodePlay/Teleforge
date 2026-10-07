# 交接:右栏(dsh 侧边栏移植)任务清单

> 本文只写**已验证的事实**与**确切下一步**,不含推测。
> 最新一轮(第二个会话)已验证:主 `tsc` 0 错、`npm run build` ✓,并在浏览器里实测了
> **文件树面板(A)**与**终端面板(C)**。

---

## 0. 环境与硬约束(先读这条,能省你几小时)

- 工作区:`F:\Dm\companyProject\自己\远程ssh工具`;平台 win32。dsh 源码仓库:`E:\RJ\DmRJ\deepseek-harness`
  (布局 `packages/<组>/<包>`,cordis 在 `vendor/cordis`)。
- **本机执行命令时 `cd` 不改变子进程 cwd**(cwd 恒为工作区)。跨目录一律用绝对路径或 `git -C`。
- **绝不要用 node 脚本直接改写源文件**(上一轮用脚本回退 `App.tsx` 把它截断成 59 行)。改动一律用
  精确编辑工具,改完立刻验证。
- 多行 `node -e "…"` 在本机 shell 里**会静默失败**(换行被吃掉,退出码仍是 0)。要么写单行脚本,
  要么把脚本落到工作区根(`_scan-deps.cjs` 这类),再 `node _scan-deps.cjs <包目录>`。
- 验证三件套(每次改完都跑):
  - `npx tsc --noEmit -p tsconfig.json` → 期望 **0**
  - `npm run build` → 期望 **✓ built**
  - 应用在 `http://127.0.0.1:4000`(后端托管 `web/dist`);预览用 `browser_open(target='preview')`
- 另有 dsh 侧沙箱检查 `npx tsc --noEmit -p tsconfig.dsh.json`(只 include `ui-dockkit` /
  `ui-sidebar-right` / `ui-dsh-adapters`)。它**不是** 0(剩余集中在 `ui-sidebar-right` 的 cordis
  插件入口 —— 我们有意不移植那层),只看它有没有**新增**。
- ⚠️ **本工作区可能同时有另一个会话在对同一份文件动手**(实测:它在 17:18 从 git 恢复
  ActivityDock/AiTermPanel/SubagentPanel、18:01 改 `App.tsx`/`App.scss`、18:05 改
  `SubagentConversation`、18:10 跑 build,并提交了 `d290a87 终极更新`)。改共享文件前**重读**、
  只做精确替换,收尾时复核 `git diff`。

---

## 1. 已完成(不要回退)

**移植树** `web/src/dsh/`(20 个包):
- 8 个 UI 包(dockkit / sidebar-right / sidebar-files / sidebar-terminal / sidebar-browser /
  sidebar-documentpreview / deliverables / primitives)——早期 xcopy **铺平**过,所以
  `web/src/dsh/<pkg>/` 里放的是原包 `src/` 内容,且**没有 package.json / lib**;
- 12 个正常包:`client-store`、`client-ui-slots`、`client-locale`、`client-shortcuts`、`session`、
  `api-remotes`、`api-workspace-files`、`typert-protocol`、`util-workspace-path`、`ui-renderer`、
  `cordis`、`cosmokit`(都带 package.json 与完整 `lib/` 产物)。

**别名体系**:`tsconfig.json` 的 `paths` + `web/vite.config.ts` 的 `DSH_ALIAS`。vite 里两个 helper:
`dsh(rel)` → `./src/dsh/<rel>`、`adapter(rel)` → `./src/dsh-adapters/<rel>`。

**产物消费策略(重要)**:`cordis` / `cosmokit` 按**构建产物**消费:
- `tsconfig.paths` → `web/src/dsh/<pkg>/lib/types/index.d.ts`(只读声明,不检查源码)
- `vite.alias` → `web/src/dsh/<pkg>/lib/index.js`
- 原因:cordis 的 TS 源码按 dsh 自己的基础配置写,进本项目严格选项会出 45 个错。任何"源码编译不过"
  的包都用这招。

**已删除**:dsh 各包自带的 `tsconfig.json` / `tsdown.config.ts`(共 20 个)。**必须删** —— esbuild 在
`web/src` 下会去解析它们(`extends: ../../../tsconfig.base.json` 不存在)→ 构建失败。

**适配层** `web/src/dsh-adapters/`(13 个):
`api-remotes`(完整 `ClientRemote` + `makeRemoteStream`)、`api-workspace-files`
(`WorkspaceDirectoryEntry` 用 `type` 不是 `kind`;`WorkspaceFileWatchFrame` 带 `kind`)、
`primitives`(按需桶)、`locale` / `shortcuts` / `session` / `brand` / `layout` / `util-crypto` /
`api-session-controller` / `sidebar-right-types` / **`api-terminal-controller`** / **`ui-theme`**
(后两个是这一轮为终端面板加的,见 §2.C)。

**右栏外壳(已实测)**:`components/RightSidebar/`
- `DockSidebar.tsx`:dockkit `DockController` + `DockSurface`,中文 `LABELS`,`makePaneTab`(标签条 `＋`)
  → `kind:'files'` 标签;`onTabClosed` 回调(标签被 ✕ 关掉时通知宿主回收会话级资源);
- `RightSidebar.tsx`:薄壳(宽度按会话持久化、默认关闭、可收起、左边缘拖宽、`key={sid}` 隔离);
- `App.tsx` 集成:`rightOpen`(默认 false)、`openInSidebar()`、右上角 `▤`、`renderBody` 分派
  (`file` / `changes-review` / `subagent` / **`files`** / **`terminal`**)、`ChatPanel` 三个回调;
- **`local:` 前缀**:`FileViewer` 用 `path.startsWith('local:')` 区分本地/远端,**本地文件必须加前缀**;
- `web/src/dsh-tokens.scss`:125 个 `--dsw-*` → Teleforge token 的桥。

**A. 文件树面板(已实测 → 按用户要求从右栏下架)** ⛔
- 实现与实测都做过(见 git 里未提交的 `FilesPanelHost.tsx` / `dsh-panel-contracts.ts`),但用户拍板
  **右栏不要文件树** —— 主区已经有「远程文件 / 本地文件」两条完整链路,重复了。
- 因此:`App.tsx` 已去掉 `files` 分支与 `FilesPanelHost` 的 import;`DockSidebar.makePaneTab` 改成开**终端**。
  `FilesPanelHost.tsx` / `TerminalPanelHost.tsx` / `RightSidebar/dsh-panel-contracts.ts` 与其两个适配
  (`dsh-adapters/api-terminal-controller`、`ui-theme`)都**留在磁盘上但已不接线**(tsc 仍覆盖它们)。
  要彻底删,把这几个文件连同 `tsconfig.json` / `vite.config.ts` 里对应的两行别名一起删掉即可。

- 新增 `components/RightSidebar/dsh-panel-contracts.ts`:**自己声明**两条 SlotMap 条目 + 两个标准包席位
  (`'sidebar.right.pane.tab'`、`'sidebar.right.tab.files.actions'`、`SessionStandardProps.sessionId`、
  `GlobalStandardProps.useSessions`),**不 import** 任何 dsh 注册层入口。
  - 放 `components/` 而不是 `dsh-adapters/` 是刻意的:`tsconfig.dsh.json` 同时 include
    `ui-sidebar-right`(它自己声明了同名槽位)与 `dsh-adapters`,放那边会撞成"同名属性类型不一致"。
- 新增 `components/RightSidebar/FilesPanelHost.tsx`:**手搓宿主 props**(方案文档 §7 的 (B) 路线)——
  `createFilesStore().create(sid)` + `useSyncExternalStore` 绑 `useStore`;`filesFace(createList, watch)`
  做数据面(`list` → `list_dir` / `list_local_dir`);`watch` 给"只吐一帧 `ready` 就结束"的空流
  (**不能**一帧都不吐:那样 `DirectoryNode.follow()` 一次循环都不进,根目录永不列举);
  `openResource` 用 `parseFileAddress` + `resolveWorkspacePath` 解回绝对路径再回给宿主。
- `DockSidebar` 的 `makePaneTab` 去掉 `as never`,按 `TabFactory` 收紧;`contentId` 用标签自己的 id。
- `App.tsx`:新增 `sidebarSid` / `sidebarLocal` / `sidebarCwd` / `openSidebarFile`,renderBody 加 `files` 分支。

**C. 终端面板(最终形态:右栏直接复用主区的 `ConsolePanel`)** ✅
- 用户拍板:「终端的话,可以直接将 ai 助手旁边的那个终端搬过去。显示远程和本地的终端可以使用。」
  —— 所以**不用** dsh 版 `TerminalBody`(它一条标签只跟一个 shell,拿不到"远程 + 本地两个终端"),
  右栏直接渲染主区那个 `ConsolePanel`。
- 为窄容器加了一个开关:`ConsolePanel` 新增 `compact?: boolean`。**右栏里那条终端列表默认折叠**
  (不占宽度),工具栏上一个「☰ 终端列表 ◂」开关展开它,展开后就是主区那套布局 —— 点条目切换、
  右键重命名/删除、＋远程/＋本地;折叠态下隐藏列表自带的拖拽手柄(窄栏里拖宽没意义)。
  触屏(粗指针)走**另一套**:列表整条不渲染,用工具栏的「⌨ 终端 ▾」下拉切换器 —— 右栏的抽屉开关
  只在 `compact && !coarse` 时渲染。
- 顺手补了两处必要的:`ConsolePanel.scss` 的 `.consolewrap` 加 `height:100%`(右栏里 dockkit 的面板正文是
  `display:block`,只写 `flex:1` 会让容器缩到工具栏的 71px、**终端高度塌成 0** —— 表现是"点快捷命令没反应",
  实际是根本没渲染);以及卸载时 `disposeSession` 掉本实例全部会话(右栏终端是**可关闭标签**,关掉就卸载,
  不回收会留下 WS 和它背后的 shell;主区那份常驻挂载,永远走不到这条路径)。
- 下面这段是**旧实现**,已不接线,保留备查(想要回 dsh 原版终端时看这里):

- 新增适配 `dsh-adapters/api-terminal-controller/index.ts`(类型面:`WebTerminalId` / `TerminalShell` /
  `TerminalEnvironment` / `WebTerminalInfo` / `TerminalFrame` / `TerminalRenderFrame` /
  `TerminalViewIssue` / `TerminalViewState` / `TerminalView`)。
- 新增适配 `dsh-adapters/ui-theme/index.ts`(只给 `ThemeSnapshot`:面板只用它当"重新取色"的依赖,
  真颜色是从 xterm 容器的 computed style 读的)。
- 新增 `components/RightSidebar/TerminalPanelHost.tsx`:
  - `SidebarTerminalModel implements TerminalView` —— 接本项目**既有的** `/ws/term` 通道
    (`server/core/ws.ts:233`;上行二进制=键盘输入,上行 JSON=`start{type,mode,cols,rows}` /
    `resize` / `kill`;下行二进制=shell 输出,下行 JSON=`ready` / `exit` / `error`)。协议与
    `components/ConsolePanel/ConsolePanel.tsx` 完全一致。
  - **必须有 `environment`**:`terminal.tsx` 的 `fitScreen()` 在 `environment === undefined` 时直接 return,
    终端永远不会被 resize。
  - **同一时刻只让一帧在等 ack**(`pending` + 队列):dsh 有流控,我们的 WS 没有;直接连发会让后一帧
    覆盖前一帧 → 丢输出。
  - 模型按 `sid::tabId` 缓存,标签被关掉时由 `DockSidebar.onTabClosed` → `disposeSidebarTerminal` 回收
    (发 `kill` 再断开)。
  - 主题给静态快照:换主题不会实时换终端的色(要 remount),已在注释里说明。
- `RightSidebar.scss` 把 `.rsb-collapse` 的规则扩到 `.rsb-term`;`App.tsx` 加 `⌨` 按钮(右栏标签条末端)
  + `terminal` 分支 + `onTabClosed`。

**H. ActivityDock / 子代理抽屉(已完成)** ✅
- 那 3 个文件(`ActivityDock.tsx/.scss`、`AiTermPanel`、`SubagentPanel`)已由另一个会话从 git 恢复并接回
  `App.tsx`(含 `SessionHeader`、`renderBody` 的 `subagent` 分支)。**不要再删**。

---

## 2. 未完成(逐项:目标 → 现状 → 确切下一步)

### B. 文档预览面板(建议最后一个做:前置缺口最多)
- **目标**:右栏打开文件时用 dsh 的 `ui-sidebar-documentpreview`(代码 / markdown / 图片 / PDF / Excel)。
- **现状**:包已搬(`web/src/dsh/ui-sidebar-documentpreview`,源码副本、无 lib)。
- **这一轮查明的好消息**:`client/TextPreview.tsx`(调度壳)**本身很轻** —— 它只 import
  `face.ts` / `failure-line.ts` / `LoadingIndicator` / `rpc.ts` / `store.ts` / `document/*` / `text/*`,
  **不**直接拖 pdf/excel/office。重依赖是各分支的**注册**处(插件入口)才拉。
- **坏消息(三个硬前置,必须先补)**:
  1. `client/code/CodeBody.tsx` → `ui-primitives` 的 `CodeBlock` → `markdown/highlight.ts` →
     **`@deepseek-ai/dsh-util-code-language`**:这个包**没搬进来**,`tsconfig.paths` 里也没有 → 代码分支
     现在编不过。要么搬它,要么给一个等价适配。
  2. `client/face.ts` → **`@deepseek-ai/dsh-client-resources/client`**(`Resources` 类型)+
     `client/document/resource-group.ts` → 该适配不存在。TextPreview 的注入面绕不开它。
  3. `client/markdown/MarkdownBody.tsx` → `ui-primitives` 的 `MarkdownText` → **katex / micromark**,
     这些依赖**没装**,而 `dsh-adapters/primitives/index.tsx` 是"按需桶"、**故意没引** markdown。
  4. PDF / Excel 分支还要 `pdfjs-dist`、`xlsx`、`exceljs`、`fortune-sheet`、`dompurify`、
     `fast-xml-parser`、`fflate`、`papaparse`、`yaml`(均未装),以及 `dsh-office-to-pdf`、
     `dsh-host-webserver`、`dsh-api-gateway/client`、`dsh-ui-settings/client` 等未搬的包。
- **确切下一步(最小可交付)**:先只接 **text(纯文本)+ code** 两个分支:补 `dsh-util-code-language`
  (搬包或适配)+ `dsh-client-resources` 适配 + 在按需桶里加 `CodeBlock / languageForPath`,然后照 A/C
  的套路写 `DocumentPanelHost`(手搓 `view`/store/face/registry)。markdown 分支等依赖决策(装 katex 还是砍掉)。

### D. 浏览器面板
- **目标**:右栏浏览器标签用 dsh 的 `ui-sidebar-browser`。
- **现状**:包已搬。依赖面(已扫):
  `@deepseek-ai/dsh-api-workspace-controller/client`(**未适配**,要新写)、`dsh-brand`(有)、
  `dsh-client-locale/client`(有)、`dsh-client-shortcuts/client`(有)、`dsh-client-ui-dockkit`(有)、
  `dsh-client-ui-primitives`(按需桶)、`dsh-client-ui-renderer/client`(有)、`dsh-client-ui-session/client`、
  `dsh-client-ui-sidebar-right/client`(有适配)、`dsh-client-ui-slots`(有)、`react`。
- **确切下一步**:①先补 `api-workspace-controller` 类型面;②照 A/C 套路写 `BrowserPanelHost`
  (dsh 的 `BrowserController` 驱动 iframe/原生);③**别与主区浏览器标签链路混** ——
  主区那条是 `components/BrowserPanel` + `utils/preview.ts` + 服务端 `core/browser-manager.ts` 的
  `/ws/browser` 独占归属模型,右侧栏这条要么走同一个后端(需要处理"一个预览只能被一个会话独占"),
  要么明确只做 iframe 预览。先想清楚归属再动手。

### E. diff 面板换成 dsh 原件
- **目标**:把自写的 `components/ChangesReview/ReviewTab` 换成 dsh 的 `ui-deliverables`
  (`ReviewTab` + `FileDiff`)。
- **现状**:`ui-deliverables` 已搬(源码副本);自写版**可用**(测试 76 项通过,`web/src/utils/shiki.ts`
  双主题高亮也在)。dsh 版的 `ReviewTab` 还需要
  `dsh-client-resources/client`(同 B 的前置缺口)与 `dsh-workspace-changes/types`(已别名到 ui-deliverables)。
- **注意**:用户明确说过「**文件列表打开的代码编辑器**」与「**会话里的文件改动对比**」是**两条不同链路**,
  不要合并。

### F. 布局持久化 / 恢复(已完成 ✅,浏览器实测两次整页刷新都能恢复)
- **做法**:存的是 dockkit 的**操作序列**(`LayoutOp[]`,纯数据、每条操作自带它创建的 id),不是布局树 ——
  在同样的初始状态上重放能逐字还原同一棵树(分屏 / 浮动窗 / 标签归属都在里面),而布局树是不可变的内部形状。
  - `ui-dockkit/engine/controller.ts`:`DockControllerOptions` 新增 `restoreOps?: readonly LayoutOp[]`;
    内部 `restoreSequence()` 先按 **0 号种子**建初始状态(序列里写的是 `pane1`,种子不是 0 就会整段判无效),
    再用 `Sequencer.dispatch` 逐条重放(重放**不铸 id**,所以计数还停在 1),最后 `minter.advanceTo(最大号)`
    —— 否则下一次新意图会发出一个已存在的 id。整段重放中任一条无效就整体放弃,并且**换一个干净的 0 号
    minter** 重建初态(否则失败态里那个 `pane2` 会被写进后续操作,下次重放照样失败,永久卡死)。
  - `ui-dockkit/engine/initial.ts`:`IdMinter` 新增 `advanceTo(value)`(只前推)。
  - `components/RightSidebar/DockSidebar.tsx`:新增 `restore` / `onLayoutChange`;每次布局变化把
    `controller.ops` 交回宿主。给了 restore 却得到空序列(= 被判无效)时**跳过第一次上报**,
    不把盘上的旧布局反手覆盖成空。
  - `components/RightSidebar/RightSidebar.tsx`:`teleforge.sidebar-right.layout.v1.<sid>` 按会话存取;
    读盘放在函数体开头(必须在 `if (collapsed) return null` **之前** —— 那是 hook,放后面会让折叠/展开
    两次渲染的 hook 数量不一样,React 直接抛错整页崩,这个坑本轮实际踩到了)。
- **注意**:恢复的是**布局**,不是进程。`terminal` 标签恢复出来是一条新 shell(WS 通道随页面卸载就没了);
  `file` 标签恢复出来会照常重新读文件。


### G. 自动化任务(最大一块,独立于 dsh)
- **方案已写好**:`docs/plan-automation-and-changes-review.md`(数据模型 / 6 种调度 / 时间纯函数含 DST 与
  "错过只补最近一次" / 存储 / 30s 调度器 / 4 个模型工具 / RPC / 入口 / 任务页面 / 会话内三处集成)。
- **已拍板的决策**:①入口放**左栏顶部新增一行**;②到点但服务器未连接 → **等待重连最多 5 分钟**,超时记 missed。
- **现状(2026-10-08 更新)**:服务端已**逐字迁移 dsh**(`server/schedule/dsh/` 原样搬运 domain/runtime/
  storage/update/delivery-history + Teleforge 侧的 `service.ts`/`delivery.ts`/`store.ts`/`holder.ts`),
  并跑 **dsh 自己的 414 项 spec** 作证;RPC = list/catalog/history/update/delete(+ 本项目特有的 preview);
  **没有** create/toggle/run_now(新建交给模型,暂停/立即执行 dsh 本就没有)。
  入口 = 标签条固定标签「🕘 自动化任务」(在「⌨️ 终端」右边)。**详细对照与未迁清单见
  `docs/handoff-schedule-migration.md`**;下面这段是旧版本记录,已废弃。
  - 服务端:`server/schedule/{types,time,store,runtime,service}.ts`、`server/api/rpc/schedule.ts`(8 个 RPC)、
    `server/agent/schedule-tools.ts`(4 个模型工具,agent.ts 里注册);调度器在 `server/index.ts` 的 `startApp` 启动。
  - 前端:`web/src/components/SchedulePanel/`(列表 / 详情 / 6 种规则编辑器 / 运行记录)、`App.tsx` 主区固定标签
    「🕘 自动化任务」(在「⌨️ 终端」右边;左上角不放按钮)、`BottomBar` 的「自动化」项。
  - 测试:`test/schedule.test.js`(122 项断言,含 DST / 错过只补最近一次 / 等 5 分钟 / skipped / 真实投递链路 / 模型工具),
    已加入 `npm test` 链;`test/rpc-registry.test.js` 的 GOLDEN 与 `test/tool-access.test.js` 同步更新。
  - 另附:`agent.ensureRuntime()`(定时投递不切换用户正在看的会话)、`agent.submit` 的 `source`/`taskId` 选项。
- **还没做**:会话头时钟胶囊、会话列表行时钟标记、对话内创建卡片(`schedule_create` 工具结果目前走 `GenericToolCard`)、
  右栏「任务详情」tab(方案 §3.8/§3.9)。

---

## 3. 面板宿主需要的类型事实(逐字来自源码)

```ts
// ui-sidebar-files/client/FilesBody.tsx
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.files.actions'>
  & PropsStore<ReturnType<typeof createFilesStore>>
  & FilesInjected
  & PropsLocale<'sidebarFiles'>

// ui-sidebar-terminal/client/terminal.tsx
export type TerminalBodyProps =
  PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'sidebarTerminal'> & InjectFace<TerminalBodyInjected>
// TerminalBodyInjected = { view(key): TerminalView; keyedHooks: { terminal(key): HostObservable<TerminalViewState> };
//                          hooks: { theme: HostObservable<ThemeSnapshot> } }
// 面板用到 tab 的:id / visible / signal / actions.bindCommands / actions.openResource / actions.openTab
//   → 宿主的 PanelTabInfo 必须同时给出这些(见 components/RightSidebar/dsh-panel-contracts.ts)
```

```ts
// client-store 的真实 API(web/src/dsh/client-store/src/)
export interface StoreSpec<T, A> { init: () => T; persist?: string; actions: A }
export interface StoreInstance<T, A> { readonly actions: BakedActions<T, A>; getSnapshot(): T;
  subscribe(fn: () => void): () => void; clearPersisted(): void }
export interface StoreHandle<T, A> { readonly spec: StoreSpec<T, A>; create(scopeKey?: string): StoreInstance<T, A> }
export function defineStore<T, A>(spec): EngineStoreHandle<T, A>
export function createSnapshotStore<T>(initial: T, options?: { persist?: { name: string } }): SnapshotStore<T>
export function shallowEqual(a: unknown, b: unknown): boolean
// StoreInstance 是 **React-free** 的(没有 useStore)→ 宿主用 useSyncExternalStore 自己绑。
```

```ts
// PropsStore<H> 推出来的两个属性:useStore(选择器 hook)+ actions(baked 写集)
// PropsRenderSlots<S>:若 S 的作用域是 session,还会**强制要求**传 SessionProvider(宿主给个透传壳即可)
// SlotRendererHost 有 18 个成员;SlotCore 只提供一半:
//   有:subscribe / getVersion / entriesOfSlot / entries / isLive / reportEntryError / reportFactoryError /
//       subscribeFactory / isFactoryLive / register / onMutate
//   缺:entriesOf / factoryOf / getFactoryVersion / specOf / storeOf / factoryStoreOf /
//       retainFactoryOccurrence / root / scopeRevision / scope(scope) / locale
// createSlotRenderer() 在 ui-renderer/src/client/scoped-slots.tsx:1311 → { renderRoot(host, ownerProps) }
// 我们**不走**这条路:走的是"手搓宿主 props"(docs/plan-files-panel-wiring.md §7 的 (B))。
```

---

## 4. 踩过的坑(别再踩)

1. **`cd` 不生效** → 用绝对路径 / `git -C`。
2. **不要用脚本改源文件**(上一轮把 `App.tsx` 截断过)。
3. **`import` dsh 插件入口 = 拖进注册层**(`ui-sidebar-*/client/index.ts` 会带 `definition.tsx` / 注册样板,
   实测 25 错)。直接 import 具体文件(`client/FilesBody.tsx`、`client/store.ts`、`client/face.ts` …)。
4. **移植的 TS 不要进应用编译程序**:要么按产物消费(lib),要么自己声明类型。
5. **dsh 包自带的 `tsconfig.json` 会让 esbuild 构建失败**,必须删。
6. **JSX 属性之间不能写 `{/* … */}`**(只允许 `{...spread}`);注释写进表达式或放元素上方。
7. 面板是 **slot 注册体**,不是能直接渲染的组件;`useTabInfo`/`useSessions`/`renderSlot`/`t` 都由 slot 运行时供给。
8. 右栏里打开**本地文件**必须带 `local:` 前缀。
9. **多行 `node -e` 在本机 shell 会静默失败**(退出码 0、无输出)—— 别被它骗了,写成单行或落文件。
10. **`getSnapshot` 缓存**:给 `useSyncExternalStore` 的选择器结果要在 `useRef` 里按 `Object.is`/`shallowEqual`
    缓存,否则 React 报"getSnapshot should be cached"。写 `if (cached !== null && same) return cached.value`
    而不是 `if (!same) cache.current = …; return cache.current.value`(后者 TS 会报可能为 null)。
11. **`watch` 空流不能"一帧都不吐"**(文件树的根目录就永远不会列举),也不能永远挂着(会让
    `DirectoryNode.close()` 永久 await)—— 正确做法是 `yield 'ready'` 之后结束。
12. **`position: fixed` 的弹层要 portal 到 `body`**。任何祖先只要带 `backdrop-filter` / `transform` /
    `filter`,就会成为 fixed 后代的**包含块** —— 于是 `left: clientX` 变成"相对那个祖先"的坐标。
    ConsolePanel 的右键菜单(.term-menu)原来挂在 `.console-main` 里,主区看着正常(祖先原点≈0),
    但右栏那层玻璃底把菜单推到视口坐标 1702(点其实在 573),再被 `overflow:hidden` 剪掉 →
    **右栏右键"没反应"**。改成 `createPortal(..., document.body)` 后点在哪就在哪,两边都对。
    排查这类问题的快招:比较 `getBoundingClientRect()` 与 `clientX` 的差值,差多少就是祖先原点的偏移。

---

## 5. 常用命令与文件索引

```bash
# 扫某个 dsh 包的外部依赖面(搬之前先跑)—— 脚本已落在工作区根
node _scan-deps.cjs web/src/dsh/ui-sidebar-documentpreview

# 在 dsh 仓库里按包名定位源码目录
node -e "const fs=require('fs');const B='E:/RJ/DmRJ/deepseek-harness';const walk=(d,dep)=>{if(dep>3)return;for(const e of fs.readdirSync(d,{withFileTypes:true})){if(!e.isDirectory()||e.name==='node_modules')continue;const q=d+'/'+e.name,pj=q+'/package.json';if(fs.existsSync(pj)){try{const n=JSON.parse(fs.readFileSync(pj,'utf8')).name;if(n.includes('terminal-controller'))console.log(q)}catch{}}walk(q,dep+1)}};walk(B+'/packages',0)"
```

| 作用 | 路径 |
|---|---|
| 右栏宿主(dockkit 直驱) | `web/src/components/RightSidebar/DockSidebar.tsx` |
| 右栏薄壳 / 样式 | `web/src/components/RightSidebar/RightSidebar.tsx` / `.scss` |
| **面板类型契约(槽位声明)** | `web/src/components/RightSidebar/dsh-panel-contracts.ts` |
| **文件树面板宿主** | `web/src/components/RightSidebar/FilesPanelHost.tsx` |
| **终端面板宿主 + 模型** | `web/src/components/RightSidebar/TerminalPanelHost.tsx` |
| App 集成 | `web/src/App.tsx`(`rightOpen` / `openInSidebar` / `openSidebarFile` / `openSidebarTerminal` / `▤` / `renderBody` / `onTabClosed` / `chrome`) |
| 既有终端通道(协议来源) | `web/src/components/ConsolePanel/ConsolePanel.tsx` + `server/core/ws.ts:233` |
| dsh token 桥 | `web/src/dsh-tokens.scss` |
| 别名 | `tsconfig.json`(paths)/ `web/vite.config.ts`(DSH_ALIAS / dsh() / adapter()) |
| 接线方案(A 的部分已过时,§7 仍有效) | `docs/plan-files-panel-wiring.md` |
| 自动化任务方案 | `docs/plan-automation-and-changes-review.md` |
