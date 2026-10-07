# 交接:右栏(dsh 侧边栏移植)未完成任务清单

> 交给另一个会话执行。本文只写**已验证的事实**与**确切下一步**,不含推测。
> 最后更新:本会话结束时;仓库状态 `tsc` 0 错、`npm run build` ✓。

---

## 0. 环境与硬约束(先读这条,能省你几小时)

- 工作区:`F:\Dm\companyProject\自己\远程ssh工具`;平台 win32。
- **本机执行命令时 `cd` 不改变子进程 cwd**(cwd 恒为工作区)。跨目录一律在脚本/命令里用**绝对路径**,或 `git -C "<路径>"`。本会话因这条误判过两轮。
- **绝不要用 node 脚本直接改写源文件**。本会话用脚本回退 `App.tsx` 时把它截断成 59 行(1500 行文件),只能靠 `git checkout` 恢复,并因此丢了右栏集成。改动一律用精确编辑工具,改完立刻验证。
- 验证基线(每次改完都跑):
  - `npx tsc --noEmit -p tsconfig.json` → 期望 **0**
  - `npm run build` → 期望 **✓ built**
  - 应用在 `http://127.0.0.1:4000`(后端托管 `web/dist`);预览用 `browser_open(target='preview')`
- 另有 dsh 侧沙箱检查:`npx tsc --noEmit -p tsconfig.dsh.json`(只 include `ui-dockkit`/`ui-sidebar-right`/`ui-sidebar-files`/`ui-renderer`/`dsh-adapters`)。它现在**不是 0**(剩余集中在 `ui-sidebar-right` 的 cordis 插件入口 —— 我们有意不移植那层),不要以它为完成标准,只看它有没有**新增**。

---

## 1. 已完成(不要回退)

**移植树** `web/src/dsh/`(20 个包):
- 8 个 UI 包(dockkit / sidebar-right / sidebar-files / sidebar-terminal / sidebar-browser / sidebar-documentpreview / deliverables / primitives)——早期 xcopy **铺平**过,所以 `web/src/dsh/<pkg>/` 里放的是原包 `src/` 内容,且**没有 package.json / lib**;
- 12 个正常包:`client-store`、`client-ui-slots`、`client-locale`、`client-shortcuts`、`session`、`api-remotes`、`api-workspace-files`、`typert-protocol`、`util-workspace-path`、`ui-renderer`、`cordis`、`cosmokit`(都带 package.json 与完整 `lib/` 产物)。

**dsh 源码布局**(下次要搬包时用):`packages/*/*`(两段式:`packages/<组>/<包>`),cordis 在 `vendor/cordis`。仓库根:`E:\RJ\DmRJ\deepseek-harness`。

**别名体系**:`tsconfig.json` 的 `paths` + `web/vite.config.ts` 的 `DSH_ALIAS`。vite 里两个 helper:`dsh(rel)` → `./src/dsh/<rel>`、`adapter(rel)` → `./src/dsh-adapters/<rel>`。四个真包别名已实测可解析(`pluginContainer.resolveId`)。

**产物消费策略(重要)**:`cordis` / `cosmokit` 按**构建产物**消费:
- `tsconfig.paths` → `web/src/dsh/<pkg>/lib/types/index.d.ts`(只读声明,**不检查源码**)
- `vite.alias` → `web/src/dsh/<pkg>/lib/index.js`
- 原因:cordis 的 TS 源码按 dsh 自己的基础配置写,进本项目严格选项会出 **45 个错**(`noImplicitThis`/隐式 any)。任何"源码编译不过"的包都用这招。

**已删除**:dsh 各包自带的 `tsconfig.json` / `tsdown.config.ts`(共 20 个)。**必须删**——esbuild 在 `web/src` 下会去解析它们(`extends: ../../../tsconfig.base.json` 不存在)→ 构建失败。

