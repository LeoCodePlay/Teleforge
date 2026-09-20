# 与 deepseek-harness 的 AI 对话 / Agent 能力对齐审计

审计对象:
- **A(本项目)** = `F:\Dm\companyProject\自己\远程ssh工具`(teleforge,SSH 远程 AI 编程工具)
- **B(参照基准)** = `E:\RJ\DmRJ\deepseek-harness`(dsh,基于 Cordis 的插件化 agent harness)

结论速览:**A 在"行为目标"上已经大面积对齐 B**(turn/step 生命周期、事件溯源、`deriveMessages()` 投影、runtime-context 快照、有界滚动工具池、compaction 阈值 0.8/0.16、tool-result pruner 8192/4096/1024、spill 50KB、重复调用提醒、`MAX_PARALLEL_TOOL_CALLS=10` 等常量都逐条照搬),但**几乎完全没有对齐 B 的"机制"**:B 的一切都是可配置、可插拔、可回放的服务(seam),A 是硬编码的单体实现。差距的根因是架构形态,而不是功能缺失。

---

## 1. 总体架构差异(根因)

| 维度 | A(本项目) | B(dsh) |
|---|---|---|
| 形态 | 单体 Node 服务,`server/agent/agent.ts` 2042 行单文件承载驱动循环 + 会话 + 宿主 | Cordis 插件树,~250 个 `@deepseek-ai/dsh-*` 包,每个能力是 Service Definition / Provider / Consumer 三段式 seam |
| 扩展方式 | 改代码后重新构建(Tauri 打包) | 挂载插件 / `cordis.patch.yml` 覆盖任意行(`dsh --profile web --dump-config`) |
| 配置 | `server/config.ts` 常量表 + `settings-store` | 插件 `Config` schema,行级 patch,`!!js` 条件组合 |
| 依赖关系 | 与 B **零代码依赖**(`package-lock.json` 中无 `deepseek-ai`/`cordis`/`schemastery`),移植靠人工重写 + 注释标注来源 | 自身 |

> 因此"对齐"不能按"补几个功能"理解。下面按**投入产出比**分三档给出可执行路径。

---

## 2. AI 对话链路对比

### 2.1 Agent 主循环 / turn-step 生命周期

| 项 | A | B | 差距 |
|---|---|---|---|
| turn/step 语义 | `turn/start` → 若干 `step/start…step/end` → `turn/end`,结束原因 `completed/aborted/error/max-tokens`(`agent.ts:1345-1665`) | 同语义,`ReactLoopAgent.turn()`/`step()`(`packages/core/agent-loop/src/agent.ts:246-401`) | **语义基本对齐** |
| 迭代上限 | 无上限,靠"无 tool_calls"收敛(`agent.ts:1343-1345`) | 无上限,同语义 | 对齐 |
| max-tokens 粘性 | 有(`agent.ts:1604-1606`) | 有且显式注释粘性(`agent.ts:285-290`) | 对齐 |
| 收尾钩子 | 无 | `agent/turn-stopping`(serial,可被插件否掉收尾)(`agent.ts:295-299`) | A 缺:插件无法延期收尾 |
| pre-step 拦截 | 无 | `agent/pre-step` waterfall 可改写/拒绝本步消息(`agent.ts:225-243`)、`agent/request` waterfall 可改请求配置(`:438-441`)、`agent/request-error` waterfall 可决定重试(`:355-369`) | **A 缺三个扩展点**,注入/拦截/重试策略全部硬编码 |
| 维护态 | 无 | `runMaintenance()` 独占 idle 期(`agent.ts:142-162`),`/compact` 走这里 | A 手工 `rt.busy` 标志(`agent.ts:911-914`) |
| 取消语义 | 每轮一个 `AbortController`(`rt.signal`) | 每次 activity 一个,`cancel(cause, {keepInbox})`,`wakeRequested` latch 与 abort 竞态有专门处理(`agent.ts:113-140`, `:172-193`) | A 无 latch:中止瞬间到达的输入分类不确定 |
| 多会话 | 每会话一个 runtime,`busy/steer/inbox/pending`(`agent.ts:190-220`) | `Inbox` 服务 + `send(target,wakeup)` 三入口 `followup`/`steer`/`inject`(`agent.ts:113-132`) | 对齐;A 的 `inject`(不唤醒)由内部提醒模拟 |

### 2.2 Inbox / 输入路由

- A:`inbox`(next-turn)、`steer`(next-step)、`pending`(待执行队列,FIFO + 队列项 id 供前端立即执行/删除)(`agent.ts:195-198`, `submit`/`steerQueueItem`/`removeQueueItem` `:1050-1120`)。
- B:单一 `Inbox`,两个目标 `next-turn`/`next-step`,外加 **不唤醒注入** `inject()`(`agent.ts:130-132`)。
- 差距:A 的队列在 runtime 内存中,进程重启丢失;B 的 inbox 消息本身以 `user/message` 落日志,可回放。

### 2.3 LLM 请求构造

| 项 | A | B |
|---|---|---|
| 端点 | OpenAI 兼容 `POST {baseUrl}/chat/completions`(`llm.ts:122`) | `ctx.llm` seam,`llm-deepseek` / `llm-pi-ai` 适配器,`prepareCall()` 解析 exact-model 默认值(`agent.ts:449-455`) |
| 消息 | `[{role:'system'}, ...deriveMessages()]`(`agent.ts:1456`) | `header.system` + `deriveMessages()`,system 作为 `request/header` 的一部分被记录 |
| 工具 schema | `registry.schemas({localOnly})`,白名单 name/description/parameters(`registry.ts:94-110`) | `ctx.tools` 收集 + `orderTools()` 规范排序(可配置 `toolOrder` + `<unlisted-tools>` 占位)(`system-prompt/src/index.ts:164-183`) |
| 推理参数 | 按模型族硬编码分支:DeepSeek v4 → `thinking:{type}`+`reasoning_effort`;GLM → `thinking`;Qwen → `enable_thinking`;o/gpt-5/grok → `reasoning_effort` 映射(`llm.ts:144-161`) | 适配器声明 `reasoningEffort`/`maxTokens` 默认,`requestProposal()` 剥离适配器派生值后交给 `agent/request` waterfall(`agent.ts:55-61`) |
| 其它参数 | 仅 `model/messages/stream/max_tokens/tools/tool_choice`(`llm.ts:124-133`) | 同族 + `deepFreeze` 冻结 + `markAgentLoopRequest` 标记 |
| 请求信封记录 | **无**(system/tools/窗口都是局部变量,`agent.ts:1390-1395`) | `request/header`(canonical,`initial`/`resume`/`change` 三态)+ `request/context{provider,model,contextWindow}`(`agent.ts:458-483`) |

### 2.4 流式解析

| 项 | A | B |
|---|---|---|
| 解析 | 自写 SSE:按 `\n` 切行、`data:` 前缀、`[DONE]` 结束(`llm.ts:598-692`) | `ctx.llm.stream()` 产出 `assistant/chunk` 事件,**每个 chunk 落日志**(`agent.ts:347-351`) |
| delta 种类 | `text` / `reasoning` / `tool_args`(`llm.ts:609-633`) | `BlockAssembler` 结构化 block(text / reasoning / tool-call),`finish` 给出 `kind: ok|max-tokens|error|aborted` + `usage` + `replayState` |
| 工具参数累积 | `toolAcc: Map<index, {id,name,args}>`,字符串拼接,`id` 缺失时兜底 `call_<random>`(`llm.ts:679-685`) | `BlockAssembler` + `assistant/chunk` 事件持久化,`chunk-rows.ts` 投影聚合 |
| 截断检测 | 无 `finish_reason` 也无 `[DONE]` → 抛错重试,只给一次机会(`truncatedRetries`)(`llm.ts:640-647`) | chunk 级事件持久化,重放可判定 |
| 中止 | `signal.aborted` → 抛「已停止」 | `signal.throwIfAborted()`,abort 时已写事件保留 |

### 2.5 重试 / 错误策略

