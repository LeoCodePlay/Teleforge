# deepseek-harness 更新对照(0.1.0-rc.5 → 0.2.1-alpha.1)

**用途**:回答「这个项目更新了什么」,并给出对 Teleforge 的可落地项。

**对照两端**

| | 提交 | 日期 | 版本 |
|---|---|---|---|
| 本仓库当前检出的 dsh | `47f943859b` | 2026-08-13 | `0.1.0-rc.5` |
| dsh `origin/master` | `5badb15009` | 2026-10-03 | `0.2.1-alpha.1` |

**量级**:8,443 个提交(5,786 非 merge)、15,485 个文件、**+1,909,380 / −292,799** 行、包数 **219 → 319**、
新增 119 个包、删除 19 个包、新增 1,452 个测试文件、新增 `apps/desktop`(476 文件 / +47,714 行)与
`snapshots/` 语料库(1,298 文件)。

> 注意:约 150 万行是**机器生成的 JSON schema / 快照语料 / i18n 副本**,手写改动远小于上面的原始数字。
> 另:该仓库**没有任何 CHANGELOG**;发布说明由 `docs/persistence-changes/releases/dsh-v*.md`(新增 108 个)
> 与 `docs/upgrade-guide/<version>/<slug>/guide.md`(6 篇)承载,并有 CI 门禁校验。

---

## 1. 版本节奏

51 天里 31 次版本提交(平均 1.65 天一个版本),打 `dsh-v<version>` 标签:

```
0.1.0-rc.5  08-13 (= 本地 HEAD)      0.1.5-rc.1/2  09-10
0.1.0-rc.6  08-13                    0.1.6-alpha.1/2  09-14 → 09-17
0.1.0-rc.7  08-17                    0.1.5-rc.3   09-22 (backport,晚于 0.1.7-alpha.2)
0.1.0-rc.8  08-19                    0.1.7-alpha.1/2  09-22
0.1.1-rc.1/2  08-21                  0.1.7-rc.1/2  09-23 / 09-24
0.1.2-alpha.1…5  08-28 → 09-02       0.2.0-rc.1/2  09-28 / 09-29
0.1.2-rc.1  09-03                    **0.2.1-alpha.1  10-03**
0.1.3-alpha.1/2  09-04 → 09-07
0.1.5-alpha.1/2  09-08 / 09-09
```

两个反直觉之处,值得记下来:

1. **没有 0.1.0 正式版**。历史是 `0.1.0-rc.8` → `0.1.1-rc.1`,`package.json` 从未等于 `"0.1.0"`;
   `0.1.4` 被整个跳过。仓库维护**并行发布线**(release 分支 backport,所以 rc.3 会晚于 alpha.2)。
2. 发布渠道在本次窗口内从单一变成多渠道:`5761890711 feat(release): add DSH alpha and canary channels`、
   `c2a68638b2 publish all experimental packages`、`9c45de099f isolated npm publication channels`。

---

## 2. 新增的 119 个包(按域)

### 2.1 api(7)—— apiproxy 被拆成 Remote 控制器层
`api/account-controller`、`api/session-controller`、`api/workspace-controller`、`api/workspace-files`、
`api/terminal-controller`、`api/job-controller`、`api/settings-controller`。

配套删除:`host/apiproxy`(单文件 `api-proxy.ts` 就 **−3,744 行**),三个 `refactor(...)!` 提交明确标注破坏性。

### 2.2 boot(3)—— **插件与配置管理核心(本次最相关)**
`boot/plugin-manager`、`boot/hmr`、`boot/config-editor`。

### 2.3 bundle(3)
`bundle/acp-app`、`bundle/sdk-app`、`bundle/sdk-minimal`。

### 2.4 client(27)—— Web 客户端大重构
`client/store`、`client/resources`、`client/ui-renderer`、`client/ui-dockkit`(零 cordis 的停靠布局引擎)、
`client/ui-chat`、`client/ui-session`、右侧栏系列(`ui-sidebar-right` / `-files` / `-terminal` / `-browser` /
`-documentpreview`)、**`client/ui-schedule`**、**`client/ui-plugin-manager`**、`client/ui-approval`、
`client/ui-reference`、`ui-shortcuts` + `shortcuts`、`client/file-upload`、`client/product-analytics`、
`ui-settings-account` / `-subagent` / `-shell` / `-web-search` / `-agent-loop` / `-session-log`、
`ui-brand-official`、`ui-open-in-app`。