**适配层** `web/src/dsh-adapters/`:
- `api-remotes`:完整 `ClientRemote`(`call` / `$stream` / `workspaceFiles.list|changes`)+ `RemoteResult.error` + `makeRemoteStream` / `streamFromOptions`;
- `api-workspace-files`:`WorkspaceDirectoryEntry`(**字段是 `type` 不是 `kind`**)、`WorkspaceFileWatchFrame`(**带 `kind: 'ready'|'change'`**);
- `primitives`:按需桶(已含侧栏用到的 Button/Menu/Tooltip/Modal/icons/**FileTypeIcon+classifyFileType**/**PathLabel**);
- `locale` / `shortcuts` / `session` / `brand`:宿主面类型(Teleforge 没有 dsh 宿主,这几项**故意**保持为适配实现)。

**右栏(dockkit 直驱,已实测)**:
- `components/RightSidebar/DockSidebar.tsx`:`DockController` + `DockSurface`,中文 `LABELS`,`makePaneTab` 让标签条 `＋` 开文件树标签;
- `components/RightSidebar/RightSidebar.tsx`:薄壳(宽度、默认关闭、可收起、左边缘拖宽 `.resizer-left`、按会话 `key={sid}` 隔离);
- `App.tsx` 集成:`rightOpen`(**默认 false**)、`openInSidebar()`(内部 `setRightOpen(true)`)、右上角 `▤` 开合按钮、「打开浏览器预览」旁、`renderBody` 分派(`file` → FileViewer、`changes-review` → ReviewTab)、`ChatPanel` 三个回调;
- **`local:` 前缀**:`FileViewer` 用 `path.startsWith('local:')` 区分本地/远端,**本地文件进右栏必须加前缀**,否则报「SSH 未连接」;
- `web/src/dsh-tokens.scss`:125 个 `--dsw-*` → Teleforge token 的桥(构建产物里已确认 125/125)。

---

## 2. 未完成(逐项:目标 → 现状 → 确切下一步)

### A. 文件树面板(进行中,最接近完成)⭐
- **目标**:右栏出现 dsh 原版文件树(`ui-sidebar-files` 的 `FilesBody`),`＋` 能开出来,目录能列。
- **现状**:`ui-sidebar-files` 包**自身类型错误 = 0**;适配缺口全修好了;只差"宿主怎么给 props"这一层。
- **已试过并否掉的路**:
  - 直接 `import FilesBody` + 手搓 props → 12 错,因为 `SlotMap` 增强没加载(`'sidebar.right.pane.tab' does not satisfy the constraint 'never'`);
  - 再加 `import '../../dsh/ui-sidebar-files/client/index.ts'`(增强就在这里)→ **25 错**:它把注册层 `definition.tsx` / `FilesTitle.tsx` 一起拖进来(缺 `GuideArtworkFiles` 等)。**不要走这条**。
- **确切下一步**:自己声明两条 `SlotMap` 条目(放在 `web/src/components/RightSidebar/` 下一个 `.d.ts` 或 ts 里):
  ```
  declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
      'sidebar.right.pane.tab': <按 ui-sidebar-files/client/index.ts 里的增强逐字抄>
      'sidebar.right.tab.files.actions': <同上>
    }
  }
  ```
  → 抄的时候**只抄这两条**,不要 import 那个入口。然后写 `FilesPanelHost.tsx`(props 见 §3)。
- **验证**:`tsc` 0 + `build` ✓ + 浏览器点 `＋` → 目录列出来。

### B. 文档预览面板
- **目标**:右栏打开文件时用 dsh 的 `ui-sidebar-documentpreview`(代码/markdown/图片…)。
- **现状**:包已搬(`web/src/dsh/ui-sidebar-documentpreview`,源码副本、无 lib)。**重依赖未装**:`pdfjs-dist` / `xlsx` / `exceljs` / `fortune-sheet` / `katex`(只在 PDF/Excel/Office/公式分支)。
- **下一步**:先按 A 的 SlotMap 方案接**代码/markdown 分支**;PDF/Excel 分支要么装依赖,要么砍掉并在文档里记一笔。

