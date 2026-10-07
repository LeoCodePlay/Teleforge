# dsh 文件树面板（ui-sidebar-files）接线说明书

> 目的：把 dsh 的 `FilesBody` 接进 Teleforge 右栏（dockkit 外壳）。这份文档只记录
> **已经查清的事实**与**要写的宿主代码**，避免下次再从零摸索。

## 1. 面板的组成（10 个文件）

| 文件 | 处置 |
|---|---|
| `client/index.ts` | **跳过**：cordis 插件入口（`apply(ctx)` / `inject=[...]`），是注册样板 |
| `client/FilesBody.tsx` | **要移植的正文**（导出 `FilesBody` + `FilesBodyProps`） |
| `client/Face.ts` → `face.ts` | 数据注入缝：`createList` / `createWatch` / `filesFace` / `childPath` |
| `client/store.ts` | 树的状态机（`createFilesStore`，含 `byTab[tabId]`） |
| `client/directory-node.ts` | 每层目录节点的加载/展开/自动刷新编排 |
| `client/FilesTitle.tsx` | 标签标题 |
| `client/locales.ts` | `t()` 的文案表（命名空间 `sidebarFiles`） |
| `client/definition.tsx` | dsh 的标签定义（我们用不上：本项目标签由 `renderTab` 分派） |

## 2. `FilesBody` 到底吃哪些 props（逐字来自源码）

```ts
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.files.actions'>
  & PropsStore<ReturnType<typeof createFilesStore>>
  & FilesInjected
  & PropsLocale<'sidebarFiles'>

export function FilesBody({
  useTabInfo, sessionId, useSessions, useStore, actions,   // ← 运行时/store 注入
  start, refresh, setAutoRefresh, toggle,                  // ← FilesInjected 业务面
  t, renderSlot,                                           // ← 文案 + 槽位
}: FilesBodyProps): ReactNode
```

用法（正文里出现的）：
- `useTabInfo()` → `{ tab }`，`tab` 需要 `id`、`signal`、`actions.bindCommands({ refresh })`；
- `useSessions(s => s.byId[sessionId]?.cwd)` → 工作区根（`cwd`）；
- `useStore(s => s.byTab[tab.id])` → 该标签的树状态；
- `t('error.notFound' / 'error.outsideWorkspace' …)` → `sidebarFiles` 命名空间文案。

## 3. `FilesInjected`（业务面，由我们实现）

```ts
interface FilesInjected {
  refresh(tabId): void
  setAutoRefresh(tabId, enabled): void
  start(tabId, root: string, signal): void   // 播下这棵树 + 列根目录
  load(tabId, path, signal): void
  toggle(tabId, parentPath, path, expanded, signal): void
}
```

实现方式：**直接用 dsh 的 `filesFace(list, watch)`**，只需给它两个东西——
- `list`：把 `workspaceFiles.list(sessionId, path, signal)` 换成 Teleforge 的目录列举 RPC；
  用现成的 `createList(remote)`，其中 `remote.workspaceFiles.list` 由我们提供：
  远端走 `list_dir`，本机走 `list_local_dir`，返回 `{ ok:true, value:{ entries, truncated } }`；
  条目字段按 `WorkspaceDirectoryEntry`（`name/path/kind/size/modifiedAt`）映射。
  **注意 `DirLevel` 的形状要与 `api-workspace-files` 适配层对齐**（`entries` + `truncated`）。
- `watch`：可先给「不产生事件」的实现（`async function* () { return }`，或直接返回空流）——
  即关掉 dsh 的文件变更自动刷新；等接了变更流再补。

## 4. 要写的宿主代码（唯一的新文件）

`web/src/components/RightSidebar/FilesPanelHost.tsx`：

1. `const store = createStore(() => createFilesStore())`（模块级单例，或按标签建）；
2. `actions = bindActions(store)`（用 dsh store 的绑定方式；适配层 `dsh-adapters/store` 已备好
   `createSnapshotStore` / `defineStore` / `BoundActions`）；
3. 造 tab 记录：`{ id, signal: 该标签的 AbortSignal, actions: { bindCommands } }`——`bindCommands`
   接收 `{ refresh }` 并把它挂到标签菜单/快捷键上（最小实现：存起来，供 `refresh()` 调用）；