| 项 | A | B |
|---|---|---|
| 预算 | `LLM_RETRY{BUDGET_MS:600000, MAX_ATTEMPTS:20, IDLE_MS:60000, BASE_DELAY_MS:1000, MAX_DELAY_MS:30000}`,可用环境变量覆盖(`llm.ts:467-472`) | `llm-retry` 插件,`policy{mode, initialDelayMs, maxDelayMs, jitterRatio}`,并且 **`providerRetryAfterMs > maxDelayMs` 时单独处理**(`llm-retry/src/index.ts:197`) |
| 退避 | 指数 × 2,与 `Retry-After`/`retryAfterSeconds` 取大,±10% 抖动(`llm.ts:502-506`) | 指数 + `jitterRatio` 抖动(`:60-62`) |
| 可重试判定 | `status>=500 || 408/409/425/429`(`llm.ts:509-512`) | 按 `LlmError.code` / failure 分类 |
| 流中断重试 | 是,`discard=true` 让上层回滚半成品(`llm.ts:258-271`, `agent.ts:1486-1493`) | 由 `assistant/chunk` 日志天然支持重放 |
| 爆窗恢复 | 文案正则识别(排除限流),折叠 + 强制压缩 + 重试,`MAX_OVERFLOW_RECOVERIES=1`(`llm.ts:698-703`, `agent.ts:1501-1543`) | 结构化 `CONTEXT_WINDOW_EXCEEDED_CODE`,走 `agent/request-error` waterfall,`maxOverflowRetries=1`(`compaction-basic`) |
| 工具不支持降级 | 文案正则 → 回滚整轮 → 纯对话模式,`CHAT_ONLY_TTL_MS=10min`(`agent.ts:1546-1560`) | B 无此降级(适配器缺失即 `NO_ADAPTER` 报错) |
| 生图端点 | 不重试(按张计费)(`llm.ts:277-279`) | 无对应能力 |

### 2.6 用量与缓存