### C. 终端面板
- **目标**:右栏终端标签用 dsh 的 `ui-sidebar-terminal`。
- **现状**:包已搬;Teleforge 侧已有 xterm。依赖面需先扫(`ui-sidebar-terminal` 的 import,见 §5 命令)。
- **下一步**:同 A(注册 slot + 宿主注入);数据面接 Teleforge 的终端会话。

### D. 浏览器面板
- 同 C,用 `ui-sidebar-browser`。Teleforge 已有浏览器标签链路,注意别与主区标签混。

### E. diff 面板换成 dsh 原件
- **目标**:把现在自写的 `components/ChangesReview/ReviewTab` 换成 dsh 的 `ui-deliverables`(`ReviewTab` + `FileDiff`)。
- **现状**:`ui-deliverables` 已搬(源码副本);自写版可用(测试 49+27 项通过,`web/src/utils/shiki.ts` 双主题高亮也在)。
- **注意**:用户明确说过「**文件列表打开的代码编辑器**」与「**会话里的文件改动对比**」是**两条不同链路**,不要合并。

### F. 布局持久化 / 恢复
- **目标**:右栏布局按会话持久化,切回来恢复(dsh `ui-sidebar-right` 的能力)。
- **现状**:已做到**隔离**(切换会话重建 controller,`key={sid}`),未做**恢复**。
- **下一步**:dockkit 的 ops 回放(`recordedOps` + `replay`);`DockController` 暴露的 ops 面需先读一眼 `web/src/dsh/ui-dockkit/` 里 controller 的实现。

### G. 自动化任务(最大一块,独立于 dsh)
- **方案已写好**:`docs/plan-automation-and-changes-review.md`(数据模型 / 6 种调度 / 时间纯函数含 DST 与"错过只补最近一次" / 存储 / 30s 调度器 / 4 个模型工具 / 6 个 RPC / 左栏顶部入口 / 任务页面 / 会话内三处集成)。
- **已拍板的决策**:①入口放**左栏顶部新增一行**;②到点但服务器未连接 → **等待重连最多 5 分钟**,超时记 missed。
- **现状**:**未开工**。另一半(变更对比数据链路 R1/R2/R3)已完成并有测试。

### H. 等用户确认
- 是否从 git 恢复 **`ActivityDock`(AI 运行胶囊 + 子代理右侧抽屉)** 与 `renderBody` 的 `subagent` 分支。
- 现状:三文件(`ActivityDock.tsx/.scss`、`AiTermPanel`、`SubagentPanel`)在工作区**已被删除**(git 里是 ` D`),我据此只去掉了引用。恢复命令:`git -C "<工作区>" checkout HEAD -- web/src/components/ActivityDock`(注意其依赖也要一并恢复)。

---

## 3. 接手 A 需要的全部类型事实(逐字来自源码)

```ts
// ui-sidebar-files/client/FilesBody.tsx
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.files.actions'>
  & PropsStore<ReturnType<typeof createFilesStore>>
  & FilesInjected
  & PropsLocale<'sidebarFiles'>

export function FilesBody({ useTabInfo, sessionId, useSessions, useStore, actions,
  start, refresh, setAutoRefresh, toggle, t, renderSlot }: FilesBodyProps): ReactNode
```

```ts
// ui-sidebar-files/client/face.ts —— 业务面(直接用工厂,不要自己写)
filesFace(list, watch)(sessionId, store.actions) → FilesInjected
createList({ workspaceFiles: { list: (sessionId, path, signal) => Promise<RemoteResult<{entries,truncated}>> } })
// watch:可先给"不产生事件"的空流(等于暂关自动刷新)

// client/store.ts
export function createFilesStore(): EngineStoreHandle<FilesState, FilesActions>   // defineStore({ init, actions })
// client-store 的 StoreInstance 是 React-free:{ actions, getSnapshot(), subscribe(fn) }
// → useStore 由运行时绑;手接时用 useSyncExternalStore + client-store 导出的 shallowEqual
```