### 2.5 session(8)—— 会话格式迁移机制
`session-format`、`session-format-catalog`、`session-format-v0-to-v1` … `v3-to-v4`(每个代际一个冻结 codec)、
`session-log-deepseek`、`session-turn-outline`。

### 2.6 ssh(4)—— **dsh 原生 SSH 子系统,全新**
`ssh/ssh`(共享 OpenSSH 连接 + 版本化 POSIX 远端 helper)、`ssh/fs-ssh`、`ssh/sandbox-ssh`、`ssh/subprocess-ssh`。
落在 2026-09-11/12(`4fb0fdac68`、`72226bd061`),之后约 15 个 `fix(ssh)`。新增 `docs/subsystems/ssh.md`。

> 与 Teleforge 的关系:这是**同类能力的上游实现**,值得单独对照阅读(尤其"共享连接 + 版本化远端 helper"
> 的形态),但不构成代码依赖。

### 2.7 experimental(24)
`agent-team`(隐式根团队花名册 + 持久 peer 邮箱 + 共享任务 DAG)+ `agent-team-profile` + `tool-agent-team` +
`client-ui-agent-team`、`auto-review`(Auto 预设下的**逐工具 LLM 授权复核**)、`browser-use-runtime` +
`-playwright-mcp` / `-chrome-devtools-mcp` / `-stagehand-native`、`computer-use-cua-driver-mcp` / `-native`、
`voice-input-bundle`、`speech-to-text` + `-sensevoice`(本地 ONNX)、`ptc-runtime-python`、
`webworker-runtime` + `webworker-packer`、`inspector` + `-profile` + `session-inspector`、
`claude-code-mods` + `client-ui-claude-code-mods`。

### 2.8 其余(精选)
- **util(10)**:`chunked-list`、`code-language`、`crypto`、`deque`、`http-proxy`、`lazy-require`、
  `package-manifest`、`time`、`values`、`workspace-path`
- **credentials(3)**:`authorization`(插件拥有的凭据获取流程)、`deepseek-account`、`deepseek-account-platform`
- **ptc-runtime(2)**:抽象 seam + 沙箱化 Node 实现(code-runtime 被它取代)
- **preset(2)**:`agent-preset`、`agent-preset-registry`
- **webhook(2)**:**全新**——"fire-and-forget webhook 规则运行时,创建 Workspace 会话" + 签名 GitHub 适配器
- **schedule(1)**:`schedule/tool-schedule`(4 个模型工具)
- **deliverables(2)**:`tool-present`、`workspace-changes`(按轮次的 git 工作树快照)
- **compaction**:`compaction-image-offload`
- **telemetry**:`otel`
- **skill(2)**:`skill-office`、`tool-workspace-dependencies`

### 2.9 新的非 `packages/` 工作区
`apps/desktop`(**Electron 桌面壳**)、`apps/desktop-host`、`native/system`(由 `native/landlock-run` 改名扩充)、
`benchmarks/`、`snapshots/`。

---

## 3. 删除 / 重命名(破坏性)

| 删除 | 说明 |
|---|---|
| `host/apiproxy` | 拆成 `api/gateway` + 7 个 `*-controller` |
| `client/runtime` | 拆成 `api/session-controller` / `client/store` / `client/ui-chat` / `client/ui-conversation` |
| `client/schema-form`、`client/web-react` | 由 `client/store` + `ui-renderer` + `ui-dockkit` 取代 |
| `code-runtime/*` | 整组删除 → `ptc-runtime/*` + `experimental/ptc-runtime-python` |
| `session/session-persistence-sqlite` | **SQLite 后端被移除,只剩 JSONL** |
| `settings/settings-file` | 配置改走 `boot/config-editor` + profile patch + `api/settings-controller` |
| `preset/agent-presets` | → `preset/agent-preset` + `agent-preset-registry` |
| **`runtime-diagnostics/invariants`** | **整个运行时不变式系统被删除**(1,355 文件 / −15,409) |
| `e2b/*`(3 个) | E2B 云沙箱 provider **整体放弃** |
| `workflow/workflow-worker-thread` | → `workflow/workflow-ptc`(迁到共享沙箱 PTC 运行时) |
| `examples/*`、`vendor/`、`assets/`、`knip.json` | 顶层删除 |

---

## 4. 重大功能域

