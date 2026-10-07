# 实施方案:自动化任务 + 文件变更对比侧栏(dsh 对齐)

**面向**:Teleforge(远程 SSH AI 编程工具)
**对照上游**:`E:\RJ\DmRJ\deepseek-harness`(下称 dsh),检出 `5badb15009` / `dsh-v0.2.1-alpha.1`(2026-10-03)
**本文用途**:先把「怎么做」定下来。落地时按 §5 的里程碑逐条做,每条都有可验证的验收点(§6)。

---

## 0. 先说清楚「dsh 更新了什么」

dsh 检出的这个 commit **正是** `docs/dsh-delta-2026-10.md` 里对照的那一端(0.1.0-rc.5 → 0.2.1-alpha.1,
8,443 提交 / +190 万行,其中约 150 万行是机器生成的 schema、快照语料与 i18n 副本)。所以「更新了什么」
不用重新推一遍,以那份文档为准;和你这次诉求直接相关的只有两块,本文就是对这两块的落地方案:

| 这次要做的 | dsh 里的东西 | 性质 |
|---|---|---|
| 自动化任务 | `packages/schedule/schedule`(Host)、`packages/schedule/tool-schedule`(模型工具)、`packages/client/ui-schedule`(UI) | 上游**新子系统**,Teleforge 完全没有 |
| 文件变更对比侧栏 | `packages/deliverables/workspace-changes`(Host diff 数据)、`packages/client/ui-deliverables`(变更卡 + `changes-review` 对比页 + `FileDiff`)、`packages/client/ui-sidebar-right`(右栏外壳) | 上游**新子系统**;Teleforge 有「壳」没有「内容」 |

其余可落地项(`docs/dsh-delta-2026-10.md` §8 那张表:会话格式版本化、compaction-image-offload、agent-team、
webworker-runtime 等)不在本次范围,按那张表另行排期。

---

## 1. 现状盘点(差在哪)

### 1.1 自动化任务:Teleforge 一点都没有

| 能力 | dsh | Teleforge |
|---|---|---|
| 任务模型 | 6 种调度:`after` / `at` / `every` / `daily` / `weekly` / `cron`(5 字段 Vixie) | 无 |
| 持久化 | Host 侧持久任务表 + 运行记录 | 无 |
| 定时器 | Host 常驻调度器,到点投递回原会话 | 无(但已有轮询先例:`server/agent/agent.ts:668` 的自动续跑 `_autoResumeTimer`) |
| 模型工具 | `schedule_create/list/update/delete` | 无 |
| 页面 | 中央主区域大页面:列表 + 详情(规则 / 运行记录) | 无 |
| 入口 | 左侧栏面板列表一行「自动化任务」 | 无 |
| 会话内集成 | 会话头时钟胶囊、会话行时钟标记、对话内创建卡片、右栏详情 tab | 无 |

**有利条件**:Teleforge 已经具备任务真正需要的一切底层 —— 会话绑定服务器 + 工作区、`agent.submit()`
这条「往会话里发一句话」的入口(`server/api/rpc/agent.ts:36`,即 `speak` 的实现)、会话忙时的待执行队列
(`QueuePanel`)、自动续跑轮询、`session_list/session_switch` 等 RPC、以及事件广播(`send/emitStatus`)。

### 1.2 文件变更对比侧栏:壳有了,内容是假的

| 能力 | dsh | Teleforge 现状 |
|---|---|---|
| 右栏外壳 | `ui-dockkit`(可回放 op、拖拽、浮动窗、最多 4 pane)+ `ui-sidebar-right` | `web/src/components/RightSidebar/`(已按 dsh 三层分离裁剪实现:`layout.ts` 纯引擎 + `applyOp/逆 op` + 按会话持久化,限定 2 个水平 pane) |
| 标签类型 | files / documentpreview / terminal / browser / changes-review / scheduleTask | `file` / `subagent` 两种 |
| 变更数据源 | `workspaceChanges.summary/diff` + `git write-tree` 快照 + 写前捕获原文件 | **只有计数**:`meta: { card:'diff', kind, path, addLines, delLines }`(`server/agent/tools.ts:388/424/516` 与 `:886/909/939`) |
| 对比视图 | `FileDiff.tsx`(统一 / 左右并排、行号双列、hunk 头、高亮、5000 行截断、coarse 降级) | `toolviews/DiffRow.tsx` —— 把 `old_string` 全部画成 `-`、`new_string` 全部画成 `+`,**不是真 diff**;`write_file` / 删除连这个都没有(文件自己都写了「当前降级为近似」) |
| 变更卡 | 60px 表头 + 40px 行块,`+N/-N`,>4 行折叠,悬停 500ms 预览 | `FilesChangedCard.tsx`:文件名 / 相对路径 / 变更类型 / `+N -N`,**点了只是「在侧栏打开整个文件」,看不到改了什么** |

**结论(这就是"太丑"的根因)**:没有 before/after 内容,任何前端都画不出真 diff。所以本方案的
第一优先级不是样式,而是**把 diff 数据源补上**(§4.1),样式则按 dsh 的 `FileDiff` 规格逐像素对齐(§4.2)。

---

