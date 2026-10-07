# 自动化任务:按 deepseek-harness 逐字迁移(交接文档)

> 目标仓库:`E:\RJ\DmRJ\deepseek-harness`,对照 `packages/schedule/schedule/src/*`、
> `packages/schedule/tool-schedule/src/index.ts`、`packages/client/ui-schedule/src/client/*`。
> 本文只写**已验证的事实**、**两端的对应关系**与**还没迁的部分**。

---

## 0. 先说结论:现在的实现是不是 dsh 的?

**是**(服务端逐字移植 + dsh 自己的 spec 作证)。判定依据不是"我读过了",而是:

```
node test/dsh-schedule-specs.test.js   → 414 通过, 0 失败
node test/schedule.test.js             → 62 通过, 0 失败
node test/rpc-registry.test.js         → 23 通过, 0 失败(GOLDEN 含新 RPC/tool)
node test/tool-access.test.js           → 58 个工具全部声明 access
```

`test/dsh-schedule-specs.test.js` 跑的是 **dsh 仓库自己的 spec 文件**(`domain/daily/weekly/cron/recurrence`
五个 `.spec.ts` 原样复制到 `test/dsh-schedule/`,只改了 import 路径)。这五个文件是 dsh 对 DST 缺口/重叠、
"错过只补最近一次"、cron 边界、`decision < savedTarget` 守卫这些行为的**权威定义** —— 它们全绿,
说明时间语义没有第二种解释空间了。

> ⚠️ 之前那一版(只读方案文档、自己重写一套的那版)**不是** dsh 的语义,已整体废弃。
> 差异清单见 §3 —— 那些正是"看起来不一样"的地方。

---

## 1. 目录与模块对应(一眼能对上上游)

| 本仓库 | dsh 上游 | 说明 |
|---|---|---|
| `server/schedule/dsh/domain.ts` | `schedule/src/domain.ts` | 时间内核**逐字搬运**(Temporal polyfill 也一起搬进来了) |
| `server/schedule/dsh/types.ts` | `schedule/src/types.ts` | 记录/回执/目录/错误码类型 |
| `server/schedule/dsh/runtime.ts` | `schedule/src/runtime.ts` | 单定时器调度循环 |
| `server/schedule/dsh/storage.ts` | `schedule/src/storage.ts` | zod schema(可持久层不变量) |
| `server/schedule/dsh/delivery-history.ts` | `schedule/src/delivery-history.ts` | 回执追加 + 游标分页 |
| `server/schedule/dsh/update.ts` | `schedule/src/update.ts` | compare-and-set 更新 |
| `server/schedule/dsh/brands.ts` / `session-shim.ts` | session/llm/storage-domain 的符号 | dsh 那套包依赖 → 本地 shim |
| `server/schedule/service.ts` | `schedule/src/index.ts` 的 `ScheduleService` | 去掉 Cordis 装配,语义/FIFO/保留策略照搬 |
| `server/schedule/store.ts` | storage-domain + storage-json | 直接读写 `schedule.json` 的**同一份 JSON 形状** |
| `server/schedule/delivery.ts` | `sessionController.resolveAgent` + `agent.followup` + `sessions.flush` | 唯一的"宿主适配"层 |
| `server/schedule/holder.ts` | cordis 的 inject | 打破 agent ⇄ delivery 的循环依赖 |
| `server/agent/schedule-tools.ts` | `tool-schedule/src/index.ts` | 4 个模型工具(描述逐字英文原文) |
| `server/api/rpc/schedule.ts` | `ScheduleService` 的 `@Remote` 方法 | list / catalog / history / update / delete |
| `server/api/rpc/schedule-preview.ts` | —— | **本项目特有**:规则预览,见 §2 |
| `web/src/components/SchedulePanel/` | `client/ui-schedule` | 页面(语义对齐;见 §4 未迁部分) |

---

## 2. 两端**有意保留**的差异(不要当 bug 修)

1. **没有 `schedule_create` 这个 RPC**:dsh 也不给界面直连创建 —— 它的「+ 新建」是"开一个新会话,
   让模型用 `schedule_create` 建"。本项目同样把新建交给模型(页面的「+ 新建」只是切到对话页)。
2. **多一个 `schedule_preview`**:dsh 的界面用 `client/task-cron.ts` 在前端自己算 cron 预览;
   本项目让服务端用**同一份 `dsh/domain.ts`** 算(避免两套时间逻辑),入参与创建选择器逐字同形。
3. **保留窗口**取 dsh 的默认值(30 天 / 200 条,见 `service.ts` 顶部注释)。
4. **唤醒兜底**:dsh 只在"持久变更"后 `requestDrive()`;本项目额外每 60s 兜底唤醒一次
   (`service.start()`),用来把"当时服务器没连/模型没配、现在能跑了"的任务捞回来 ——
   调度本身仍是"闹钟定到下一个到期时刻",这个定时器不参与触发计算。
5. **投递确认的语义**:dsh 有 `sessions.flush(session)`(inbox 落盘确认);Teleforge 的待执行队列只在
   内存里,所以 `delivery.ts` 把确认定义成"消息已被 agent 接受"。忙碌会话在排队期间被杀会丢这条提醒 ——
   与用户手打一句话在同一情形下的遭遇一致(已写在 `delivery.ts` 文件头)。