按提交类型:fix 2,260 · test 1,224 · docs 728 · feat 617 · refactor 453 · perf 109。

- **A. 桌面应用(全新产品面)**:307 个 `desktop` 提交,起点 `ba05b7d49d`(09-07)。含 Electron 分发、
  更新与 Windows 安装体验、内置 Python Office 运行时、托盘、引导、产品分析、原生致命错误对话框。
  **→ Teleforge 本身就是 Tauri 桌面壳,这条线值得对照(尤其"更新 + 安装体验 + 致命错误恢复")。**
- **B. Web 客户端重构(最大单块)**:`packages/client` 2,502 文件 / +265,484 / −66,047。右侧栏架构、
  统一视觉语言、聊天分组与轮次导航、`@file`/`@session` 引用、文件夹拖入上传、客户端插件**免刷新热更新**
  (`b03d5c68ea`)。
- **C. 会话与持久化**:`SESSION_FORMAT_VERSION` **0 → 4**,四代格式各有冻结 codec 与逐边迁移;
  区分 event seq 与 log offset;跨进程写锁(flock);fork 精确事件前缀。
- **D. 多代理**:subagent 241 个主题提交(容量限制、子模型授权、后台 Codex/Claude Code provider);
  **Agent Teams 全新**(持久运行时、Web/CLI profile、Team 面板)。
- **E. 权限/沙箱**:新增 **Auto review 模式**(逐工具 LLM 授权复核);Windows ACL 诊断与修复一整套
  (`ab0195f802` 一条命令内诊断并修复)。
- **F. MCP**:scoped resources + server instructions(新增 `mcp/mcp-resources`)。
- **G. 认证/账号**:抽象 credentials 服务 + OAuth 登录 + 账号路由隔离。
- **H. LLM**:原生多模态请求、Messages 协议、模型目录调整、默认 5 次重试、全部出站请求走代理。
- **I. 代码执行 PTC**:`ctx.ptcRuntime` seam + 沙箱 Node 实现 + CPython 子进程后端。
- **K. 测试与性能**:新增 `test-support/remote-mock`、`session-snapshot`、`snapshots/` 语料、
  `benchmarks/`;109 个 perf 提交。
- **L. 发布/CI**:alpha + canary 渠道、隔离的 npm 发布渠道、`Makefile`、加权 PR 审批。

---

## 5. 插件系统(本次重点)

### 5.1 三个全新能力

**① `packages/boot/plugin-manager`(+6,821,全新)** —— 不改配置文件即可管理当前 profile 的插件:
启停单个插件条目、选择已安装 bundle、安装/卸载**外部** bundle。具体能力:

- **安装来源:npm registry / Git(GitHub URL)/ tarball / 本地目录**;`inspect(spec)` 先探后装;
  GitHub 仓库用 `git ls-remote` 预检(默认 5s 超时)
- **registry 回退与镜像**:`options.registry` → 已配置 registry → `fallbackRegistries`;
  私有 registry 只问它自己,**绝不回落到公共源**;导出 `OFFICIAL_NPM_REGISTRY` / `NPMMIRROR_REGISTRY`
- **构建脚本审批**:pnpm 11 的 blocked-build 上报 `pendingBuilds` → 用户勾选允许 → `approvedBuilds` 重试
- **审批门控**:每个工具动作都需要 `danger-full-access` 或逐次审批;低沙箱模式下 `ask` 走审批、`never` 直接禁止
- **流式安装遥测**:`plugin-manager/install-log`、`install-state(installing/cancelling/applying)`、
  `plugin-manager/changed`、`cancelInstall(requestId)`、`waitForInstall(requestId)`;
  失败时**恢复 `package.json` / `pnpm-lock.yaml`**

**② `packages/client/ui-plugin-manager`(+10,178,全新)** —— Web 侧边栏 **Plugins** 面板:
管理已装 bundle + 出厂自带的官方 bundle。「Add plugin」是分裂菜单:*安装第三方插件* vs *让 agent 创建插件*;
安装对话框支持包名 / Git / 本地目录;含**安装预览、pnpm 输出查看器、取消、卸载确认**、骨架屏与占位态、
每个 bundle 的图标与本地化显示元数据、详情页扩展槽。

**③ 客户端插件免刷新热更新** —— `b03d5c68ea` + `packages/boot/hmr`(全新)。