## 2. 目标与非目标

**做**
1. 自动化任务全链路:服务端任务表 + 调度器 + 模型工具 + RPC + 页面 + 左上角入口 + 会话内三处集成。
2. 文件变更对比:服务端「每轮文件变更」记录器 + `changes_summary/changes_diff` RPC + 右栏 `changes-review`
   标签页(表头文件选择器 + 统一/并排 + 换行 + 打开整文件)+ 按 dsh 规格渲染。
3. 变更卡升级:点一条变更 → 直接在右栏看到该文件的 diff。

**不做(至少这一轮)**
- 不做右栏的浮动窗 / 拖拽改停靠 / 4 pane 通用引擎(dsh dockkit 的完整形态);右栏仍是 2 个水平 pane。
- 不引入 shiki(体积大);语法高亮用项目已有的 CodeMirror / lezer 高亮器(§4.5,排在第二阶段)。
- 不做「自动拉起 SSH 连接」(见 §7 决策 2)。

---

## 3. 第一部分:自动化任务

### 3.1 数据模型(新增 `server/schedule/types.ts`)

模型与 dsh 同构(dsh 定义在 `packages/schedule/schedule/src/types.ts`),这样 UI 与语义可以照搬:

```ts
/** 一次性(相对)/一次性(绝对)/固定间隔/每天/每周/cron —— 与 dsh 的 6 种判别式一致 */
export type ScheduleKind = 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron';

interface ScheduleBase {
  id: string;              // schedule-<uuid>
  title: string;           // 必填,trim 后非空,≤120 字符(列表/详情/会话内标记都用它)
  prompt: string;          // 到点后投递进会话的消息体
  scheduledAt: string;     // 下一次触发瞬间,RFC3339 UTC(带毫秒)
  createdAt: string;
  /** Teleforge 特有:绑定关系。dsh 只绑 sessionId,我们需要知道"离线能不能跑" */
  sessionId: string;
  scopeKey: string;        // username@host:port | 'local'(会话的作用域,决定"服务器在不在线")
  workspace?: string;      // 冗余保存,便于列表直接展示,不用反查会话
}

export type ScheduleTask = ScheduleBase & (
  | { kind: 'after';  afterSeconds: number }                       // 创建时刻 + N 秒(一次性)
  | { kind: 'at' }                                                 // 由 scheduledAt 决定(一次性)
  | { kind: 'every';  everySeconds: number }                       // ≥60,锚定创建/改规则时刻
  | { kind: 'daily';  time: string; timeZone: string }             // HH:mm,IANA 时区
  | { kind: 'weekly'; time: string; timeZone: string; weekdays: number[] } // ISO 1=周一…7=周日
  | { kind: 'cron';   expression: string; timeZone: string }        // 规范化后的 5 字段 Vixie
);
```

**与 dsh 的两处有意差异**(都要写进注释,避免以后被当成 bug 改回去):

| 差异 | 原因 |
|---|---|
| 增加 `enabled: boolean`(暂停/恢复) | Teleforge 会长时间离线,用户需要「先别跑」而不是只能删掉 |
| 增加 `scopeKey` | dsh 是 host-wide,不关心连接;Teleforge 的会话绑着某台 SSH 服务器,必须能判断"现在跑不了" |

**时间语义(照搬 dsh,全是纯函数,放 `server/schedule/time.ts`,便于穷举单测)**
- `nextDailyTarget` / `nextWeeklyTarget` / `nextCronTarget`:`Intl.DateTimeFormat(...).resolvedOptions().timeZone`
  规范化时区;DST 缺口跳过、重叠取更早瞬间(`disambiguation: 'earlier'` + 本地字段回环校验)。
- cron:只接受 5 字段 Vixie(拒绝 `L/W/#/名字/@daily/6 字段`),搜索上限 400 年,存储保留规范化文本。
- **错过触发只补最近一次**:重复任务在停机后恢复时,只投递最近一个漏掉的 occurrence(不是全部补跑);
  一次性任务不补发。
- 决策时刻必须有 `if (decision < savedTarget) throw` 这类守卫,防止 tzdata 回退导致时间倒流。

### 3.2 存储(新增 `server/schedule/store.ts`)

- 文件:`data/schedules.json`,`{ version: 1, tasks: ScheduleTask[], records: RunRecord[] }`,原子写(临时文件 + rename,
  与 `ssh-profiles.json` / `settings.json` 同款做法)。
- `RunRecord`:`{ id, taskId, startedAt, endedAt, result: 'success'|'failure'|'skipped'|'missed', reason?, sessionId }`。
- 保留策略:每任务最多 100 条 / 最近 14 天(取先到者),超出自动清理;清理不影响任务继续运行
  (dsh 的运行记录里就有这句解释文案,照抄)。
- 服务重启后 `scheduledAt` 可能已过期 → 启动时统一走 §3.1 的「只补最近一次」重算。

### 3.3 调度器(新增 `server/schedule/runtime.ts`)

