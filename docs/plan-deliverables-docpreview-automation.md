# 接线方案:B(dsh 文档预览)/ E(dsh diff 原件)/ G(自动化任务)

> 这份文档只写**已查清的事实**与**确切的下一步**,来源是逐字读源码(不是推测)。
> 产生它的那一轮上下文已接近上限,所以只做到「扫清契约」,没有动代码 —— 免得把现在
> **能用的**自写 ReviewTab 换成半成品。

---

## E. 把右栏 `changes-review` 的正文换成 dsh 的 `ui-deliverables` 原件

### E.1 要渲染的组件与它的 props(逐字)

```ts
// web/src/dsh/ui-deliverables/client/ReviewTab.tsx
export type ReviewTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsStore<ReturnType<typeof createReviewStore>>
  & InjectFace<ReviewInjected> & PropsLocale<typeof NS> & PropsRenderSlots<'deliverables.review.file.actions'>

// 同文件,ReviewInjected 就在这里定义(index.ts 只是 import 它,不 re-export —— 别从 index 取)
export interface ReviewInjected {
  hooks: {
    changesSummary: ObservableSnapshot<ReturnType<ChangesSummaryStore['state']['getSnapshot']>>
    changesDiff: ObservableSnapshot<ReturnType<ChangesDiffStore['state']['getSnapshot']>>
    presentedOpen: ObservableSnapshot<ReturnType<PresentedOpenController['state']['getSnapshot']>>
    presentedHost: ObservableSnapshot<ReturnType<PresentedOpenController['host']['getSnapshot']>>
  }
  loadChangesSummary: ChangesSummaryStore['load']
  loadChangesDiff: ChangesDiffStore['load']
  reloadPresentedHost: PresentedOpenController['loadHost']
  openChanged: PresentedOpenController['openChanged']
}
```

函数体真正用到的 props(15 个):`useTabInfo` / `sessionId` / `useSessions` / `useStore` / `actions` /
`useChangesSummary` / `useChangesDiff` / `usePresentedOpen` / `usePresentedHost` /
`loadChangesSummary` / `loadChangesDiff` / `reloadPresentedHost` / `openChanged` / `t` / `renderSlot`。
(`SessionProvider` 类型上必填、函数体不用 → 给个透传壳。)

### E.2 三处必须补的东西

1. **`PanelTabInfo` 缺 `navigation`**(`ReviewTab` 读 `tab.navigation.revision` 与 `tab.navigation.params.index`):
   ```ts
   readonly navigation: { readonly revision: number; readonly params: { readonly index?: number } | undefined }
   ```
   宿主里 `revision` 每次「在侧栏打开同一个 contentId」时 +1(`openInSidebar` 的 nonce 正好是这个语义)。
   `params` 由打开方给(App 里的 `openInSidebar('changes-review', path, title)` 没有 index → undefined)。
2. **`tab.contentId` 必须是 review 地址**:`ReviewTab` 第 75 行 `parseChangesReviewAddress(tab.contentId)`,
   解析不出来就 **throw**。现在 App 传的是文件路径 → 要改成
   `changesReviewAddress(...)` 产出的地址(App 侧构造,内容用 `ui-deliverables/changes.ts` 里的构造器)。
3. **`@deepseek-ai/dsh-workspace-changes/types` 这个模块说明符现在没别名**(`ReviewTab.tsx:15`、
   `FileDiff.tsx:7` 都在用)。`ui-deliverables/changes.ts` 就是它的实体,所以要在这两处补:
   - `tsconfig.json` 的 `paths`:`"@deepseek-ai/dsh-workspace-changes/types": ["web/src/dsh/ui-deliverables/changes.ts"]`
   - `web/vite.config.ts` 的 `DSH_ALIAS`:`{ find: '@deepseek-ai/dsh-workspace-changes/types', replacement: dsh('ui-deliverables/changes.ts') }`
   ⚠️ 现有那条 `{ find: '@deepseek-ai/dsh-workspace-changes', replacement: dsh('ui-deliverables') }` 是**前缀匹配**,
   会先把 `/types` 吃掉换成 `<abs>/ui-deliverables/types`(不存在)→ 必须把带 `/types` 的那条**放在前面**。