**④ 面向模型的 `plugin_manager` 工具** —— `packages/boot/plugin-manager/src/tools.ts`:
把同一套操作暴露给模型,**仅在 Creator 模式启用**,其它预设默认关闭。配套出厂技能
`packages/preset/agent-preset/skills/cordis-plugin-development/`(含 host-plugin / mcp-bundle / ui-plugin /
user-actions / practices / verification 参考与 decoration / mcp 模板)。

**⑤ 显示元数据与清单分离** —— `6469b522c1` + 新 `util/package-manifest`;子路径插件不再读
`<pkg>/<sub>/package.json`,改读 `locale/*.json` 的 `meta.title`/`meta.description`(**破坏性**)。

### 5.2 master 上的对外接口(供照搬命名)

```
Remote: pluginManager.inspect(spec)          先探后装:读 pnpm view / package.json / git ls-remote
        pluginManager.installBundle(spec)    安装(可带 approvedBuilds)
        pluginManager.cancelInstall(requestId)
        pluginManager.waitForInstall(requestId)
        pluginManager.listBundles()
        pluginManager.setBundleEnabled(...)  ← 改 package.json 里有序的 dsh.profile.bundles
        pluginManager.setPluginEnabled(...)  ← 只往 cordis.patch.yml 的"最后一个匹配 override"写 disabled
        pluginManager.removeBundle(spec)
        pluginManager.registries()
        pluginInventory.list()               只读运行清单(条目带可选本地化 meta、agentPresets[] 分组、
                                             managementAvailable 标志)
Events: plugin-manager/install-log | plugin-manager/install-state(installing|cancelling|applying)
      | plugin-manager/changed
```

其它 master 独有、与插件有关的机制:
`packages/boot/app-boot/src/plugin-compatibility.ts`、`@deepseek-ai/dsh-package-manifest`
(显示元数据 `meta`/`icon`)、`packages/boot/hmr/src/package-manifest.ts`、
`compatibility.json` 版本豁免机制(CLI 动词 `dsh plugin version-exemptions|allow-version|revoke-version`)。

> **一键照搬的三条**:①安装前 `inspect` 探明并**拒绝不合法 spec**(dsh 拒绝不声明 `dsh.bundle` 的包);
> ②**registry 镜像回退**但私有源不回落到公共源;③**失败回滚**安装事务。

### 5.3 被掏空的旧实现
`packages/client/ui-settings-plugins` **+259 / −2,814** —— 原来的逐插件配置卡
(`AgentLoopCard`/`BashCard`/`WebSearchCard`/`ConfigurablePluginsTab`/`PluginCard`/`card-form`/`fields`)
**全部删除**,改为每个能力一个独立的 `client/ui-settings-*` 包;插件管理主入口搬到
新增的 **`client/ui-plugin-manager`**(侧边栏 Plugins 页)。

> **对本项目的启示**:我们把"插件配置"做成**一份 JSON Schema 驱动的通用表单**,
> 正是 dsh 刚刚**放弃**的方向(它们转向"每个能力自带设置页")。
> 取舍理由:Teleforge 没有 30+ 个客户端插件包的人力,通用表单是唯一可持续的形态;
> 但应保留 `contributes.settingsTab` 逃生口(见设计 §3.2),让复杂插件自带整页 UI。

### 5.4 四条安装通道 → 我们全部采纳
dsh 的 plugin-manager 支持 **npm / Git(GitHub)/ tarball / 本地目录**,配 **registry 镜像回退**。
用户已确认 Teleforge 这四条全要,设计 §7.2/§7.3 的安装管线与之一一对应。

**唯一的有意分歧**:dsh 通过 **pnpm** 安装(所以能顺带支持 pnpm 的 build-script 审批),
Teleforge 的桌面包不保证用户机器有 pnpm,也不打算再打包一个包管理器 ⇒ 设计 §7.3 自研极简 npm 解析器,
并把 dsh 的"构建脚本审批"直接简化为**一律不执行依赖的 install 脚本**(安全上更严格,
代价是需要构建的包装不了,给出可读失败原因)。

---

## 6. 自动化(本次重点)

### 6.0 ⚠️ 先说一个**会导致抄错的陷阱**

**本仓库检出的 `0.1.0-rc.5` 里,`packages/schedule` 完全没有 cron。**
那时它只有三种计时方式:`after` / `at` / `every`,`every` 下限 300 秒,持久化在**会话事件日志**里,
`docs/subsystems/schedule.md:94` 明确写着"协议没有日历或 cron 表达式"。