- 复用项目已有的轮询风格(`server/agent/agent.ts:668` 的 `_autoResumeTimer`),`setInterval` 每 **30s** 一次
  `tick()`,tick 内是纯函数 + 一次落盘:
  1. 取 `enabled && scheduledAt <= now` 的任务;
  2. 逐个尝试投递(§3.4),写 `RunRecord`,再算出新的 `scheduledAt`(重复任务)或标记完成(一次性);
  3. 状态变化统一 `send({ type: 'schedule_changed' })` 通知前端刷新(只发"变了",正文让前端自己拉)。
- **重叠策略**:同一任务上一次还在跑 → 本次记 `skipped`(不排队堆叠)。
- **停机策略**:进程重启/服务未起期间错过的 → 记 `missed` 并在页面与入口上可见(而不是静默吞掉)。

### 3.4 触发链路(复用现成入口,不新造轮子)

到点投递 = 和用户手打一句话完全同一条路径:

```
schedule runtime.tick()
  → 判断 scopeKey 在线?(本地作用域恒真;远程看连接状态)
      ├─ 离线 → 按「等待重连」策略:保持 scheduledAt 不变,累计等待;超时(默认 5 分钟)记 missed
      └─ 在线 → agent.submit(sessionId, task.prompt, { source: 'schedule', taskId })
                  ├─ 会话空闲 → 直接起一轮(与 speak 一致)
                  └─ 会话正忙 → 进现成的待执行队列(QueuePanel 背后那条 FIFO)
```

要点:
- 不要另写一套「往会话里塞消息」的代码 —— `speak` 做的事(`server/api/rpc/agent.ts:17-44`)直接复用,
  只在 `submit` 的 options 里加 `source/taskId`,让前端能把这类消息标出来(可选:气泡上加一个小钟标)。
- 权限模式沿用该会话自己的设置(定时任务不该绕过 `完全访问/变更前确认`;若会话是「变更前确认」,
  到点时会停在提问面板等人应答 —— 这是正确行为,页面要在运行记录里能看出「等待用户」)。

### 3.5 模型工具(新增 `server/agent/schedule-tools.ts`)

与 dsh `packages/schedule/tool-schedule` 对齐的 4 个工具,输出 JSON 文本 + 严格 JSON-Schema:

| 工具 | 作用 | 绑定 |
|---|---|---|
| `schedule_create` | 新建任务(6 种 kind) | 从执行上下文取 `session.id`,不允许跨会话创建 |
| `schedule_list` | 列出本会话(或全部)任务 | 只读 |
| `schedule_update` | 改标题/内容/规则/启停 | 只能改自己会话的任务 |
| `schedule_delete` | 删除任务(连带运行记录) | 同上 |

并在系统提示里加一句能力说明(与 dsh 一致:让模型知道可以「约时间」,否则这个功能没人用)。

### 3.6 RPC(新增 `server/api/rpc/schedule.ts`)

`rpc.register` 的 6 个方法(**必须同步更新 `test/rpc-registry.test.js` 的 GOLDEN 表**,那是契约测试):

| 方法 | 入参 | 返回 |
|---|---|---|
| `schedule_list` | `{ sessionId? }` | `{ tasks: ScheduleTask[], nextAt?: string }` |
| `schedule_create` | `{ title, prompt, rule }` | `{ id }` |
| `schedule_update` | `{ id, patch }` | `{ ok }` |
| `schedule_delete` | `{ id }` | `{ ok }` |
| `schedule_toggle` | `{ id, enabled }` | `{ ok }` |
| `schedule_records` | `{ id, limit? }` | `{ records: RunRecord[] }` |

外加一条广播 `schedule_changed`(§3.3),以及「立即执行」= `schedule_run_now { id }`(走 §3.4 同一条链路,记一次手动运行)。

### 3.7 UI:入口 + 页面

**入口(最终形态:主区标签条上的固定标签,在「⌨️ 终端」右边)**

> 这一段的原始设计是"左上角专门一个菜单",落地后按用户要求改掉了:**入口就是标签条上那个固定标签**
> 「🕘 自动化任务」(顺序 AI 编程助手 → 终端 → 自动化任务),点一下主区换成任务大页面;
> 左上角 / 品牌右边**不再放任何按钮**。手机端仍在底部栏给一项「🕘 自动化」(不占顶栏空间)。
> 保留下来的想法:标签上的**小红点**(有"到点却没跑"的任务时亮起,是"点开就知道有事"的原意)。

- ~~`App.tsx` 的 `.topbar-left` 加一个 🕘 时钟按钮~~(已按用户要求去掉);
- 主区按现有 tab 体系加一个**内置固定标签**:`kind: 'schedule'`,与 `agent` / `console` 同级
  (`App.tsx` 的 `tabs` / `renderTab` / `tab-pane` 已经支持固定页,`FILES_HOME_ID` 就是同款做法),
  固定标签排在 `PINNED_TABS` 里 `console` 之后 —— 天然就在终端右边。
- 手机端(<768):放进顶栏溢出菜单 / 底部栏,不占顶部空间。

**页面(新增 `web/src/components/SchedulePanel/`)** —— 完全按 dsh `TaskManagerPage` + `TaskDetail` 的结构:

```
SchedulePanel                       自动化任务 + [新建任务] + 状态筛选(全部/启用/暂停/已错过) + 搜索
├─ 左:任务列表
│   行 = 时钟图标 · 标题 · 频率摘要(如「每天 09:00 · Asia/Shanghai」)
│        · 下次运行(绝对时间 + 相对时间) · 绑定会话(服务器/工作区) · 状态点
│        · hover 出现「…」菜单:立即执行 / 暂停·恢复 / 编辑 / 删除
├─ 右:详情(TaskDetail,与右栏 tab 共用同一组件)
│   ├─ 规则页:名称、内容(prompt,多行)、调度规则编辑器、关联会话链接、底部保存条
│   └─ 运行记录页:时间 / 结果(success·failure·skipped·missed) / 耗时 / 失败原因 / 可跳到对应会话
└─ 空态:「还没有自动化任务」+ 一句怎么建(创建方式:在这里建 / 让 AI 说「每天 9 点帮我…」)
```

**调度规则编辑器(6 种)**:选中 kind 后只显示对应字段,并在下方实时显示「下次运行:…」——
`after` 延迟秒数 / `at` 日期时间选择器 / `every` 间隔(分钟、小时、天三档输入,换算秒)/ `daily` 时间 + 时区 /
`weekly` 星期多选 + 时间 + 时区 / `cron` 表达式(带语法校验 + 规范化回显 + 下次 5 次运行预览)。
时区默认取浏览器时区,可选列表用 `Intl.supportedValuesOf('timeZone')`。

**删除**:确认弹窗文案照 dsh(`删除此任务?` → 「任务将停止触发,并连同其已保存的运行记录一并删除。原会话及其
消息仍然保留;已排队的消息不会被撤回。」),结果显示为全局 toast。

### 3.8 会话内三处集成(照 dsh,第一阶段可只做第 1 处)

1. **会话头部时钟胶囊**(28×28 图标按钮):该会话有任务/出错时才渲染;点开 portal 菜单(336px 宽、最高 420px)
   列出提醒:标题 / 频率 / 下次运行 / 删除按钮;只有一个任务时点击直接开详情。
2. **会话列表行时钟标记**(16px):该会话有启用中的任务且该行本身空闲时,让出前导格显示;悬停卡片里最多
   列 2 条任务,超出显示「另有 N 个任务」。
3. **对话内创建卡片**:`schedule_create` 的工具结果渲染成卡片(标题 / 规则 / 下次运行 / 「查看」按钮),
   而不是一行 JSON —— 直接复用现有 `ToolRow` 的 `card` 插槽(`DiffRow` 就是这么做的)。

### 3.9 右侧栏「任务详情」tab(第二阶段)

在右栏标签体系里加 `kind: 'scheduleTask'`,`contentId = taskId`;从会话头胶囊或对话卡片的「查看」按钮打开,
复用 §3.7 的同一个 `TaskDetail` 组件。这样"点到哪儿都是同一份详情"。

---

## 4. 第二部分:右侧栏 + 文件变更对比

### 4.1 关键前置:把 diff 数据源补上(新增服务端变更记录器)

dsh 的做法(`packages/deliverables/workspace-changes`):每轮 **turn/start 拍快照**(`git write-tree`,
用私有 `GIT_OBJECT_DIRECTORY` + 只读 alternate,**不污染仓库**),轮末 `git diff-tree --numstat` 拿清单,
并对 git 覆盖不到的路径用「写前捕获原文件(SHA-1 内容寻址)」兜底;单文件 diff 用 jsdiff
`structuredPatch('', '', old, new, undefined, undefined, { context: 3, timeout: 100ms })`。

Teleforge 的适配方案(注意我们的写工具**远程/本地双端**,所以捕获点必须两端都有):

| 步骤 | 做法 | 位置 |
|---|---|---|
| ① 写前捕获 | 在文件写工具真正落盘**之前**,读一次目标文件原内容 → 内容寻址存 blob;文件不存在 = 新建(before 为空)。先探大小,>2MiB 或含 NUL(前 8000 字节)直接标记 binary/oversized 跳过 | `server/agent/tools.ts` 的远程/本地两处文件工具(写/编辑/删除共 6 个 meta 点) |
| ② 写后取值 | 写工具已经有新内容(不用二次读):`write_file` 的 `content`、`edit_file` 的替换结果、删除 = 空 | 同上 |
| ③ 轮末汇总 | 按 turn 聚合本轮所有变更 → `{ turn, files: [{ path, kind, added, deleted, beforeSha, afterSha, binary?, oversized?, index }], totals }` | `server/agent/changes.ts` |
| ④ 落盘 | blob 存 `data/changes/<sid>/<sha1>`,`record` 追加到 `data/sessions/<sid>.changes.json`(**持久化**,不是 dsh 的内存态 —— 刷新/重启后仍能看历史对比) | `server/agent/changes-store.ts` |
| ⑤ 保留 | 每会话最多 50 轮 / 14 天;blob 按引用计数清理(没有 record 引用即删) | 同上 |