4. `t`：从 `client/locales.ts` 的文案表取（已搬进来，中文/英文都在里面）；
5. `sessionId`：由右栏传入（`RightSidebar` 的 `sid`）；`cwd`：从会话信息取（Teleforge 已有）；
6. 渲染：`<FilesBody useTabInfo={…} useSessions={…} useStore={…} actions={…} {...face} t={…} renderSlot={noop} sessionId={…} />`。

## 5. 还需要在现有代码里动的三处

1. `App.tsx` 的 `renderBody`：加 `if (tab.kind === 'files') return <FilesPanelHost … />`；
2. `DockSidebar.tsx`：给 `new DockController({ mode:'push' })` 传 `makePaneTab`，让标签条的
   `＋`（`labels.addTab` = "新建空白栏"）真的开出一个 `kind:'files'` 的标签；
3. `tsconfig.dsh.json`：把 `web/src/dsh/ui-sidebar-files` 加进 `include`，清掉它自己的残余类型错误
   （它的额外依赖只有 5 个：`api-remotes` / `api-workspace-files` / `typert-protocol` /
   `util-workspace-path` / `sidebar-right-types`，**适配层已经全部就位**）。

## 6. 现状与风险

- 适配层（15 个包）**已全部落地**，应用侧 `tsc` 始终 0 错、`build` 通过；
- 唯一未决是 `client/store.ts` 里 `createFilesStore` 的**导出形状**与 actions 名，
  以及 dockkit `TabRecord` 上 `signal` / `actions.bindCommands` 的精确类型——
  接线前先各读一眼（各 30 行内），再写 `FilesPanelHost.tsx`，可一次过。

---

## 7. 补遗(读真源码后的决定性事实)

### client-store 的真实 API(web/src/dsh/client-store/src/)

```ts
// contract.ts
export interface StoreSpec<T, A> { init: () => T; persist?: string; actions: A }
export interface StoreInstance<T, A> { readonly actions: BakedActions<T, A>; getSnapshot(): T; subscribe(fn: () => void): () => void; clearPersisted(): void }
export interface StoreHandle<T, A> { readonly spec: StoreSpec<T, A>; create(scopeKey?: string): StoreInstance<T, A> }
// index.ts
export function defineStore<T, A>(spec: StoreSpec<T, A>): StoreHandle<T, A>
export function createSnapshotStore<T>(...)   // 另有 shallowEqual / notifySubscribers
```

要点:**StoreInstance 是 React-free 的**(没有 useStore)。`useStore` 由渲染机制(ui-slots)在它那侧用 `useSyncExternalStore` 绑到这个 source 上。

### 面板是 slot 注册体,不是独立组件

`PropsRuntime<K>` = `OwnerOf<K> & KeyPropsOf<K> & SlotInjectFace<...> & ScopeStandardProps<...>`。
也就是说 `useTabInfo` / `sessionId` / `useSessions` / `renderSlot` / `t` **全部由 slot 系统提供**,`useStore` + `actions` 由 `PropsStore<H>` 从 StoreHandle 推出来。

**因此接线只有两条路:**

- **(A) 挂 ui-slots 运行时**:声明 slot map + Provider + 注册表,一步到位解锁**所有** dsh 面板。代价是搬 ui-slots 的 store/renderer 与 slot 声明机制。
- **(B) 手搓宿主 props(推荐先做,只为一个面板)**:
  1. `const instance = createFilesStore().create(sessionId)`
  2. `useStore = (sel, eq) => sel(useSyncExternalStore(instance.subscribe, instance.getSnapshot))`
     —— 相等判断直接用 client-store 导出的 `shallowEqual`
  3. `actions = instance.actions`
  4. `useTabInfo = () => ({ tab })`,tab = { id, signal, actions: { bindCommands(m){...} } }
  5. `useSessions = (sel) => sel({ byId: { [sessionId]: { cwd } } })`
  6. `t` = `client/locales.ts` 的 `zh` 表(命名空间 sidebarFiles)
  7. `renderSlot` = 先 `() => null`(不渲染工具栏动作槽)
  8. 五个 face 函数用 `filesFace(list, watch)`:
     `list = createList({ workspaceFiles: { list: (sid,path,signal) => 本项目的目录列举 } })`,
     `watch` 先给不产生事件的空流。
  9. `SlotMap` 的 augmentation 已经被搬进来的 `ui-sidebar-files` 声明→类型上能对上。

### 现状

- app: `tsc` 0 错、`build` 通过、vite 别名四个真包实测可解析;
- dsh 侧错误 104 → 47(剩余集中在 ui-sidebar-right 的 cordis 插件入口,即我们故意不移植的注册层)。