**cron(以及 daily / weekly)只存在于 `origin/master`(0.2.1-alpha.1)**:
`packages/schedule/schedule/src/domain.ts:969-983` 的 `cronDateMatch()` 实现真正的 Vixie 五段求值,
引入 `@js-temporal/polyfill`,持久化从会话事件日志**整体搬到宿主级存储域**,新增第 4 个工具
`schedule_update`,并把 `MIN_EVERY_INTERVAL_SECONDS` 从 300 **降到 60**。

> **教训**:本次两个功能(插件管理、自动化)在检出树与 master 之间差别巨大。
> 对照 dsh 时必须用 `git show origin/master:<path>`,不能读工作区文件。

### 6.1 变更量

| 路径 | 变更量 | 内容 |
|---|---|---|
| `packages/schedule` | 54 文件 **+9,554/−2,965** | 新增 `schedule/tool-schedule`(`schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`);整个子系统围绕 Host `ctx.schedule` 服务 + 存储阶段重写;新增 UI 页 `client/ui-schedule`(churn 21,531,`TaskDetail.tsx` 2,146 行) |
| `packages/jobs` | 39 文件 **+4,216/−1,485** | `4b54e59a52`:人类可 kill、超时提升、workflow `run_in_background`;`35a02e1658`:统一 job seam 到一个输出环,流式进会话头部的 job 列表;新增 `api/job-controller` + `client/ui-jobs` |
| `packages/goal` | 45 文件 **+2,312/−1,157** | `command-goal`、`goal-round-driver`、`goal`、`tool-goal` 重构(32 个主题提交) |
| `packages/workflow` | 71 文件 **+3,668/−3,791** | `workflow-worker-thread` → **`workflow-ptc`**:编排迁入共享沙箱 PTC 运行时;`3c5b7097ae` Web PTC 模式下省略 workflow;`99a73ca1d4` 默认组合里禁用 ralph |
| `packages/webhook` | 28 文件 **+2,646(全新)** | fire-and-forget webhook 规则运行时 + 签名 GitHub 适配器;新增 `docs/subsystems/webhook.md` |
| `packages/subagent` | 191 文件 +20,909/−8,060 | 容量限制、子模型授权、父侧目录投影 |

### 6.2 master 上 schedule 的完整语义(供照搬)

| 维度 | 语义 |
|---|---|
| 选择器 | `title`(trim 后非空、≤120 字符,必填)+ `prompt`(非空)+ **恰好一个**:`after_seconds` / `at` / `every_seconds` / `daily` / `weekly` / `cron` |
| `every_seconds` | 固定安全整数,**下限 60 秒**,首次对齐创建时刻;更新会**重新对齐到保存时刻** |
| `daily` | `HH:mm:ss`(+可选 1-3 位小数)+ 显式 IANA 时区 |
| `weekly` | 同 daily + `weekdays`(周一 1 ~ 周日 7 的**非空**集合,归一化为去重升序) |
| cron 方言 | 5 段 `minute hour day-of-month month day-of-week`;分 0-59、时 0-23、日 1-31、月 1-12、周 0-7(0 与 7 均为周日);每段支持 `*`、单值、`a-b`、`*/n`、`a-b/n`、逗号列表。**拒绝** `L`/`W`/`#`、`JAN`/`MON` 名称、`@daily` 宏、六段、越界、倒置区间、零步长、空字段 |
| **cron 日字段规则** | 任一字段是星号 ⇒ **两个都必须匹配**;两个都不是星号 ⇒ **任一匹配即可**。「是否星号」看**文本是否以 `*` 开头**,所以 `*/2` 仍算星号、与另一字段共同约束 |
| cron 归一化 | 存储**规范表达式**(重复值合并、相邻/区间合并、均匀步长写 `a-b/n`、步长 1 丢弃、周日写 `0`);未以 `*` 开头的字段**永不**变成星号步长;解码器拒绝非规范表达式 |
| DST | 不存在的本地时间**跳过**;重复的本地时间每个日期只用**较早**的那个时刻一次 |
| 补齐地平线 | `CRON_SEARCH_HORIZON_YEARS = 400` |
| 持久化 | **宿主级存储域** `defineDomain({name:'schedule', version:1, tables:{tasks}})` + 投递历史(`deliveryHistoryDays` 默认 30、`deliveryHistoryRecords` 默认 200) |
| 投递 | `deliveryMode: 'host'`;到期可**冷恢复**已休眠会话;一次投递只有在会话确认 `session/flush` 之后才算提交 |
| 停机补跑 | 每个循环任务**只补最近一次**错过的触发 |
| 更新/删除 | `schedule_update` 原地改名/指令/计时并**保留 id 与投递记录**,不支持相对 `after`;删除**连同投递记录一并移除**;未删除的任务(含已结束)始终可查 |
| 错误码 | `invalid_prompt` / `invalid_rule` / `invalid_time_zone` / `not_future` / `frequency_too_high` / `schedule_not_found` / `schedule_ended` / `schedule_conflict` |