**为什么不用 dsh 的 git 快照做主打**:Teleforge 的典型工作区是**远程服务器上的任意目录**,未必是 git 仓库,
而且每次写前多跑 2 次 `git` 往返在 SSH 上很贵。「写前捕获」只需要 1 次读,且对非 git 目录同样有效。
把 git 方案作为**可选增强**留到后面(仓库存在时能拿到「本轮被外部命令改掉的文件」,捕获式拿不到 —— 这是它唯一的短板,
写进 §6 的已知限制)。

**降级矩阵(照搬 dsh 语义)**

| 情况 | 行为 |
|---|---|
| 二进制(含 NUL) | `{ kind: 'binary' }`,卡片与详情显示「二进制文件」 |
| > 2 MiB | `{ kind: 'oversized' }`,不给行数 |
| 捕获失败/读不到(权限等) | 该文件只记 `addLines/delLines`(现状),详情页显示「无法获取改动前内容」 |
| 行比较超时(100ms) | `coarse: true`,退化为「全删 + 全加」单 hunk,界面给一行说明 |

### 4.2 数据模型(与 dsh 同构,前端可几乎逐行照抄算法)

```ts
export type WorkspaceFileDiff =
  | { kind: 'text'; path: string; display: string; before: boolean; after: boolean;
      hunks: WorkspaceDiffHunk[]; coarse: boolean }
  | { kind: 'binary' } | { kind: 'oversized' };

/** 与 dsh 一模一样:每行保留 '+'/'-'/' ' 前缀,便于前端零成本分行 */
export interface WorkspaceDiffHunk {
  oldStart: number; oldLines: number; newStart: number; newLines: number;
  lines: string[];
}
```

### 4.3 新增 RPC(`server/api/rpc/changes.ts`,同样要更新 GOLDEN)

| 方法 | 入参 | 返回 |
|---|---|---|
| `changes_summary` | `{ sid, turn }` | `{ turn, files: [...], added, deleted, total }` |
| `changes_diff` | `{ sid, turn, index }` | `WorkspaceFileDiff \| null`(404 语义:`null` = 已不可用) |

`turn` 用事件日志里已有的轮号(与 `foldSessionStats` 的 turns 同源),`index` 是 summary 里的序号。

### 4.4 前端:右栏 `changes-review` 标签页(新增 `web/src/components/ChangesReview/`)

组件拆分与 dsh 一一对应,便于以后对照上游:

| Teleforge 新文件 | dsh 对应 | 说明 |
|---|---|---|
| `ReviewTab.tsx` | `ReviewTab.tsx` | 表头 + 文件选择器 + 正文;**表头规格照搬** |
| `FileDiff.tsx` | `FileDiff.tsx` | 渲染本体,**算法可逐行照抄**(纯函数,无框架依赖) |
| `FileDiff.scss` | `FileDiff.module.css` | 视觉规格照搬(见下表) |
| `review-store.ts` | `review-store.ts` | 按 `(sid, turn)` 拉 summary/diff 的小状态机(loading/missing/error) |

**可直接照抄的三个纯函数**(dsh `FileDiff.tsx:66-125`,只依赖 hunk 结构):
- `hunkRows(hunk)` —— 给每行编号:context 两侧都算,`-` 只算旧侧,`+` 只算新侧;
- `splitRows(hunk)` —— 左右并排配对:连续的 `-` 段与紧随的 `+` 段**逐行对齐**,context 两侧同排;
- `renderedHunks(hunks)` —— 总渲染行数预算 `MAX_RENDERED_LINES = 5000`,超出截断并给提示。

**表头规格(照 dsh `ReviewTab`,单位 px 原样)**
- 容器高 `38px`,`padding: 0 6px 0 8px`,底边 `0.5px solid var(--line)`;
- 左侧**文件选择器**:按钮高 28px、`padding: 0 6px 0 8px`、圆角 `--r-sm`、hover/展开时 `var(--hover-bg-hard)`;
  文本 12px 单行省略;下拉每项 = 路径(省略)+ 右侧 `+N`(绿)`-M`(红),等宽字体 12px;
- 右侧工具按钮(`28×28`,图标 15px,hover 提亮):
  - 「并排 / 统一」切换(`aria-pressed`,选中时对比图标 `rotate(90deg)`);
  - 「自动换行」切换;
  - 「在文件查看器打开整个文件」→ 复用现有 `FileViewer`(右栏另开一个 `file` 标签,或主区域标签)。
- 位置顺序:选择器(左,`margin-right:auto` 之前的计数区)→ 计数 `+N -M` → 工具组(右)。

**正文规格(照 dsh `FileDiff.module.css`)**
- 外层 `padding: 8px 0 16px`,等宽字体(用 `--mono`);
- hunk:块间距 8px;hunk 头 `padding: 4px 16px`,弱化色,文案 `@@ -oldStart,oldLines +newStart,newLines @@`;
- 行高 **22px**(`min-height:22px; line-height:22px`),`white-space: pre`(换行开关打开才 `pre-wrap`);
- 统一视图:每行 4 列 `3.5em 3.5em 1.2em 1fr` = 旧行号 / 新行号 / 符号(`+`/`-`/空格)/ 正文;
- 并排视图:两列各 `3.5em 1fr`,两列间 `0.5px` 竖线,左右**同步滚动**(双向 + 记录被浏览器钳制后的偏移,避免抖回);
- 行底色:`add` 绿底 + 行号槽更深绿 + 首行号槽左侧 `inset 3px 0 0` 标记色;`del` 红底同构;空侧填充色 `color-mix(hover 50%, transparent)`;
- 顶部说明行(弱化 12-13px):新建文件 / 删除文件 / 无变化 / coarse / 截断,各自一句;
- 状态:`loading` / `missing`(已不可用)/ `error`(带重试按钮)/ `binary` / `oversized`。