---

## 3. 与"上一版自写实现"的差异(用户看到"不一样"的地方)

| 维度 | 上一版(已废弃) | 现在(dsh) |
|---|---|---|
| 状态 | `enabled` + `completed` 两个布尔 | 只有 `status: 'active' \| 'inactive'` |
| 运行记录 | `success/failure/skipped/missed` 四种记录 | **只有投递回执**(`lastDelivery` + `deliveryHistory`,含 `messageId`);失败**不写记录**,只 warn |
| 定时器 | 固定 30s 轮询 | **单个 setTimeout 追最近到期时刻**(加长延迟分段,`unref`) |
| 触发目标 | 每次按规则重算 | **存已提交的 `scheduledAt`**,投递后改写成下一个目标 |
| 错过 | 一次性任务超 5 分钟不补发 | 一次性任务**迟到多久都补投一次**;重复任务只补最近一次(无时间上限) |
| 离线 | 等 5 分钟 → 记 missed | **没有等待窗口**:投递失败只 warn,任务保持 active 等下轮唤醒 |
| 投递正文 | 直接把 prompt 当用户消息发进去 | `[SCHEDULE REMINDER]` / `[SCHEDULE REMINDER BATCH]` 固定框架(JSON 载荷) |
| 同批 | 每个任务各发一条 | **同会话的重复任务合成一条消息**,共享 `messageId`,但每个成员各写一行 |
| 编号 | `schedule-<uuid>` | `schedule-<N>`(单调、删除后不重用) |
| 暂停/立即执行 | 有 | **没有**(dsh 没有;要停就删,要立刻跑就改时间到近处) |

---

## 4. 还没迁的部分(下一轮的清单)

**UI 还差"逐字照抄"这一步**。当前 `SchedulePanel` 已经用的是 dsh 的**语义与数据面**
(catalog / history / 状态筛选 / 已结束只读 / compare-and-set 保存 / 无暂停无立即执行),
但 dsh 的界面还有这些没搬:

1. `TaskDetail` 的**规则编辑器**:dsh 用 `DatePicker`(月历)+ `ClockPicker`(三列时/分/秒)+
   dsh 的「重复」下拉(每周 / 周一至周五 / 每天 / 每 N 小时 / 每 N 分钟 / 每 N 秒 / 仅一次 / 自定义)
   + cron 的**结构化子编辑器**(CronRows:每月/每周/每天/每小时/每分钟/原生表达式),本仓库现在用的是
   原生 `<input type=date|time>` + 扁平 chip,功能等价、交互不等价。
2. `TaskMenu`(详情头 `⋯` 菜单)/ `DeleteToast`(全局删除结果提示,本仓库现在用现有 toast)/ `CatalogFeedback`。
3. 会话内三处集成 + 右栏页签:`ScheduleCatalogAction`(会话头胶囊)、`SessionScheduleMark`(会话行时钟)、
   `ScheduleTurnCard`/`ScheduleCreateCard`(对话内卡片)、`ScheduleTaskTab`(右栏任务详情 tab)。
4. `task-cron.ts` 的浏览器端 cron 预览句(当前用服务的 `schedule_preview`,属于 §2 的有意差异)。
5. `relative-clock` 的 30s 节奏(本仓库已按 30s 刷新相对时间)。

---

## 5. 本轮踩到的坑(务必记住)

1. **上一轮被后端崩溃打断,留下一批"看起来已完成"的文件**;本轮开工时**误把 `server/schedule/` 下的
   `types.ts / domain.ts / runtime.ts / delivery-history.ts / store.ts` 覆盖成另一套自写实现**。
   `store.ts` 是 `service.ts` 的唯一依赖,覆盖后服务起不来;已按 `service.ts` + `test/schedule.test.js`
   要求的契约重写回 dsh 形状(unit/global/tables.tasks、键 = record.id、zod strict、2 空格缩进 + 原子写),
   另外 4 个多余文件已删除。**教训:动手前先看 `git status` + 目录里已有哪些文件,别急着写。**
2. **测试里的 `throwsCode` 必须 await**:服务方法都是 async,校验失败是"拒绝的 Promise";
   原来的同步 `try/catch` 抓不到,未处理的拒绝直接把测试进程打崩(本轮修的就是这个)。
3. **本工作区同时有别的会话在动手**:实测到另一个会话在改 `web/**/*.scss`、跑 `vite`(5173)、
   并且 `node_modules/@codemirror` 一度被删空(它随后装回来了)。改共享文件前先 `git status` 与看时间戳。

---

## 6. 复验命令

```bash
node test/dsh-schedule-specs.test.js   # dsh 自己的 414 项 spec(时间语义权威)
node test/schedule.test.js             # 存储形状 / 服务层 / 运行时投递 / 模型工具 / RPC
node test/rpc-registry.test.js         # RPC + tools GOLDEN
node test/tool-access.test.js          # 58 个工具的 access 声明
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json          # 前端
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.server.json   # 服务端
npm run build
```

界面实测入口:`set PORT=4010&& set SCHEDULES_FILE=_tmp_schedules.json&& node server/index.ts`
(用一份临时任务库,避免动到真实数据;页面上「🕘 自动化任务」= 标签条第三个固定标签)