```ts
// client-ui-slots 契约(选路时用)
SlotRendererHost 有 18 个成员;SlotCore 只提供一半:
  有:subscribe / getVersion / entriesOfSlot / entries / isLive / reportEntryError / reportFactoryError / subscribeFactory / isFactoryLive / register / onMutate
  缺:entriesOf / factoryOf / getFactoryVersion / specOf / storeOf / factoryStoreOf / retainFactoryOccurrence / root / scopeRevision / scope(scope) / locale
createSlotRenderer() 在 ui-renderer/src/client/scoped-slots.tsx:1311 → { renderRoot(host, ownerProps) }
ui-renderer/src/client/registry.ts:120 的 SlotRegistry extends Service(建在 cordis 上);app.tsx 的 buildRenderApp 需要 ctx.slots
ui-renderer/src/client/bindings.tsx:RootStandardProvider / ScopeProvider / observableHook / keyedObservableHook / bindSnapshotSelector(bind.ts)
ScopeProvider 在 host.scope(scope) === undefined 时抛 SlotAssemblyError("scope 'session' rendered without an installed adapter")
```

---

## 4. 踩过的坑(别再踩)

1. **`cd` 不生效** → 用绝对路径 / `git -C`。
2. **不要用脚本改源文件**(本会话把 App.tsx 截断过)。
3. **`import` dsh 插件入口 = 拖进注册层**(`ui-sidebar-files/client/index.ts` 会带 `definition.tsx`/`FilesTitle.tsx`)。
4. **移植的 TS 不要进应用编译程序**:要么按产物消费(lib),要么自己声明类型。
5. **dsh 包自带的 `tsconfig.json` 会让 esbuild 构建失败**,必须删。
6. **JSX 属性之间不能写 `{/* … */}`**(只允许 `{...spread}`);注释写进表达式或放元素上方。
7. 面板是 **slot 注册体**,不是能直接渲染的组件;`useTabInfo`/`useSessions`/`renderSlot`/`t` 都由 slot 运行时供给。
8. 右栏里打开**本地文件**必须带 `local:` 前缀。

---

## 5. 常用命令与文件索引

```bash
# 扫某个 dsh 包的外部依赖面(搬之前先跑)
node -e "const fs=require('fs');const D='F:/Dm/companyProject/自己/远程ssh工具/web/src/dsh/<包>';const s=new Set();const w=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const q=d+'/'+e.name;if(e.isDirectory())w(q);else if(/\.(ts|tsx)$/.test(e.name))for(const m of fs.readFileSync(q,'utf8').matchAll(/from\s*['\"]([^'\".][^'\"]*)['\"]/g))s.add(m[1])}};w(D+'/src');console.log([...s].sort().join('\n'))"

# 在 dsh 仓库里按包名定位源码目录
node -e "const fs=require('fs');const B='E:/RJ/DmRJ/deepseek-harness';const walk=(d,dep)=>{if(dep>3)return;for(const e of fs.readdirSync(d,{withFileTypes:true})){if(!e.isDirectory()||e.name==='node_modules')continue;const q=d+'/'+e.name,pj=q+'/package.json';if(fs.existsSync(pj)){try{const n=JSON.parse(fs.readFileSync(pj,'utf8')).name;if(n==='@deepseek-ai/<包名>')console.log(q)}catch{}}walk(q,dep+1)}};walk(B+'/packages',0)"
```

关键文件:
| 作用 | 路径 |
|---|---|
| 右栏宿主 | `web/src/components/RightSidebar/DockSidebar.tsx` |
| 右栏薄壳 | `web/src/components/RightSidebar/RightSidebar.tsx` / `.scss` |
| App 集成 | `web/src/App.tsx`(`rightOpen` / `openInSidebar` / `▤` / `renderBody` / ChatPanel 回调)|
| dsh token 桥 | `web/src/dsh-tokens.scss` |
| 别名 | `tsconfig.json`(paths)/ `web/vite.config.ts`(DSH_ALIAS / dsh() / adapter())|
| 接线方案(部分已过时,§8 仍有效) | `docs/plan-files-panel-wiring.md` |
| 自动化任务方案 | `docs/plan-automation-and-changes-review.md` |