**颜色 token(补进 `web/src/theme/themes.ts` 的 `deriveThemeVars`,亮暗各一套,自动跟随全部主题)**

| 新 token | 暗色 | 亮色 | 对应 dsh |
|---|---|---|---|
| `--diff-add-bg` | `rgba(46,160,67,.15)` | `#e6f4e7` | `file-diff-added-bg` |
| `--diff-add-gutter` | `rgba(46,160,67,.20)` | `#edf7ed` | `file-diff-added-gutter` |
| `--diff-add-marker` | `#41c977` | `#1a7f37` | `file-diff-added-marker` |
| `--diff-del-bg` | `rgba(248,81,73,.14)` | `#fce8e8` | `file-diff-deleted-bg` |
| `--diff-del-gutter` | `rgba(248,81,73,.20)` | `#f9dede` | `file-diff-deleted-gutter` |
| `--diff-del-marker` | `#f85149` | `#b42318` | `file-diff-deleted-marker` |
| `--diff-empty-fill` | `color-mix(in srgb, var(--hover-bg-hard) 50%, transparent)` | 同 | `--diff-empty-fill` |
| `+N` / `-M` | `var(--green)` / `var(--red)` | 同 | `state-success/error-primary` |

### 4.5 依赖与高亮

- 新增依赖 **`diff`(jsdiff,零依赖、~30KB)**,只在**服务端**用于 `structuredPatch`(与 dsh 同款算法与
  `context: 3` / `timeout`),前端不打包它。
- 语法高亮:**第一阶段不做**(先把结构/颜色/交互做对,纯文本 + 红绿底就已经是 dsh 的骨架);
  第二阶段用项目已有的 `@codemirror/language` + 各 `@codemirror/lang-*`(仓库里 20+ 语言都在)做
  `highlightTree` → 行内 span,避免引入 shiki 的 ~1MB 体积。此阶段要处理 dsh 踩过的坑:
  「Shiki 会少一个末尾空 token 行,要保留一个对齐的空 run」—— 我们用 CodeMirror 时同理要按行对齐。

### 4.6 变更卡与工具行接上

- `FilesChangedCard.tsx`:行点击 → `onOpenChange(turn, index)`(不再只开整个文件);行右侧仍保留「在文件查看器打开」;
  表头显示 `N 个文件已更改` + 总 `+X -Y`,>4 行折叠,悬停 500ms 预览(第二阶段,先做点击对比)。
- `toolviews/DiffRow.tsx`:`edit_file` 保留片段级 `-/+`(即时反馈),但**去掉"假装是真 diff"的误导**,
  改为「片段级预览 + 『在侧栏对比整文件』按钮」;`write_file` / 删除也走同一按钮。
- `App.tsx`:`renderBody` 增加 `kind === 'changes-review'` 分支 → `<ReviewTab sid turn index />`;
  打开动作复用现有 `sidebarReq`(`SidebarOpenRequest`)机制 —— 注意 `contentId` 用 `sid:turn`,
  同一轮的文件只开一个标签,`index` 通过请求参数传入并可在页内切换(与 dsh「同一文件只聚焦不新开」一致)。

### 4.7 右栏外壳补齐(dsh 差距清单,第三阶段)

| 项 | 现状 | 补齐做法 |
|---|---|---|
| 标签条 | 有 chip,样式简 | 图标 + 标题 + 关闭按钮;最小宽 100px、超出横向滚动;hover/选中态对齐 dsh |
| 双栏 | 有(pane 数量 2、比例 20–80%) | 分隔条 hover 高亮 + 拖拽时本地比例预览(已有 `dragRatio`,补视觉) |
| 空栏 / 错误态 | 有简单文案 | 对齐 dsh 的空态与「不支持的类型」兜底 |
| 标签类型 | `file` / `subagent` | 本轮加 `changes-review` / `scheduleTask`;后续再考虑 `files`(文件树)/ `terminal` |
| 键盘 | 无 | Esc 关闭当前标签 / Ctrl+W;焦点管理(dsh 有,体验差别明显) |

---