| 项 | A | B |
|---|---|---|
| 解析字段 | 仅 `prompt_tokens` / `completion_tokens`(`llm.ts:686-688`) | `input` / `cacheRead` / `cacheWrite` / `output`,含 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`(`llm-deepseek/src/translate.ts:47-59`) |
| 缓存可见性 | **无**,无法判断"稳定 system 前缀"是否真的命中 | 端到端:adapter → usage fold → `tokenUsage` 投影 → trajectory UI(`usage-projection.ts:31-36`, `ui-trajectory/src/client/layout.ts:936-937`) |
| 用量是否参与水位 | 不参与,显示用 | 作为保守锚点:provider 上报 ≥ 估算时才切换 `baseline.kind='usage'`(`token-meter/src/index.ts:232-260`) |
| 前缀复用 | **被破坏**:摘要调用 `tools: []`(`compact.ts:292-302`) | 刻意复用:`header.system` + `header.tools` + region messages(`region.ts:488-514`) |

---

## 3. 上下文处理对比

### 3.1 system prompt 组装

- **A**:单一 `_systemPrompt(reasoning)`,字面量数组 `join('\n')`(`agent.ts:1999-2032`),内含身份行、4 行工具用法、`规则:` + 1-11 条编号规则、`renderPromptInjectSection()` 追加的用户注入。
- **B**:`ctx.systemPrompt` **有序 section 注册表**,`order` 升序排序,重复名报错,scoped 层遮蔽全局,`complete:true` 独占覆盖,`system-prompt/assemble` waterfall 可整体改写;`{{provider}}/{{model}}/{{cwd}}` 变量严格插值(未知变量抛错);已注册 **26+ 个具名 section**(`harness:identity` −100 … `ui:deliverable-file-references` 190)。
- 差距:A 的 prompt 变更必须改代码重构建;无法按会话/按模式/按 agent 差异化;无顺序与覆写语义。**这是 prompt 工程层面最大的结构性差距。**

### 3.2 运行时上下文

- A:`<runtime_context>` user 消息,`source:'runtime'`,内容含权限模式、远程/本地平台与工作区(含"不在工作区"全盘模式)、技能目录、最近远程/本地环境探测(各限 6000 字符);`rt.lastContextText` 变化才追加(`agent.ts:1942-1982`, `:1376-1380`)。
- B:同构,但由多个 `PromptContext` 贡献者合成,**按贡献者署名**(`ContextSnapshotSection[]`),并在被压缩遮蔽时失效重发 `CLEARED` 标记(`runtime-context.ts:64-75`, `:13`, `:50-54`);状态可由日志扫描恢复(`:34-56`),A 只在内存里。
- B 独有上下文源:A **完全没有** `time-context`(年月日/时区,可节流)、`agent-instructions`(`AGENTS.md`/`CLAUDE.md` 自动读入工作区约定)、`session-reference`(跨会话引用)、`tmux-context`、`sandbox:policy`、`approval:policy`、`subagent:delegation`。

### 3.3 预算与计量

| 项 | A | B |
|---|---|---|
| 窗口来源 | 用户手填每模型 `contextWindow`(`providers.ts:15-18`),未填为 0;`||128000` 仅手动压缩兜底(`agent.ts:928`) | 适配器目录权威值 `resolveModelInfo().context.contextWindow`,校验正整数并记入 `request/context` |
| 估算器 | CJK 1.6 字/token、ASCII 3 字/token、每消息 +12(`compact.ts:23-26`, `:39-41`) | 固定 4 字/token + block/role overhead,`estimateContent/estimateMessage/estimateHeader`(`token-meter/src/estimate.ts:13-19`, `:26-87`) |
| 触发布局 | 每步现算 `measureMessages(history) + reservedTokens`(`agent.ts:1395`, `compact.ts:233`) | `meter.measure(session).totalTokens` 由日志投影增量维护(O(1) surface fold) |
| 仪表盘口径 | `measureMessages([system, ...history])` —— **不含工具 schema**,与阈值口径不一致(`agent.ts:1570` vs `:1395`) | `contextBreakdown{systemTokens, toolsTokens, messageTokens}` + `contextPressure{contextWindow, pressureTokens, projectedTokens}`(预测**下一次**请求) |
| 输出预留 | 注释声称"扣除输出预留"但 `resolveCompactSpec()` 完全忽略 `maxTokens`;`COMPACT.SUMMARY_MAX_TOKENS` 是死代码(`compact.ts:3`, `:17`, `:54-62`) | `maxTokens` 是真实按路由配置项并传给摘要调用 |

### 3.4 裁剪 / 压缩

| 项 | A | B |
|---|---|---|
| 工具结果裁剪 | `pruneToolResults`,三处调用:绝对地板(每步,keepRecent 6 / minChars 2000)、水位内(keepRecent 0 / 8192)、爆窗(同前) | `ToolResultPruner.pruneSession`,仅在水位/爆窗合格后、区间选择前运行并重新计量 |
| 裁剪持久性 | **仅投影层**,日志不动 | 追加 replacement + `compaction/prune` shadow-price 事件,**持久** |
| 消息级裁剪 | 有:`trimMessagesByBudget` 按字符预算从对话组头部整组丢弃,首条 user 锚点常驻(`agent.ts:1455`, `session.ts:369-393`) | **无**此机制(刻意不做,宁可压缩) |
| 绝对地板 | `ABS_FLOOR_TOKENS=60_000`(A 自加,B 无对应) | — |
| 阈值 | 0.8 / 保留 0.16 / 摘要 8192(`compact.ts:14-26`) | `DEFAULT_THRESHOLD_RATIO 0.8` / `DEFAULT_RETAIN_RATIO 0.16` / `maxTokens 8192` / `compactionRetries 1` / `maxOverflowRetries 1`,**支持 `modelPolicies` 按 provider/model 逐条覆写**(`config.ts:20-23`, `:105-125`) |
| 区间选择 | 尾部按 token 累积到 `retainTokens`,切点回退对齐工具配对;不要求 ≥2 个 user 组(`compact.ts:84-114`) | 同算法,改为按 priced surface node 累积,带 meter/surface 一致性断言(`region.ts:98-134`) |
| 摘要调用 | `[system, ...dropMsgs, instruction]`,**`tools: []`**,无 `max_tokens`、无 `purpose`(`compact.ts:292-305`) | 重放 `header.system` **+ `header.tools`** + region messages,带 `maxTokens`/`sessionId`/`purpose:'compaction'`(`region.ts:498-514`) |
| 质量校验 | shrink 校验(摘要 token ≥ 被压 token 即放弃)(`compact.ts:263-268`) | framed checkpoint 计价 + `MAX_TOKENS` 截断硬失败 + surface 稳定性前后校验(`region.ts:373-378`, `:387-424`) |
| 失败行为 | 自动路径**静默降级为直接截断**(只留首条 user 锚点),无任何失败记录(`compact.ts:274-287`) | fail-closed,每次失败仍追加 `compaction/end{error}`,手动压缩有 6 类错误码 `busy|cancelled|changed|summary|commit|persistence`(`compaction/src/index.ts:28-57`) |
| 落盘 | 检查点事件 `compaction/done{summary,dropCount,manual,dropThroughSeq}` + 即时 flush(`session.ts:298-307`, `agent.ts:1428`) | 锁括号 `compaction/start|summary|end` + `surfaceOp:'replace'` 真实面替换 + `flush()` 耐久点 |
| 手动压缩 | `/compact`(RPC `compactNow`),`rt.busy` 拒绝;保留地板 `max(floor(win*0.16), 4000)` + 最小收益 1000 token,可能成为 no-op(`agent.ts:911-953`, `compact.ts:155`) | `/compact` 走 `runMaintenance`,`retainTokens=0` 全额可压,无最小收益门槛(`compaction-basic:379-384`) |

---

## 4. 工具调用对比

### 4.1 工具清单差异

**A 的 22 个工具**(`tools.ts`):`list_directory` `read_file` `write_file` `edit_file` `run_command` `create_directory` `delete_path` `search_code` `todo_write` `skill` `skill_copy_builtin` `get_workspace_info` `web_search` `list_local_dir` `read_local_file` `write_local_file` `edit_local_file` `create_local_dir` `delete_local_path` `search_local_code` `run_local_command` `get_local_info` `ask_user_question` `generate_image`(+ `browser-tools.ts` 的浏览器控制工具)。本地侧是远程工具的一一镜像,这是本项目的领域需要,不算差距。

**B 独有、A 完全没有的能力域**:

| 能力域 | B 的包 | 对 A 的价值 |
|---|---|---|
| 子代理 / 委派 | `subagent/*`(in-process / fork / spawn / DSH-SDK / ACP / Claude Code / Codex 六种 provider)、`tool-subagent{,-control,-report}` | 高:远程探索类任务可并行化。**A 已落地 in-process 只读版**(`subagent` 工具 + `agent/subagent.ts`;只有一种 provider、只读白名单、无后台/续聊,见 `docs/superpowers/plans/2026-09-19-subagent-in-process.md`) |
| 工作流批量编排 | `workflow/*` + `tool-workflow`(worker-thread 执行 JS 脚本) | 中 |
| Ralph 循环 | `workflow/tool-ralph` | 低-中 |
| 后台任务 | `jobs/*` + `tool-jobs`(`job_output`/`job_kill`) | 高:长命令不该阻塞 step |
| 持久终端 | `terminal/*` + `tool-terminal` | 高:SSH 场景天然需要 |
| LSP | `lsp/*` + `tool-lsp` | 中:远端语言服务 |
| MCP | `mcp/mcp-client` | 高:接外部工具生态 |
| Code mode | `core/tools/src/code-mode.ts`(工具在代码里调,而非逐个 tool-call) | 中 |
| 会话检索 | `session-query/*` + `tool-session-query` | 中 |
| Goal / 计划 | `goal/*` + `tool-goal`、`plan/plan-mode` + `exit_plan_mode` 工具 | 高:计划模式目前只是 guard 拒绝 |
| 自省 / 自改 | `extensions/tool-cordis` | 低 |
| 结构化输出 | `subagent-in-process-driver/src/structured.ts` | 低 |

### 4.2 注册、schema 与执行管线

| 项 | A | B |
|---|---|---|
| 注册 | `Map<string, ToolDef>`,`register()` 返回 disposer;`guard()` 单调守卫链(`registry.ts:52-75`) | `ctx.tools.register()`,effect 化,scope 隔离(同一 session 可有不同工具集) |
| schema | 手写 `parameters` JSON,白名单投影 + 启用名缓存(`registry.ts:94-110`) | 从类型/JSON schema 工具生成(`schema.ts`/`json-schema.ts`/`ts-types.ts`/`py-types.ts`),规范排序 |
| 渲染意图 | 无(A 由前端按工具名 `switch` 决定卡片,见 `web/src/utils/toolRowModel.ts`) | 工具声明 `presentation`(generic/terminal/diff + locations),由 `agent-tool-presentation` 统一消费(`core/tools/src/presentation.ts`) |
| 并发 | `concurrencySafe` 显式声明,fail-closed;`mutating` 强制独占;有界滚动池 `MAX_PARALLEL_TOOL_CALLS=10`;结果按模型顺序提交(`agent.ts:1812-1888`) | `executionMode(exec)` 每次重新分类(注册表运行中变化立即生效),`DEFAULT_MAX_PARALLEL_TOOL_CALLS=10`,滚动池 + `commitReady()` 有序提交,**中止时给未启动调用补合成结果保证日志可回放**(`tool-calls.ts:59-259`) |
| 参数解析 | `JSON.parse`,非对象/非法 JSON → 结构化错误(`registry.ts:136-142`) | `parseArguments` 保留非法 JSON 原文、空输入映射 `{}`,交给 pre-execute 校验 |
| 超时 | 注册表兜底 660s + 工具自声明 `timeoutMs`;`runWithTimeout` 竞速(`registry.ts:16`, `:173-182`) | `guard/timeout-policy` 读取工具 `timeoutMs`,`TOOL_TIMEOUT` 结构化错误码,用 `deadline()` 组合嵌套信号 |
| 中止合成结果 | A 在 `finally` 里补 `tool/result`「工具执行中止」(`agent.ts:1658-1664`) | 同语义,且在**未启动**的调用上也补(`TOOL_ABORTED_BEFORE_DISPATCH`)(`tool-calls.ts:249-259`) |
| spill | `SPILL_MAX_BYTES=50_000` 头尾对半 + UTF-8 边界安全,read 豁免(`registry.ts:184-210`) | 独立 `spill` seam(`ctx.spillStore`)+ `spill-policy` |
| 循环卫生 | 重复调用提醒阈值 `[3,5,8]`,参数预览 500 字符,`internal` 提醒不跨轮(`agent.ts:1920-1934`) | `guard/repeat-tool-reminder` 插件 |
| 权限 | 4 档预设 `confirm/auto-edit/plan/full-access` 混在**一个** guard 里,复用 ask-user 弹窗审批(`permission.ts:99-140`);模式值编码为 `permission/mode` 事件 | **两个正交旋钮**:`sandbox/mode`(沙箱模式)+ `approval/policy`(`ask`/`never`),预设只是旋钮的组合(`permission-presets/src/index.ts:56-62`);审批走独立 `user-approval` seam,`answerer` 可替换、可审计(`ask`/`outcome` 成对落会话日志)、无 answerer 时 fail-closed |
| 危险默认值 | `toolAccess()` **对未登记工具 fail-open**:未列入 `WRITE_TOOLS`/`COMMAND_TOOLS` 的名字一律当 `read` 放行(`permission.ts:70`, `:101`);新增写类工具若忘记登记就静默越过审批。对比:`concurrencySafe` 是 fail-closed(`registry.ts:113-117`)——两处默认值方向相反 | 工具注册时即声明 schema 校验函数,调用前 `validateArgs()` 强校验(`core/tools/src/schema.ts:478`) |
| 审批"记住/白名单" | 无。`confirm` 模式下每次写/命令都重新弹窗,无持久化放行、无按路径/命令白名单(只有"整工具禁用"的 `tool-settings.ts`) | 见阶段 4 第 18 项(待补:审批策略持久化语义) |
| schema 校验 | **手写 JSON**,注册表不做 required / `additionalProperties` 校验;未知参数原样透传给 `run`(`registry.ts:136-142`) | 类型驱动:`additionalProperties` 必须显式声明,`required` 由 `required: true` 注解推导,`validateArgs(spec, args)` 在调用前执行(`core/tools/src/schema.ts:366-372`, `:438-455`, `:478`) |
| 工具结果形态 | `content` 是**纯字符串**(`registry.ts:45`) | `content: ContentBlock[]`(**内容块**,可含文本/图片等)`+ isError`(`core/tools/src/types.ts:22`, `:44-47`) |
| 工具呈现模式 | 无;模型永远看到全部可见工具的 schema,UI 由前端按工具名 switch(`web/src/utils/toolRowModel.ts`) | `presentation` 两档 `native`(默认)与 `code`(Code Mode,注册保留名 `run_code` 作为传输通道)(`core/tools/src/index.ts:656`, `:1055`, `:1086`);工具可声明 `output.schema/render/presentationMeta` 由 `presentationMeta()` 生成可回放的呈现投影(`:1806-1813`) |
| 工具超时声明 | `timeoutMs` 挂在 `ToolDef`,注册表兜底 660s(`registry.ts:16`) | `timeoutMs` 必为正有限数并在注册时校验(`core/tools/src/index.ts:1046-1049`) |

### 4.3 沙箱与工作区边界(**安全相关,优先看**)

| 项 | A | B |
|---|---|---|
| 机制 | **无沙箱**。远程侧靠 `ssh-manager` 的工作区路径拼接 + 越界检查(`server/agent/tools.ts:37-56` `resolveInWorkspace`),本地侧靠 `local-fs.ts` 的同构检查;命令类工具只有高危命令正则守卫 | 独立 `ctx.sandbox` seam + `sandbox-policy` 上下文贡献者;**fs/subprocess/shell provider 共享同一个执行世界**——换一个 sandbox provider 就同时改变 Bash、PTY、LSP 的边界(`docs/architecture.md:100-102`) |
| 拒绝语义 | 路径越界 → 工具结果报错(`路径超出工作区,被拒绝`) | `sandbox/mode` 是 lo'g-only 的用户意图事件,策略由 `sandbox-policy` 渲染进上下文,执行时由 backend 强制 |
| 缺口 | A 的边界只在工具实现里逐个检查;命令执行无路径约束(模型可 `cd /` 或用绝对路径操作工作区外文件)。这在"远程服务器"场景是**产品预期**(整台服务器可操作),但本地侧与"不在工作区对话"模式边界模糊,值得明确定义 | — |

| ask-user | 进程内 pending Map,支持取消/中止/断连宽限(`ask-user.ts:62-142`) | `interaction/user-questions` seam,同样支持多问题/选项/多选 |

---

## 5. 会话与事件模型对比

| 项 | A | B |
|---|---|---|
| 事件信封 | `{seq, time, type, data}`(`session.ts:80-85`) | `{seq, time, type, data, scope?, ignorable?, surfaceOp?, sourceEventSeqs?}` |
| 事件类型 | 9 个:`turn/start` `turn/end` `step/start` `step/end` `user/message` `assistant/message` `tool/call` `tool/result` `todo/write` `compaction/done` `image/generated` | 30+ 个,含 `assistant/chunk`(原始 chunk 全量落盘)、`request/header` `request/context`、`permission/preset` `sandbox/mode` `approval/policy`、`plan/mode`、`compaction/start|summary|end`、`compaction/prune`、`job/*`、`subagent/*` 等 |
| 原始流式事件 | **不落盘**(只落最终 `assistant/message`),前端靠 WS `text_delta` | `assistant/chunk` 逐条落盘,重放保真度与 UI 重放都基于它 |
| 未知事件容忍 | `SessionEventType = keyof Map | string`(任意类型可写入,无版本兼容语义) | `SessionEventMap` 成员默认 required-on-read,未知类型拒绝加载,除非事件带 `ignorable:true`;结构化变更才 bump `SESSION_FORMAT_VERSION` |
| 消息投影 | `deriveMessagesWithTrace()`,`user/message`→user、`assistant/message`→assistant、`tool/result`→tool、`compaction/done`→摘要 user;空 assistant 跳过;孤儿 tool/result 过滤(`session.ts:153-260`) | `deriveMessages()` + `surface` 位置模型;`isAppendSurfaceEvent` 是人类记录源,replacement 只在模型面;`repair.ts` 修复孤儿/缺失 |
| 破坏性操作 | 有 `truncate(seq)`(整轮回滚)与 legacy `squash()`(`session.ts:110-113`, `:267-286`) | **无破坏性回滚**,只有 surface replacement(append-only 严格保证) |
| "可回放"保证 | `_heal()` 构造期补未闭合工具结果(`session.ts:100`, `:317-343`) | 运行期不变量断言 + `repair.ts` + surface provenance 校验 |
| 持久化 | `sessions.json` 索引 + 每会话 `sessions/<id>.json`(`{version:2, events}`),临时文件 + rename 原子写,`MAX_EVENTS=50000` 截尾(`session-store.ts:1-81`) | `session-persistence` seam + JSONL / SQLite 两种后端,chunk 化,coordinator 契约,checkpoint-policy 在每次 adapter dispatch / 顶层工具体**前**做 fail-closed 耐久点 |
| 分支 / fork | `forkSession(turnIndex)` 按消息面 turn 下标切事件日志并重编号,`_heal()` 事后修复(`agent.ts:629-663`) | `sessions.fork(source, boundary, childId)` **校验边界**:落在未闭合 turn 内直接拒绝,并校验连续性与存在性(`core/session/src/index.ts:1081-1132`) |
| 投影缓存 | 无(每次重算) | `session-projection` + `session-projection-cache`,O(1) surface fold |
| 其它会话服务 | 无 | `session-title*`(3 种命名策略)、`session-stats`、`session-telemetry`(+OTel)、`session-query`(+SQLite)、`session-log-export` |

---

## 6. 前端 / 传输层

| 项 | A | B |
|---|---|---|
| 传输 | 自建 WS,事件全带 `sid` 供前端按会话路由(`server/core/ws.ts`) | Typert RPC gateway + 客户端 runtime 插件(`client/connection`、`client/runtime`) |
| 事件粒度 | 粗粒度业务事件(`text_delta`/`reasoning_delta`/`tool_call`/`tool_result`/`context_usage`/`compaction_*`/`turn_end`) | `session/event` 原样广播 + 客户端各自投影 |
| 客户端投影 | 前端手写节点模型(`utils/toolRowModel.ts`、`ChatPanel.tsx` 150KB) | 30+ 个 `client/ui-*` 插件,每个能力自带 UI 与投影 |
| 断线重连 | 靠 `get_history` 整表替换 + `rt.live` 半成品镜像补流 | `session/event` 重放 + 投影缓存增量 |
| 命令 | 硬编码 `/compact` `/clear` `/fork`(前端 `slashCommand.ts` 匹配 + 服务端 RPC) | `ctx.commands` 注册表,插件可注册命令与装饰器(`ui-commands`) |

---

## 7. 已完成对齐的部分(不要重复造)

以下 A 的实现已经逐条对齐 B 的语义与常量,**对齐工作应保留这些成果**:

1. turn/step 生命周期与结束原因(`completed`/`aborted`/`error`/`max-tokens`),max-tokens 粘性。
2. 事件溯源 + `deriveMessages()` 投影 + "模型可见即可回放" 原则。
3. runtime-context 作为 user 快照、system prompt 保持字节稳定以保护前缀缓存。
4. 有界滚动工具池、`concurrencySafe`/`mutating` 并发判定、结果按模型顺序提交、`MAX_PARALLEL_TOOL_CALLS=10`。
5. compaction 阈值 `0.8` / 保留 `0.16` / 摘要 `8192`、位置式区间选择 + 工具配对对齐切点、非破坏检查点。
6. tool-result pruner 默认值 `8192/4096/1024`、spill `50_000` 字节 + read 豁免。
7. `repeat-tool-reminder`、`concludesTurn`、`followup`/`steer` 两侧收件边界。
8. 非流式工具结果结构化错误("单个工具失败绝不终结整轮")。
9. DeepSeek thinking-mode 的 `reasoning_content` passback 规则。

---

## 8. 差距总表(按影响排序)

| # | 差距 | A 侧证据 | B 侧证据 | 影响 |
|---|---|---|---|---|
| 1 | system prompt 无 section 注册表 / 顺序 / scope / 覆写 | `agent.ts:1999-2032` | `system-prompt/src/index.ts:381-542` | 极高 |
| 2 | 无请求信封记录(`request/header`/`request/context`) | `agent.ts:1390-1395` | `agent.ts:458-483`, `request-header.ts:21-70` | 极高 |
| 3 | 无缓存命中可观测性(只用 prompt/completion) | `llm.ts:686-688` | `llm-deepseek/src/translate.ts:47-59` | 高 |
| 4 | 摘要压缩调用丢弃工具 schema,破坏缓存前缀 | `compact.ts:292-302` | `region.ts:488-514` | 高 |
| 5 | 压缩失败静默降级为截断,无失败记录 | `compact.ts:274-287` | `compaction/src/index.ts:28-57`, `region.ts:218-229` | 高 |
| 6 | 仪表盘口径与压缩触发口径不一致(前者不含工具 schema) | `agent.ts:1570` vs `:1395` | `breakdown-projection.ts:42-69` | 高 |
| 7 | 输出预留被忽略,`SUMMARY_MAX_TOKENS` 是死代码 | `compact.ts:3`, `:17`, `:54-62` | `compaction-basic/src/config.ts:91` | 中-高 |
| 8 | 手动 `/compact` 保留地板 + 最小收益门槛使其可能 no-op | `agent.ts:929`, `compact.ts:155` | `compaction-basic:379-384` | 中 |
| 9 | 完全没有时间/日期上下文 | `_buildRuntimeContext` 无对应项 | `context/time-context/src/index.ts:170-208` | 中 |
| 10 | 无工作区指令文件(`AGENTS.md`/`CLAUDE.md`)自动读入 | 无 | `context/agent-instructions/src/index.ts:322-348` | 中-高 |
| 11 | runtime-context 状态与请求前耐久点仅内存 | `agent.ts:1379`, `:1428` | `runtime-context.ts:34-56`, `session-checkpoint-policy/src/index.ts:63-82` | 中 |
| 12 | 无 `agent/pre-step` / `agent/request` / `agent/request-error` 扩展点 | 全硬编码 | `agent-loop/src/agent.ts:225-243`, `:438-441`, `:355-369` | 高 |
| 13 | 无 `agent/turn-stopping` 收尾钩子 | 无 | `agent-loop/src/agent.ts:295-299` | 中 |
| 14 | 权限把 sandbox 与 approval 混为一档,审批不可替换/不可审计 | `permission.ts:99-140` | `permission-presets/src/index.ts:56-62`, `user-approval/src/index.ts:188-307` | 中-高 |
| 15 | `assistant/chunk` 不落盘,重放保真度低于 B | `session.ts:38-73` | `agent-loop/src/agent.ts:347-351` | 中 |
| 16 | 无 surface 位置模型(`surfaceOp`/`sourceEventSeqs`/replacement 语义) | 用 `dropThroughSeq` 隐式指针 | `core/session/src/surface.ts:41-68`, `:210-243` | 中-高 |
| 17 | 无投影缓存,派生量每次重算 | 无 | `session-projection-cache` | 中 |
| 18 | 工具无渲染意图声明,UI 靠工具名 switch | `web/src/utils/toolRowModel.ts` | `core/tools/src/presentation.ts` | 中 |
| 19 | 工具执行模式在池内不重新分类 | `agent.ts:1833` 一次性快照 | `tool-calls.ts:199-205` 每次重取 | 低-中 |
| 23 | **权限分类对未登记工具 fail-open**:新增写类工具忘记登记就静默免审批 | `permission.ts:70`, `:101` | 注册期强校验 + `validateArgs`(`schema.ts:478`) | **高(安全)** |
| 24 | 工具结果只有纯文本 `content`,无内容块 | `registry.ts:45` | `types.ts:22`, `:44-47` | 中-高 |
| 25 | 手写 JSON schema,无 required / `additionalProperties` 校验,未知参数透传 | `registry.ts:136-142` | `schema.ts:366-372`, `:478` | 中 |
| 26 | 无沙箱 seam,边界只在各工具实现内逐个检查 | `tools.ts:37-56` | `sandbox/*`, `docs/architecture.md:100-102` | 中-高 |
| 27 | 无审批白名单/记住放行,`confirm` 下每次都弹窗 | `permission.ts:99-140` | (待确认) | 中 |
| 28 | 无工具呈现模式(`native`/`code` Code Mode) | 模型永远看全量 schema | `core/tools/src/index.ts:656`, `:1055` | 中 |
| 20 | 无 MCP / 后台任务 / 持久终端 / LSP / code-mode / goal(子代理已有 in-process 只读版) | 子代理已有 `subagent` 工具 + `agent/subagent.ts`;其余全缺 | 各对应包 | 高(能力面) |
| 21 | 无 plan/mode 事件与 `exit_plan_mode` 工具,计划模式只是 guard 拒绝 | `permission.ts:107-111` | `plan/plan-mode/src/index.ts:225`, `:306` | 中-高 |
| 22 | 无会话标题 LLM 策略 / 统计 / 遥测 / 检索 | 无 | `session-title*`, `session-stats`, `session-telemetry`, `session-query` | 中 |

---

## 9. 对齐路线图

### 阶段 0:无风险的正确性修复 —— ✅ 已完成(见第 11 节)

1. ~~修 #7~~ **已修正判断**:`resolveCompactSpec` 不扣除输出预留是**与 harness 一致的**
   (`compaction-basic/src/config.ts` 的 `resolveCompactSpec` 也只按 `contextWindow × thresholdRatio`);
   真正的问题是 `SUMMARY_MAX_TOKENS` 是死代码 —— 已改为真正传给摘要请求。
2. ~~修 #6~~ ✅ 已修:统一 `measureEnvelope` 口径 + 下发 system/tools/message 三项拆分。
3. 修 #4(摘要调用携带工具 schema)—— **暂缓**,见第 11 节的取舍说明。
4. ~~修 #5~~ ✅ 已修(本轮,见第 12 节):**压缩失败绝不截断** + 失败记录与前端披露。
5. 修 #8(手动 `/compact` 保留地板)—— 待做。
6. 修 #14(权限拆成 sandbox/approval 两个旋钮)—— 待做。
7. ~~修 #23~~ ✅ 已修(安全):`ToolDef.access` 显式声明 + 未声明一律 fail-closed 按 `write`。
8. 修 #25(注册表 required 校验)—— 待做。

### 阶段 1:引入缺失的上下文来源(3-5 天)

7. 新增 `time-context`(当前日期/时区,可节流),作为 runtime-context 的一个 section。
8. 新增 `agent-instructions`:自动发现并注入工作区 `AGENTS.md` / `CLAUDE.md`(远程工作区 = 通过 SSH 读取;本地工作区 = 本地读),带字节预算与变更对账。
9. `_buildRuntimeContext` 重构为 **section 列表 + 署名**,与 B 的 `ContextSnapshotSection[]` 同构,为后续 section 化铺路。

### 阶段 2:prompt 与请求信封(1-2 周)

10. 把 `_systemPrompt` 拆成 `PromptSection` 注册表(`registerSection({name, order, text|fn, complete?})`),内置 section 按 B 的命名与 order 迁移(身份 −100、persona 0、plan:policy 50、各 `tool:*` 100+、SDK 150),用户 `prompt-inject.md` 变成一个 order 更高的 section(修正当前它被追加到最后却定位为"强指令"的矛盾)。
11. 新增 `promptContext` 注册表与 `suppressRuntimeContext()` 开关。
12. 新增 `request/header` 与 `request/context` 事件:记录 canonical 的 `{config, system, tools}` 与 `{provider, model, contextWindow}`,仅在变化时追加,提供离线回放折叠函数。这是 #2/#3 的前置条件。

### 阶段 3:会话模型补强(1-2 周)

13. 新增 `assistant/chunk` 事件(逐 chunk 落盘),保留现有 `assistant/message` 作为聚合结果;前端改为基于 chunk 重放。
14. 引入 surface 位置模型:`surfaceOp: 'append' | {op:'replace', ...}` + `sourceEventSeqs`,把 `compaction/done` 的 `dropThroughSeq` 隐式指针升级为显式 replacement;`truncate()`/legacy `squash()` 标记为 deprecated 并逐步移除。
15. `forkSession` 增加边界校验:边界落在未闭合 turn 内时拒绝并提示。
16. 事件信封加 `ignorable` 语义(未知事件类型按需拒绝)与投影缓存。

### 阶段 4:扩展点与能力面(按需,持续)

17. 在驱动循环里引入三个 waterfall 钩子(`agent/pre-step` / `agent/request` / `agent/request-error`)与一个 serial 钩子 `agent/turn-stopping`;把现有"工具不支持降级"和"爆窗恢复"改写为 `agent/request-error` 的默认监听器,证明钩子可用。
18. 权限拆为 sandbox/approval 两个 seam,审批答案器可替换(为后续无人值守/自动化铺路)。
19. 按需补能力:优先级建议 **持久终端 → 后台任务(job_*) → 子代理 → MCP → plan/exit_plan_mode 工具**。每一项都应对齐 B 的 seam 三段式(Service Definition / Provider / Consumer),而不是直接塞进 `tools.ts`。
    - **子代理:✅ 首版已落地**(`agent/subagent.ts` 的自带循环 + `subagent` 工具 + 只读白名单;事件面复用 `tool/call`/`tool/result` 所以前端零改动;测试 `test/subagent.test.js`)。跨 provider / 写能力 / 后台续聊 / 过程 UI 仍待做(见设计文档第 5 节)。

### 阶段 5:可选(仅当需要与 B 生态互通)

20. 若要真正共享 B 的实现(而不是平行演进),唯一路径是让本项目消费 `@deepseek-ai/dsh-*` 包并在其上挂载本项目专属的 ssh/remote provider(把 `ssh-manager`/`local-fs` 实现成 `ctx.shell`/`ctx.fs`/`ctx.subprocess` 的 provider)。这属于重写级投入,建议在上述 0-2 阶段完成后重新评估收益。

---

## 10. 未验证项

- B 侧 `tool-subagent`、`tool-web(search)`、`tool-subagent-report` 的 section order 数值未提取。
- B 侧 `tool-fs`/`tool-bash`/`tool-pwsh` 的单工具输出字节/行数上限未逐一枚举;spill 阈值未确认。
- A 侧 `renderSkillCatalog` 输出形态与 `getSkillsCatalog()` 缓存策略未细读。
- A 侧 `contextWindow` 是否还有除手工配置以外的自动发现路径(仅验证了手工路径)。
- B 侧 `time-context.refreshIntervalMs` 在出厂组合里的实际取值。
- B 侧审批是否有"记住/白名单"持久化语义(阶段 4 第 18 项需要先确认)。

---

## 11. 本轮已落地的修复(阶段 0 第一批)

### 11.1 安全:工具访问类别改为显式声明 + fail-closed(#23)

**问题**:`server/agent/permission.ts` 的 `toolAccess()` 兜底分支返回 `'read'`,
意味着任何新增的写类/命令类工具只要忘记加进 `WRITE_TOOLS`/`COMMAND_TOOLS`,就会
既**免审批**、又在 plan(只读计划)模式下**照常执行**。同文件 `concurrencySafe` 的
兜底方向恰好相反(fail-closed),两处默认值方向不一致本身就是危险信号。

**改动**:

| 文件 | 改动 |
|---|---|
| `server/agent/registry.ts` | 新增 `ToolAccess` 类型与 `DEFAULT_TOOL_ACCESS = 'write'`;`ToolDef` 新增 `access?: ToolAccess` 字段(类型定义在 registry 侧以避免 permission → registry → permission 循环依赖) |
| `server/agent/permission.ts` | `toolAccess(name, def)` 优先取工具**自己声明**的 `access`;名字名单降级为兜底;名单未命中 → `DEFAULT_TOOL_ACCESS`(fail-closed)。新增 `READ_TOOLS` 名单以保留"纯名字判定"下已知只读工具的放行语义;`permissionGuard` 增加 `def` 参数;`registerPermissionGuard` 从注册表取回定义 |
| `server/agent/tools.ts` | `registerTools` 内新增 `TOOL_ACCESS` 表,键为**工具名字面量联合类型**的 `Record` —— 漏声明任一工具会在 typecheck 阶段报错,从机制上消灭该事故类型 |
| `server/agent/browser-tools.ts` | 11 个浏览器工具各自声明 `access`。此前它们全部落到 fail-open 的 `read`:plan 模式下模型仍可点击/输入/导航/执行 JS。现按语义分为 `browser_snapshot`/`browser_wait`/`browser_screenshot` = `read`,其余(open/navigate/click/type/press/scroll/eval/close)= `write` |

**验证**:`test/tool-access.test.js`(新增)断言 35 个真实注册工具**全部**显式声明、
声明值合法、`mutating` 工具不得声明为 `read`、关键工具类别逐一锁定、未声明工具
必须 fail-closed;`test/permission-mode.test.js` 增加回归用例:未声明 `access` 的
工具在 `confirm` 下必须挂起审批(而不是直接执行)、在 `plan` 下必须直接拒绝。

### 11.2 口径统一:仪表盘与压缩触发点同源(#6)

**问题**:`agent.ts` 里压缩阈值用 `measureMessages(history) + reservedTokens`
(含 system + 工具 schema),而广播给前端的 `context_usage.estimated` 只算
`measureMessages([system, ...history])`(**不含工具 schema**)。本项目 35 个工具的
schema 约占 5k token,导致同一个会话"仪表盘百分比"与"真实触发点"系统性不符。

**改动**:`compact.ts` 新增 `measureEnvelope(system, toolSchemas, messages)` 返回
`{systemTokens, toolsTokens, messageTokens, total}`;`agent.ts` 的 4 处测量
(绝对地板折叠、自动压缩广播、爆窗恢复广播、请求后广播)与 `compactNow` 的手动压缩广播
全部改用它,并把三项拆分随事件下发;`ContextMeter.tsx` 与 `ChatPanel.tsx` 优先显示
服务端分项(旧版服务端不发时回退到前端估算),悬浮面板在服务端口径下也展示分项明细。

### 11.3 摘要输出上限不再失效(#7 的真实问题)

`COMPACT.SUMMARY_MAX_TOKENS`(=8192)此前是死代码 —— 常量声明了,但没有任何调用方使用;
摘要请求一直用模型配置的 `maxTokens`(可能远大于 8k),摘要自己更容易超窗。
harness 的摘要调用是显式带 `maxTokens` 的(`compaction-basic/src/summarizer.ts:159`)。

**改动**:`ChatOptions` 新增 `maxTokens?: number`,`chat()` 的 `body.max_tokens`
按它收紧(非法值回落模型配置);`summarizeWithLlm` 新增 `maxTokens` 参数并默认传
`COMPACT.SUMMARY_MAX_TOKENS`;自动压缩与手动 `/compact` 两个调用点都显式传该常量。

**同时修正的错误注释**:`compact.ts` 顶部与 `COMPACT.THRESHOLD_RATIO` 曾声称阈值
"再扣除输出预留",但 `resolveCompactSpec` 从未读取 `maxTokens`。经比对 harness
(`compaction-basic/src/config.ts` 的 `resolveCompactSpec`)确认**不扣除才是对齐行为**,
故保留代码、改正注释,并在 `resolveCompactSpec` 的 JSDoc 里写明 maxTokens 不参与阈值计算。

### 11.4 明确暂缓的一项:摘要调用携带工具 schema(#4)

harness 刻意复用 `header.system` + `header.tools` 使摘要调用成为真实前缀
(`region.ts:488-514`),而本项目摘要调用传 `tools: []`(`compact.ts`)。**本轮未改**,理由:

1. harness 与本项目"模型必看内容"的差别:harness 摘要时工具 schema 本来就在的请求信封里
   (它按 session 的 `request/header` 重放),本项目摘要调用是独立构造的消息数组,
   要带工具 schema 需要把 registry 的 schema 透传进 `compact.ts`,扩大耦合面;
2. 收益依赖提供方 KV 缓存命中,当前无缓存命中指标(第 8 节 #3)可验证收益是否真实;
3. 风险:多传 `tools` 会让模型有调用工具的机会,摘要结果可能混入工具调用(harness 用
   `summaryText()` 只取 text block 来兜住,本项目需要同等的过滤)。

建议顺序:**先做 #3 缓存指标可观测 → 有数据后再决定是否做 #4**。

### 11.5 本轮的验证结果

- `npx tsc -p tsconfig.server.json --noEmit`:改动前后均为 **74 个错误**,且改动文件
  (`registry.ts`/`permission.ts`/`compact.ts`/`llm.ts`/`tools.ts`/`browser-tools.ts`)
  **零错误** —— 74 个错误是 `agent.ts` 等文件既有的隐式 `any` 问题(未提交的工作区状态)。
- `npm run build`(vite):✅ 通过,验证 `ContextMeter.tsx`/`ChatPanel.tsx` 改动。
- 全量测试(**逐个**运行,因为 `npm test` 用 `&&` 串联、遇到既有失败会中断):
  **36 个文件中 32 个通过**;4 个失败是**既有环境问题**,已用 `git stash` 在干净基线上
  复现确认与本轮改动无关:`llm-retry`、`agent-llm-retry`、`image-tool`、`e2e`
  —— 这些用例需要真实回环 HTTP,而当前 sandbox 拦截 `fetch('http://127.0.0.1:…')`
  (实测报 `UND_ERR_SOCKET / other side closed`)。
- 新增/更新的测试:`test/tool-access.test.js`(新增)、`test/compact-summary-request.test.js`
  (新增)、`test/permission-mode.test.js`(新增 fail-closed 回归)、
  `test/context-usage.test.js`(口径更新 + 分项自洽断言);前两个已加入 `package.json` 的 `test` 链。

---

## 12. 压缩失败绝不截断(#5 / #10,本轮)

### 12.1 问题:压缩失败会静默丢弃上下文

原实现(`compact.ts`)在摘要不可用时"降级为直接裁剪":把被压缩区间整段丢掉,只留一条
`【上下文已自动压缩】早期 N 条消息因超出上下文窗口已省略。` + 原始任务锚点。触发条件有四类:

1. 摘要请求抛错(上游 5xx / 网络 / 超时);
2. 摘要无收益(shrink 校验:`摘要 token >= 被压区间 token`);
3. 摘要为空(模型返回空串);
4. `llm` 为空或 mock(容器状态下必然命中)。

**这是本项目最严重的一类数据丢失**:被丢弃的早期对话在模型可见面之外**无法恢复**,
而用户界面上只多一行不起眼的"已省略",没有任何告警——用户会以为压缩成功了,
继续基于一份已经失忆的上下文对话。harness 从不这样做:摘要失败时它只记日志并继续
(`compaction-basic/src/index.ts:155-163` 的 `catch` → `logger.warn('step compaction failed: ...; continuing the turn')`),
消息面完全不动;真超窗后由 overflow 路径带重试处理。

### 12.2 改动

| 文件 | 改动 |
|---|---|
| `server/agent/compact.ts` | 删除"降级直接裁剪"与 `preserveOriginalTask()`。摘要不可用(失败/无收益/为空/mock)时**返回入参 `messages` 原引用**、`compacted: false`、`failed: true` + `reason`;新增 `onFailure(reason)` 回调。对失败/无收益/为空三种情况分别给出准确原因 |
| `server/agent/agent.ts` | 自动压缩与爆窗恢复两处 `compactHistory` 调用都接上 `onFailure`:广播 `compaction_failed` 事件(带 `reason`、`manual`)并追加一条 `notice` 明确告知"已保持完整历史、不做任何裁剪" |
| `server/agent/agent.ts`(手动路径) | `compactNow` 补上**空摘要**的硬失败:此前 `summary` 为空会写一条`【上下文已手动压缩】早期 N 条消息已省略。` 通知行——用户主动按压缩却换来丢历史。现在直接抛错,会话原样(与 harness `summarizer.ts:170-172` 拒绝空摘要一致) |
| `web/src/types/index.ts` | `compaction` 增加 `failed` / `reason` |
| `web/src/components/ChatPanel/CompactionRow.tsx` | 新增失败态:文案「压缩未完成 · 已保持完整历史不做裁剪(原因)」,不可展开(没有摘要正文) |
| `web/src/components/ChatPanel/CompactionRow.scss` | `[data-state="failed"]` 告警色 + 静态图标(不呼吸,表示已结束) |
| `web/src/components/ChatPanel/ChatPanel.tsx` | 新增 `compaction_failed` 分支:把「正在压缩…」运行行**原地改写为失败态**;没收到过 `start`(断线/切会话)时也落一行,保证失败一定可见 |

### 12.3 现在唯一还会丢上下文的路径

改动后,"丢弃早期对话"只剩**用户显式操作**:清空历史、删除消息、回退/分支。
除此之外所有自动路径都保证"要么换成摘要,要么原样不动"。

仍存在一处**投影层**的消息级裁剪(`agent.ts` 的 `trimMessagesByBudget`,
预算 `resolveCharBudget(ctxWindow)`:窗口已配置 = 窗口×2 字符,未配置 = 180k 字符):

- 它**不碰事件日志**(日志与聊天界面始终完整),只裁"本轮发给模型的可见面";
- 它是"窗口未配置/声明虚高"时的最后防线,不是压缩失败的结果;
- 与本次修复的区别:它是**有意的**容量治理且有确定预算,而"降级裁剪"是**失败后的**静默数据损失。

若希望这里也改为"绝不动手"(宁可让请求超窗报错),把 `AGENT.HISTORY_BUDGET_CHARS`
与 `resolveCharBudget` 的返回值设为 `Infinity` 即可——但那会让"未配置窗口"的提供方
在长会话里必然撞上游 400,故本轮保留并在 UI 上无法感知(日志有 `[agent]` 提示)。
这属于产品取舍,建议单独确认。

### 12.4 验证

- `test/compact.test.js`:新增「摘要失败不裁剪」断言组 —— `compacted===false`、
  `messages === 入参`(原引用,证明未做任何替换)、`dropCount===0`(没有"已压缩 N 条"的假象)、
  `onFailure` 收到原因;另覆盖**空摘要**、**摘要过大无收益**、**mock 模式**三种情况同样不裁剪。
- `test/compaction-visibility.test.js` 场景 2 重写为:发 `start` → 发 `failed` → **不发 `done`**、
  `failed` 带原因、随后有可见 `notice`;并断言磁盘日志**无** `compaction/done` 检查点、
  13 条用户消息一条不少、事件只增不减。
- `test/compaction-persistence.test.js` 新增第 8 组:手动 `/compact` 在**空摘要**与
  **摘要抛错**下都必须抛错且事件数与模型面消息数都不变;并保留一个**成功路径对照**
  (确认改动没把正常压缩也堵死)。

---

## 13. 压缩必须留在消息记录里(#本轮)

### 13.1 问题

1. **压缩停了会弹一条 ⚠ 提示**。摘要失败 / 无收益 / 被用户按停时,服务端追加一条
   `kind: 'compaction'` 的 notice(「上下文压缩未完成…」)。用户明确不要这条:压缩停了不需要
   弹提示——它既打断阅读,又和"这件事已经结束、历史没动"的事实不成比例。
2. **中途压过多次时,记录里只剩最后一次**。显示投影只取"生效检查点"(日志中最后一条带
   `dropThroughSeq` 的 `compaction/done`),一次长对话里压过好几次时,刷新 / 切走再切回后早期
   每一次压缩的痕迹全部消失:用户只看到上下文忽然变短,却查不到"什么时候压过、压掉了什么"
   ——即"静默压缩"。

### 13.2 改动

| 文件 | 改动 |
|---|---|
| `server/agent/agent.ts`(常规自动压缩 / 爆窗恢复的 `onFailure`) | 删除 `kind: 'compaction'` 的 notice;改为 `session.append('compaction/failed', { reason, manual })` 并**立即落盘**(失败常伴随轮次被停止/异常收尾,等轮末写会丢),实时事件带 `persisted: true` 供前端同步分支点计数器 |
| `server/agent/session.ts` | 新增 `compaction/failed` 事件类型:只进显示面,`deriveMessages` 不投影(不进模型上下文) |
| `server/agent/agent.ts`(`projectEvents`) | 每个带 `dropThroughSeq` 的 `compaction/done` **各投影一条**压缩标记行(按事件顺序、插在各自保留区首条消息面之前);`compaction/failed` 投影为一行安静的「上下文压缩 · 未完成(原因)」 |
| `server/agent/agent.ts`(`messageFaceIndexes`) | 与投影严格同构:每个检查点各占一条标记行(下标 = 检查点事件本身,删除/回退它 = 取消那次压缩)、失败行就地占位;顺手修掉 runtime 快照处 `alive` 复位口径与 `projectEvents` 不一致的隐患 |
| `server/agent/agent.ts`(`rewindToBefore`) | 压缩失败行与检查点行一样支持"回退到它之前" |
| `web/src/components/ChatPanel/ChatPanel.tsx` | `compaction_failed` 带 `persisted` 时同步 `forkTurnRef`(与 notice/retry 同规则) |

`CompactionRow` 的失败态(「压缩未完成 · 已保持完整历史不做裁剪(原因)」、不可展开)保留:它是**记录**里的
披露,不是提示。

### 13.3 现在的语义

- 压缩中:`compaction_start` → 对话流里一行运行态「正在把早期对话压缩为摘要…」(仅实时,不落盘)。
- 压缩成功:`compaction/done` 检查点落盘 → 记录里一条「上下文压缩 · 已压缩 N 条早期消息」标记行,
  **每次压缩各一条**(刷新/切回后同样完整)。
- 压缩未完成:`compaction/failed` 落盘 → 记录里一条「上下文压缩 · 未完成(原因)」标记行,不再弹 ⚠。
- 模型面不变:仍只遵循**最后一条**检查点(`deriveMessagesWithTrace`),显示投影的完整性与模型可见面互不影响。

### 13.4 验证

- `test/compaction-visibility.test.js` 场景 2:断言**不再**有 `kind: 'compaction'` 的 notice、失败已落盘为
  `compaction/failed`、投影里出现失败行、失败行不进模型面、投影与消息面下标仍然同构。
- `test/compaction-persistence.test.js` 新增第 9 组:两次压缩**各留一条**标记行(顺序 + 摘要正文)、
  失败行可见且不进模型面、模型面仍只遵循最新检查点、第一条标记行的下标命中第一次压缩的检查点事件。
- `test/branch-point-index.test.js`:前端计数器模拟补上 `compaction_failed`(persisted) 的口径。
- `npm test` 全链 30 组用例 0 失败;`npx tsc --noEmit`(前端)干净。


---

## 14. 权限守卫此前从未挂载(本轮修复)+ 子代理首版

### 14.1 `registerPermissionGuard` 从未被调用(安全回归)

**问题**:`permission.ts` 导出了 `registerPermissionGuard(registry)`,但全仓(HEAD 与工作区)
只有**定义**与测试里的调用——生产启动路径从未挂载它。后果:confirm / auto-edit / plan 三个档位
在真实运行时**全部是空操作**:写文件、执行命令、plan 模式下的一切变更照常执行,连审批弹窗都不会出现。
`test/permission-mode.test.js` 自己手挂守卫,所以单测是绿的,掩盖了这个接线缺口
(这是"测了机制、没测接线"的典型盲区)。

**改动**:`server/agent/agent.ts` 在 `registerTools(registry)` 之后补上
`registerPermissionGuard(registry)`——守卫执行时需要从注册表取回工具自己声明的 `access`,
所以必须在注册之后挂载。

**连带修正**(三个测试原本依赖"守卫没挂"这一事实,现改为显式声明各自的权限前提):
- `test/multi-server-binding.test.js`:会话建好后 `permission_set = full-access`(该用例验证的是
  会话归属哪台服务器,与权限门控无关;否则 mock 脚本里的 write_file 会挂起等待审批,轮次永不结束)。
- `test/image-tool.test.js`:Agent 上 `setPermissionMode('full-access')`(generate_image 是 write)。
- `test/tool-parallel.test.js`:并发测试桩显式声明 `access: 'read'`,并注明 access 与并发语义无关。

**验证**:`plan` 档下 `subagent`/`write_file` 被直接拒绝(理由文案来自 permission.ts);
`confirm` 档下挂起审批;**全量 `npm test` 全绿**(含 e2e / 多服务器绑定 / 浏览器预览 / 压缩系列)。

### 14.2 子代理首版(in-process 只读版)

- 工具:`subagent`(`description` + `objective`/`scope`/`deliverable`/`context`/`prompt` + 可选 `provider`,声明 `access:'write'`、`mutating:true`,并行池独占)。
  提示词由**父对话自己生成**:`prompt`(≥60 字符)或 `objective`+`scope`(各 ≥6 字符)二选一,
  `composeSubagentPrompt()` 校验并按 `【任务目标】/【边界(必须遵守)】/【回传要求】/【已知线索】` 标注拼接;
  写不清就返回结构化错误(附模板),而不是把模糊任务丢给子代理。
  `provider` 枚举只有 `internal`(默认):**用本项目自己的 agent 循环与工具栈执行**
  (同一 `LlmClient`、同一 SSH/本地工作区绑定、同一个 `ToolRegistry`),不调用外部 agent;
  传其它值直接报错「未接入外部 agent 提供商」——外部 provider 只在用户明确要求时才应使用,本期尚未接入。
- 运行时:`server/agent/subagent.ts` 的 `runSubagent()`——独立内存会话 + 只读工具白名单
  (`SUBAGENT_TOOLS`)+ 有界循环(`AGENT.SUBAGENT.MAX_STEPS/RESULT_MAX_CHARS/TIMEOUT_MS`)。
- 事件面:复用 `tool/call`/`tool/result`(父会话只多一条),子代理的中间步骤不回传也不落父日志。
- 前端:工具卡标题「子代理」,摘要取 `description`(不把整段 prompt 当摘要)。
- 设计与取舍:`docs/superpowers/specs/2026-09-19-subagent-in-process-design.md`;
  实施计划:`docs/superpowers/plans/2026-09-19-subagent-in-process.md`;测试:`test/subagent.test.js`。
- 面板:每次派发落一份运行记录(`data/subagents/<runId>.json`,含完整对话),工具卡行尾「查看会话」
  打开**统一活动面板**(`ActivityDock`:一个胶囊 + 一个抽屉,内分「运行终端」「子代理」两个分区,
  各自按有无内容决定是否出现,两边都空则整块不显示,且只挂在 AI 对话标签页);
  子代理分区为左列派发记录 + 右侧对话(含加载/空/错误态与手机单栏);`subagent_list` / `subagent_get`
  两个 RPC + `subagent_changed` 事件驱动实时刷新;面板只读,无删除/重跑/续聊入口。
  面板与两个分区都按 `sid` 过滤(只属于当前对话,草稿会话不显示;`subagent_list` 不带 sid 回空),
  切对话时收起;会话列表状态点补了蓝色一档(该对话空闲但有后台终端在跑),优先级
  `绿(任务进行中)> 黄(等待用户操作)> 蓝(后台终端在跑)`(见 `web/src/utils/sessionDot.ts`)。
- 明确没做(留给后续):跨 provider / 写能力 / 后台与续聊 / 子代理用量计入仪表盘。

### 14.3 类型检查基线(如实记录)

`npm run typecheck` 在当前工作区**并非全绿**:`tsc -p tsconfig.server.json` 有 78 行报错
(77 行在 `server/agent/agent.ts`,1 行在 `server/store/attachments-store.ts`);在 HEAD
(干净的 v0.2.2)上跑同一命令是 74 行——也就是说这 74 行是**既有基线**,多出的 4 行来自本工作区
未提交的在制品(`endReason = { kind: 'aborted', cause: stopCause }` 与 `{kind,error}` 类型不符,
TS2353)。本轮新增/改动的文件(`server/agent/subagent.ts`、`tools.ts`、`permission.ts`、
`web/src/utils/toolRowModel.ts`、`config.ts`)**不产生任何新的类型错误**。