### E.3 数据面(最费工的一块)

`ui-deliverables` 自己带了 `client/changes-summary.ts` / `client/changes-diff.ts` / `client/present-open.ts`
三个 store,它们是**按 URL 建索引**的(`Record<string, State | undefined>`,键 = `changesSummaryUrl(sessionId, seq)` 等):

```ts
useChangesSummary: <S>(sel: (s: Record<string, ChangesSummaryState | undefined>) => S, eq?) => S
useChangesDiff:    <S>(sel: (s: Record<string, ChangesDiffState | undefined>) => S, eq?) => S
usePresentedOpen:  <S>(sel: (s: Record<string, PresentedOpenPhase | undefined>) => S, eq?) => S
usePresentedHost:  <S>(sel: (s: PresentedHost | 'error' | null) => S, eq?) => S
```

宿主要做的是:**把这三个 store 的 `load*` 接到 Teleforge 自己的数据源**(`server/api/rpc/changes.ts` +
`web/src/components/ChangesReview/` 那条已经跑通并有 76 项测试的链路),而不是 dsh 的 remote。
`presentedOpen` / `presentedHost` 是「桌面端原生打开」能力,本项目没有 → `host` 恒为 `null`、
`openChanged` 返回 `nativeUnavailable` 即可(`ReviewTab` 已经用 `native` 判定把那个按钮隐掉)。
`reloadPresentedHost` 给一个 resolve 的 no-op。

### E.4 建议的落地顺序

1. 补别名(2 行)→ `tsc` 看 ui-deliverables 能不能进编译程序(它会牵出 `changedFileUrl` 等工具与 css modules)。
2. 写 `components/RightSidebar/ReviewPanelHost.tsx`:store 用 `createReviewStore().create(sid)`、
   `useStore` 用 `useSyncExternalStore`(照 `FilesPanelHost` 的写法);数据面接 Teleforge RPC;
   `useTabInfo` 给 `PanelTabInfo`(含 E.2.1 的 navigation);`t` 取 `client/locales.ts` 的 `zh`。
3. App 侧:`changes-review` 的 contentId 改成 review 地址;`openInSidebar` 时把 `params.index` 带上(可选)。
4. 实测:右栏打开「对比」→ 文件选择器能切、diff 能画、unified/split 与 wrap 两个开关能生效。
   对照物就是现在那个自写 ReviewTab(它是可用的,别在中间态把它删掉 —— 换完再删)。

---

## B. dsh 文档预览(`ui-sidebar-documentpreview`)

### B.1 查清的好消息
`client/TextPreview.tsx`(调度壳)**本身很轻**:只 import
`face.ts` / `failure-line.ts` / `LoadingIndicator.tsx` / `rpc.ts` / `store.ts` / `document/*` / `text/*`,
**不**直接拖 pdf/excel/office —— 那些是各分支在**注册处**才拉的重依赖。所以"先只接 text + code"这条路是通的。

### B.2 三个硬前置(不补就编不过)

| # | 缺什么 | 谁需要它 | 怎么补 |
|---|---|---|---|
| 1 | `@deepseek-ai/dsh-util-code-language` | `ui-primitives/markdown/CodeBlock.tsx` ← `ui-primitives/code-highlighting.ts` ← `client/code/CodeBody.tsx` | 从 dsh 仓库搬这个包(`packages/util/code-language`,用 `_scan-deps.cjs` 先扫它的依赖面),或按 shiki 写个等价适配 |
| 2 | `@deepseek-ai/dsh-client-resources/client`(`Resources` 类型) | `client/face.ts` + `client/document/resource-group.ts` | 照 `dsh-adapters/api-remotes` 的做法在 `dsh-adapters/` 里给结构等价的类型面 |
| 3 | markdown 分支的 `katex` / `micromark`(未装) | `ui-primitives/markdown/MarkdownText.tsx` ← `client/markdown/MarkdownBody.tsx` | 先**只做 text + code**;markdown 等决策(装依赖 or 砍掉) |