## 5. 里程碑(建议按这个顺序落,每步都能独立验收)

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **R1 变更数据源** | 服务端变更记录器 + blob 存档 + `changes_summary/changes_diff` RPC + `diff` 依赖 | 单测:捕获/汇总/降级(二进制、超大、新建、删除、粗粒度) |
| **R2 diff 视图** | `ReviewTab` + `FileDiff`(统一/并排/换行/hunk/截断)+ 颜色 token + 右栏 `changes-review` 标签 | 右栏能看真 diff;文件选择器可切本轮其他文件 |
| **R3 接入口** | `FilesChangedCard` 行点击、工具行「在侧栏对比」、`DiffRow` 不再假装真 diff | 从对话里任一条变更一步进对比 |
| **S1 任务核心** | 类型 + 时间纯函数(daily/weekly/cron/DST/错过)+ 存储 + 调度器 + `agent.submit` 投递 | 纯函数单测 + 手工建任务能到点触发 |
| **S2 任务页面** | 左上角入口 + `SchedulePanel`(列表/详情/6 种规则编辑器/运行记录)+ 6 个 RPC | 页面上完成 CRUD、暂停、立即执行 |
| **S3 任务集成** | 4 个模型工具 + 系统提示 + 会话头时钟胶囊 + 会话行标记 + 对话内卡片 + 右栏任务详情 tab | 对 AI 说「每天 9 点帮我…」能建出来并在会话里看到 |

顺序上 R1→R3 与 S1→S3 相互独立,可以先做 R 再做 S(或反过来);建议先 R(用户当前痛点更直接)。

### 5.1 本轮落地状态(2026-10-07)

> ⚠️ **本节的"自写实现"已整体废弃**:当时是照本文档的转述写的,与 dsh 语义不一致
> (enabled/completed、success/failure/skipped/missed 运行记录、30s 轮询、一次性任务 5 分钟不补发…)。
> 现在服务端是**逐字迁移 dsh**(`server/schedule/dsh/`,dsh 自己的 414 项 spec 全绿),
> 见 **`docs/handoff-schedule-migration.md`**。下表只作历史记录保留。

| 阶段 | 状态 | 落点 |
|---|---|---|
| **R1 变更数据源** | ✅ 已完成(更早一轮) | `server/changes/store.ts` + `server/api/rpc/changes.ts`,测试 `test/changes-record.test.js` |
| **R2 diff 视图** | ✅ 已完成(更早一轮) | `web/src/components/ChangesReview/`(自写 ReviewTab + FileDiff,76 项测试) |
| **R3 接入口** | ✅ 已完成(更早一轮) | 变更卡 / 工具行的「在侧栏对比」 |
| **S1 任务核心** | ✅ 本轮完成 | `server/schedule/{types,time,store,runtime,service}.ts`、`server/api/rpc/schedule.ts`,启动挂在 `server/index.ts` |
| **S2 任务页面** | ✅ 本轮完成 | `web/src/components/SchedulePanel/`、标签条固定标签「🕘 自动化任务」(在「⌨️ 终端」右边;左上角不放按钮)、手机底部栏项;RPC 8 个(含 `schedule_preview`) |
| **S3 任务集成** | 🟡 模型工具已做,会话内 UI 未做 | 已完成:`server/agent/schedule-tools.ts`(4 个工具)+ 系统提示第 11 条 + `agent.submit` 的 `source='schedule'`/`taskId` + `agent.ensureRuntime`。未做:会话头时钟胶囊、会话行时钟标记、对话内创建卡片(`schedule_create` 结果目前落到 `GenericToolCard`)、右栏任务详情 tab |

**S1/S2 落地的实现要点(与本文档原方案的差异)**

1. **RPC 多了一个 `schedule_preview`**(共 8 个)。原因:DST/cron 的时间算术是服务端的纯函数,
   浏览器端不重写一份 —— 规则编辑器每改一个字段就发一次 preview,把「下次运行 + 接下来 5 次」交给服务端算。
   前端自己算一遍迟早会和调度器不一致。
2. **投递要先把会话装进内存**:空闲会话会被 `switchSession` 从 `_runtimes` 释放,而 `agent.submit` 要求运行时存在
   —— 新增 `agent.ensureRuntime(sid)`(只装载、**不切换**用户正在看的会话,已用测试钉住)。
3. **投递消息带 `source='schedule'` + `taskId`**(`agent.submit` 新增两个可选参数),前端据此把它和普通用户消息区分开。
4. **一次性任务与重复任务的错过口径分开**:一次性任务错过超过 5 分钟**不补发**;重复任务停机后**只补最近一次**。
5. 运行记录 `result` 只有 success/failure/skipped/missed 四态(与本文档 §3.2 一致),"等待重连"期间**不写记录**
   (每 30s 写一条"还在等"会污染运行记录),等超 5 分钟才落一条 missed 并写明原因。

**已知未做(留给下一轮)**:§3.8 的三处会话内集成、§3.9 的右栏任务详情 tab、§4.7 的右栏外壳补齐;
「会话不是完全访问时建任务给提示」这条(§7 风险 5)目前只在页面上给了一行说明,没有做成阻断式提醒。

---

## 6. 验收点(每条都可当场验)

**变更对比**
1. 让 AI 改一个已知文件 → 变更卡出现该文件 → 点它 → 右栏出真 diff:新增行绿底 + 行号槽 + 左侧 3px 标记色,删除行同构红底;行高 22px。
2. 切「并排」→ 两列同步横向/纵向滚动,长行不互相覆盖;切「自动换行」→ 长行折行。
3. 新建文件 / 删除文件 / 无变化 / 二进制 / >2MiB,五种情况各有正确文案,不报错、不空白。
4. 超过 5000 行 → 有截断提示;超时 → 有 coarse 说明。
5. F5 刷新后回到同一轮,仍能看到 diff(持久化生效)。
6. 一个文件被改两次(同一轮) → 详情里只有一条最新记录。