### 6.3 Schedule 归属反复导致数据事故

```
① Web 组合里自带 Schedule
   ↓ v0.1.7-rc.2 移出到可选 bundle @deepseek-ai/dsh-experimental-schedule-bundle(出厂关闭)
   ↓ v0.2.0-rc.2 bundle 被删除,Schedule 回到 Web 组合 + 预设内声明
```

四天内来回两次,留下两篇升级指南。**关键事故**:第 ①→② 步让"已存的提醒**不再投递**(数据还在)",
且 loader 只给一句 `patch: entry schedule not found`。

**对本项目的启示**:定时任务的"装在哪一层"会直接影响**存量数据能否继续投递**。
我们的设计把 schedule 做成**内置插件**(可停用、不可卸载),从根上避免"按 id 启用的插件消失了,
数据静默失效";停用时明确提示"已存的定时任务将不再触发,数据保留"。

### 6.4 其它采纳的自动化语义
`4611e32e64`(Web 默认组合自带 Schedule)、`6c1a590a4c`(提醒工具由预设作用域包贡献)、
`511a62cd1b`(到期提醒**框定为一条 scheduled user message**)、
`96c421d985`(拒绝为"由子代理路由拥有的会话"创建提醒)、
`3a296b16b4`(user-questions 支持**定时等待与迟到回复**)—— 对应设计 §9.1 的实现细节。

---

## 7. 破坏性变更与迁移

### 7.1 仓库内升级指南(6 篇,`docs/upgrade-guide/<ver>/<slug>/guide.md`)

| # | 版本 / 主题 | 要点 |
|---|---|---|
| 1 | `v0.1.7-rc.2/schedule-optional-bundle` | Schedule 行离开 Web 组合;profile 里按 id 启用 Schedule 会失效(loader 警告 `patch: entry schedule not found`、`schedule_*` 工具与页面消失、**已存提醒停止投递**)。迁移:在 Plugins 里开启 "Automation tasks" |
| 2 | `v0.1.7-rc.2/transcript-view-legacy-normal` | 旧的 `transcriptView: normal` 与未设置值改为显示 **Detailed** |
| 3 | `v0.2.0-rc.2/account-sign-in-errors` | `SignInErrorCode` 新增 **`no-response`**,客户端校验器必须补 |
| 4 | `v0.2.0-rc.2/remove-runtime-invariants` | `@deepseek-ai/dsh-invariants`、`InvariantRegistry`、`InvariantInstaller`、`InvariantFailure`、`InvariantError` **及所有 `<package>/invariant` 子路径导出全部移除**;配置文件里相应行必须删 |
| 5 | `v0.2.0-rc.2/schedule-bundle-retired` | 载入 profile 会**自动改写 `package.json`** 删掉该 bundle;顶层 `time-context` 覆盖不再匹配 |
| 6 | `v0.2.0-rc.2/subpath-plugin-display-manifest` | 子路径插件不再读 `package.json` 取名称/描述/图标,改读 `locale/*.json` 的 `meta.*` 与导出的 `icon` |

### 7.2 带 `!` 的破坏性提交
`d1521ea783 feat(session)!`(426 文件)、`f99b06eaed feat(session)!`(387 文件)、
`27bf1039db refactor(session)!`(区分 event seq 与 log offset)、`bec6805d6a refactor(session-persistence)!`、
`4553c9d957`(移除 SQLite)、`0dca00b425 refactor(api,client)!`、`fd7f2065b2`/`6e4087626d`(apiproxy 移除
settings/credentials 与 directory-picker RPC)、`28a4241e9f feat(agent)!`(`agent/session-start` → 等价的
`agent/created`)。