PDF / Excel 分支还要 `pdfjs-dist` / `xlsx` / `exceljs` / `fortune-sheet` / `dompurify` / `fast-xml-parser` /
`fflate` / `papaparse` / `yaml`,以及未搬的 `dsh-api-gateway/client` / `dsh-client-resources` /
`dsh-ui-settings/client` / `dsh-host-webserver` / `dsh-office-to-pdf/*` / `schemastery`。**建议明确砍掉**,写进文档即可。

### B.3 落地顺序
1. 补前置 1 与 2 → 让 `ui-sidebar-documentpreview` 能进编译程序(先只 import `TextPreview.tsx` 与 `client/text/*`)。
2. 在 `dsh-adapters/primitives/index.tsx` 的按需桶里加 `CodeBlock` / `languageForPath`。
3. 写 `DocumentPanelHost.tsx`:手搓 `view`/store/face/document-registry(只注册 TEXT + CODE 两条),
   数据面接 Teleforge 的 `read_file`(文本)与 `list_dir`(图片列的候补)。
4. 接线:右栏 `file` 标签按后缀分派 —— 代码/纯文本走 dsh 预览,其余仍走现在的 `FileViewer`。

---

## G. 自动化任务(最大一块)

> ⚠️ **更新(逐字迁移已完成,以下这段"进度"是旧版本,已废弃)**:服务端现在是 dsh 源码逐字移植
> (`server/schedule/dsh/` + `service.ts`/`delivery.ts`/`store.ts`),并用 **dsh 自己的 414 项 spec**
> 钉住时间语义;入口仍是标签条上的固定标签「🕘 自动化任务」(在「⌨️ 终端」右边)。
> 完整对照、有意差异与"UI 还没搬的部分"见 **`docs/handoff-schedule-migration.md`**。
>
> ~~**进度(2026-10-07 更新):S1 与 S2 已落地并实测,S3 落了模型工具、还差会话内那三处 UI。**~~
> 详见 `docs/plan-automation-and-changes-review.md` 的「本轮落地状态」。已完成的落点:
> - `server/schedule/{types,time,store,runtime,service}.ts` + `server/api/rpc/schedule.ts`(8 个 RPC)+ `server/agent/schedule-tools.ts`(4 个模型工具);
> - `web/src/components/SchedulePanel/`(列表 / 详情 / 6 种规则编辑器 / 运行记录)+ 标签条固定标签「🕘 自动化任务」(在「⌨️ 终端」右边)+ 手机底部栏「自动化」;
>   (入口最终定在这里:左上角 / 品牌右边不放按钮,标签上有"到点却没跑"的任务时亮小红点)
> - `test/schedule.test.js`(122 项断言:DST、错过只补最近一次、等待重连 5 分钟、skipped、一次性不补发、真实投递链路、模型工具)。
>
> **还没做的**:会话头时钟胶囊 / 会话列表行时钟标记 / 对话内创建卡片(`schedule_create` 的工具结果目前走 `GenericToolCard`)/
> 右栏「任务详情」tab。原方案 §3.8/§3.9 的描述仍然有效,照它做即可。

方案已写在 `docs/plan-automation-and-changes-review.md`(数据模型 / 6 种调度 / 时间纯函数含 DST 与
"错过只补最近一次" / 存储 / 30s 调度器 / 4 个模型工具 / 6 个 RPC / 左栏顶部入口 / 任务页面 / 会话内三处集成),
两个决策也已拍板(①入口放左栏顶部新增一行;②到点但服务器未连接 → 等待重连最多 5 分钟,超时记 missed)。

**它与 dsh 无关、不碰 `App.tsx` 的 renderBody**,所以可以和 E/B 并行、也可以单独排。
建议的第一刀(能独立验收):时间纯函数 + 存储 + 30s 调度器 + 6 个 RPC,先不做界面;
用 `test/` 下的既有测试风格把调度边界(DST、错过只补最近一次、断连等 5 分钟)钉住,再上左栏入口与任务页面。

---

## 通用注意

- 三件套照旧:`npx tsc --noEmit -p tsconfig.json` → 0;`npm run build` → ✓;`http://127.0.0.1:4000` 预览实测。
- 搬新包前后都跑一次 `node _scan-deps.cjs <包目录>` 看依赖面。
- 改共享文件(`App.tsx` / `tsconfig.json` / `vite.config.ts`)前先重读 —— 本工作区可能同时有别的会话在动它们。