**自动化任务**
1. 页面新建「1 分钟后」任务 → 60s 内会话自动多出一轮 AI 回复;运行记录里 result=success。
2. 建「每 2 分钟」任务 → 连续触发,`下次运行` 时间正确;任务正在跑时下一个 tick 记 skipped。
3. 「每天 09:00 + Asia/Shanghai」→ 保存后「下次运行」显示正确(跨时区手算一次核对)。
4. cron 输入 `*/15 9-18 * * 1-5` → 校验通过 + 显示接下来 5 次运行时间;输入 `@daily` / 6 字段 → 明确报错。
5. 暂停的任务到点不触发;恢复后按新规则算下次时间。
6. 杀掉服务 3 分钟再启动 → 该任务只补最近一次(不是 3 次);一次性任务不补发。
7. 绑定远程会话的任务,在断开 SSH 时到点 → 记 missed(界面可见),不产生半截对话。
8. 会话处于「变更前确认」→ 到点触发会停在提问面板,运行记录里能看出「等待用户」。
9. 会话列表行出现时钟标记;会话头部胶囊能列出该会话任务并删除。

---

## 7. 风险 / 已知限制

1. **捕获式记录看不到"外部改动"**:如果 AI 用 `run_command` 跑脚本改了文件(不是走写工具),本轮 summary 里不会出现该文件。
   dsh 靠 git 快照能覆盖,我们的捕获式不能。缓解:git 仓库时可选跑一次 `git diff-tree`(第二阶段增强),并在文档里写明限制。
2. **远程捕获多一次读**:每次写前读原文件,SSH 上多一次往返。缓解:先探大小、只抓文本、>2MiB 跳过;
   `edit_file` 若捕获失败,退化为用 `old_string/new_string` 的片段 diff(仍然是真 diff,只是行号是片段内的)。
3. **`data/changes/` 体积**:blob 内容寻址 + 引用计数清理 + 每会话 50 轮 / 14 天上限;
   如果用户长期使用大文件,需要在设置里给一个「保留策略」开关(可作为后续项)。
4. **时区与 DST**:纯函数移植 dsh 的规则,靠"本地字段回环校验 + disambiguation earlier"避免 23:00 那天跑两次/不跑;
   必须有跨 DST 的单测(否则这类 bug 只在一年两次出现,几乎抓不到)。
5. **定时任务与权限模式**:任务不会绕过会话自己的权限设置。如果用户给一个「变更前确认」的会话建了自动任务,
   可能每次都要人工点确认 → 页面上要给提示(建任务时如果该会话不是「完全访问」,在表单里显示一行说明)。
6. **两个子系统都动 `test/rpc-registry.test.js` 的 GOLDEN**:R2/S2 阶段容易撞车,改的时候一并更新。

---

## 8. 需要你拍板的决定(见对话里的提问)

1. 左上角入口的形态(顶栏图标 / 左栏一行 / 两者都要)。
2. 任务到点但服务器未连接时的策略(等待重连 N 分钟 / 直接跳过 / 自动拉起 SSH)。
3. 「整个侧边栏照搬」的范围(只到变更对比 + 表头工具条 / 连标签体系一起做)。
4. 变更对比的语法高亮(首版不做 / 用现有 CodeMirror)。

---

## 附:dsh 关键文件索引(落地时按此对照)

**自动化任务**
- `packages/schedule/schedule/src/types.ts`(480)数据模型 · `storage.ts` 存储行 · `runtime.ts` 调度器 · `index.ts` 服务装配
- `packages/schedule/schedule/src/domain.ts`(1800+,**时间纯函数全在这**:daily/weekly/cron、DST、错过触发)
- `packages/schedule/tool-schedule/src/index.ts`(4 个模型工具 + JSON-Schema)
- `packages/client/ui-schedule/src/client/`:`index.ts`(装配与槽位注册)、`TaskManagerPage.tsx`、`TaskDetail.tsx`(2231)、
  `ScheduleCatalogAction.tsx`(会话头胶囊)、`SessionScheduleMark.tsx`(会话行标记)、`ScheduleCreateCard.tsx`(对话内卡片)、
  `task-manager-locales.ts`(中英文案,可直接抄)

**变更对比**
- `packages/deliverables/workspace-changes/src/compare.ts`(jsdiff structuredPatch + coarse 降级)
- `.../src/recorder.ts`(轮快照与汇总)、`capture.ts`(写前捕获)、`git.ts`、`numstat.ts`、`types.ts`(hunk/三态)
- `packages/client/ui-deliverables/src/client/FileDiff.tsx`(**算法与结构直接照抄**)、`FileDiff.module.css`(**像素规格**)、
  `ReviewTab.tsx` / `ReviewTab.module.css`(表头)、`ChangedFiles.tsx`(变更卡)、`review-store.ts`、`changes-diff.ts`
- `packages/client/ui-sidebar-right/`(右栏外壳)、`packages/client/ui-dockkit/src/contract/types.ts`(布局类型,若要扩 pane)