### 7.3 会话格式版本(最大迁移)
`SESSION_FORMAT_VERSION` **0 → 4**;四代各有冻结 codec 与**仅相邻代际**的流式迁移;
`docs/session-format-status.md` 记录 `latestFinalizedVersion: 4` / `latestReleasedVersion: 3`
——即 **v4 写入端已定稿但尚未记为已发布**。迁移**拒绝无证据来源**。

---

## 8. 对 Teleforge 的落地建议(按性价比)

### 8.1 直接采纳(已并入插件/自动化设计)
| dsh 的做法 | 落到本设计 |
|---|---|
| plugin-manager 的 4 种安装来源 + 镜像回退 | 设计 §7.2 / §7.3(四条通道全要) |
| 安装前 `inspect`、失败回滚、流式安装日志、可取消 | 设计 §7.2(`.staging` 原子安装 + 回滚 + 进度) |
| 插件权限门控 + 安装确认页 | 设计 §4 / §7.5 |
| 到期提醒框定为 scheduled user message | 设计 §9.1 |
| job 统一到一个输出环 + 会话头部 job 列表 | 设计 §9.2 |
| Schedule 归属反复导致"已存提醒不投递" | 设计 §9.1:schema 内置、可停用不可卸载 |

### 8.2 值得单独评估(未并入本轮)
| 项 | 价值 | 说明 |
|---|---|---|
| **`ssh/*` 子系统形态**(共享连接 + 版本化 POSIX 远端 helper + 4 个 provider) | 高 | 与 Teleforge 核心能力同域,值得作为架构对照读一遍;特别是"远端 helper 版本化"这一手,能解决远端环境差异导致的命令不稳定 |
| **`client/ui-dockkit`**(零 cordis 的停靠布局引擎) | 中-高 | Teleforge 的 `ActivityDock` 是固定分区;若要做可拖拽停靠,这是现成参考 |
| **`experimental/auto-review`**(逐工具 LLM 授权复核) | 中-高 | 现有 4 档权限之外的一个新旋钮,可实现为插件(设计 §10 第 6 项相关) |
| **`webhook` 运行时** | 中 | "外部事件 → 创建会话"是自动化的另一条腿,可在 schedule/jobs 之后追加 |
| **`agent-team`** | 中 | Teleforge 已有 in-process 只读子代理;Agent Teams 是"持久团队 + 共享任务 DAG"的下一阶段 |
| **PTY 持久 shell / `tool-pwsh-persistent`** | 中 | 审计差距里的"持久终端" |
| **Windows ACL 诊断与一条命令修复** | 中 | Teleforge 有本地文件工具,Windows 权限问题是真实痛点 |
| **会话格式版本化 + 冻结 codec + 相邻迁移** | 中 | Teleforge 的 `sessions/<id>.json` 是 `{version:2}`;若将来要改格式,这套"冻结 codec + 迁移 + 门禁"是可借鉴的工程做法 |
| **`compaction-image-offload`** | 中 | Teleforge 有生图与附件,长会话里的图片 offload 有实际收益 |

### 8.3 明确不采纳
- **Electron 桌面壳 / `apps/desktop`** —— Teleforge 已是 Tauri,不换壳。
- **Runtime invariants 的删除** —— 我们本来没有这套系统,无影响;但记住 dsh **删掉了它**,
  说明"运行时不变式"作为长期机制并不划算,不要反向引入。
- **`vendor/` 打包与 Cordis 兼容层** —— 见设计文档开头结论。
- **SQLite 会话后端** —— dsh 删掉了它;Teleforge 用 JSON 文件,方向一致。

---

## 9. 未确认项(如实记录)

1. 本仓库检出的 dsh **没有 0.1.0 正式版**;`0.1.4` 被跳过。
2. dsh **没有任何 CHANGELOG**;发布说明只存在于上面 §7.1 的升级指南与 `persistence-changes`。
3. Git 跳过了全量重命名检测,所以 §3 的删除/新增计数**高估**了真实删除量。
4. 未访问 npm registry,因此"这些版本是否真的发布过"未经验证。
5. dsh 的 `protect`/`schedule` 等包在 `origin/master` 上的最新测试状态未运行(仅做静态阅读)。
6. 本报告基于 `origin/master`(10-03,0.2.1-alpha.1);若上游此后又有提交,以更新后的差异为准。
