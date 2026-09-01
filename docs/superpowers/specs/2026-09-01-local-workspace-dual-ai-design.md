# 本地文件工作区 + AI 双工作区 设计说明

日期：2026-09-01
状态：已获用户认可（等待实施）

## 1. 背景与目标

当前工具只面向**远程 SSH 服务器**：文件面板、AI 工具、命令执行全部走 SFTP/SSH。
本机的文件只能通过浏览器文件选择框（上传）和浏览器下载框（下载到浏览器下载目录）被动参与，
没有"本地工作区"这一概念，AI 也完全看不到本机文件。

本次要新增三件事：

1. **本地文件面板**：在远程文件面板之外，提供一个本地文件浏览器，可导航、多选、右键操作。
2. **快捷双向传输**：
   - 本地选中文件/文件夹 → 一键传到"当前远程目录"。
   - 远程选中文件/文件夹 → 一键传到"当前本地目录"。
3. **AI 双工作区**：AI 能同时读/写/执行"本地工作区"与"远程工作区"两套，并分别操作。

## 2. 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 本地边界 | **锚定本地工作区**：用户选择一个本地目录作为"本地工作区"，文件面板与 AI 均限制在该目录内（与远程工作区对称，含越界守卫） |
| AI 本地权限 | **完整读写**：写/改/删/建目录，与远程现有能力一致 |
| 本地命令 | **允许**：AI 可在本机执行 shell 命令（保留危险命令拦截） |

## 3. 架构

新增**本地文件系统适配层**，与远程（`ssh-manager`）平行。上层（Agent 工具 / 文件面板 / 传输）
对二者暴露同一套方法签名；差异只在底层实现（SFTP vs `fs`/`path`）。

```
                 ┌──────────── 前端 ────────────┐
                 │ LocalFileManager · FileManager │  两个面板，各带"传到对方"按钮
                 └──────────────┬────────────────┘
                                │ WS (server/ws.js)
        ┌───────────────────────┼────────────────────────┐
        │   Agent 工具 (tools.js)        │  传输 (transfer)     │
        │  ├─ 远程工具(现有)             │  ├─ local→remote    │
        │  └─ 本地工具(新增，完整读写)    │  └─ remote→local    │
        └──────────────┬────────────────┴──────────┬──────────┘
              ┌────────┴────────┐          ┌────────┴────────┐
              │ ssh-manager (SFTP) │          │ local-fs (fs/path) │
              └─────────────────┘          │ local-exec (child_process)│
                                           └─────────────────┘
```

服务端跑在用户本机（`HOST=127.0.0.1`），因此"本地"对服务端即本机磁盘，直接用 Node 内置
`fs`/`path`/`child_process`，无新增依赖。

## 4. 文件清单

### 新增（服务端）
- `server/local-fs.js` — 本地 FS 适配层
- `server/local-exec.js` — 本地命令执行（`child_process`）

### 改动（服务端）
- `server/ws.js` — WS 协议新增本地浏览/读写/传输 case
- `server/agent/tools.js` — 新增本地工具集 + 守卫 + 本地环境快照
- `server/agent/agent.js` — system prompt 并列双工作区
- `server/config.js` — 本地命令超时/输出上限常量

### 新增（前端）
- `web/src/components/LocalFileManager.tsx` — 本地文件面板
- `web/src/components/LocalDirBrowser.tsx` — 本地工作区选择弹窗

### 改动（前端）
- `web/src/components/WorkspacePanel.tsx` — 组织"本地/远程"两个子面板
- `web/src/types.ts` — 本地状态类型
- `web/src/styles.scss` — 面板样式

### 测试
- `test/local-fs.test.js`、`test/local-exec.test.js`、`test/transfer.test.js`、`test/agent-local.test.js`（新增）
- `test/e2e.js`（补本地场景）

## 5. 组件设计

### 5.1 `server/local-fs.js`

持有 `localWorkspace`（用户选择的本地工作区绝对路径，可空）。方法签名对齐 `ssh-manager`：

- `listDir(p)` → `[{ name, type:'dir'|'file'|'link', size, mtime }]`（用 `fs.readdir({withFileTypes})` + `fs.lstat`，先目录后文件排序）
- `stat(p)` → `fs.stat`（不存在返回 null）
- `readFileChunk(p, {maxBytes, offset})` → `{buffer, size, truncated}`（`fs.open` + 按 offset 读）
- `writeFile(p, content, {maxBytes, mkdir})` → 字节数（自动建父目录）
- `mkdirp(p)` → 递归建目录
- `rmdirRecursive(p, onProgress)` → 递归删除（`fs.rm({recursive:true, force:false})`，逐项回调 onProgress）
- `copyPath(src, dst, {overwrite})` → 复制文件/目录（目录递归，含"不能复制到自身内部"防护）
- `atype(p)` → 'dir'|'file'|'link'|null
- `isProbablyBinary(buf)` → 与远程一致
- `resolveInLocalWorkspace(p, {allowRoot})` → 见 §6

本地路径一律用 Node `path` 模块处理（`path.resolve`/`path.join`），**不**复用 `normalizeRemote`
（那是 POSIX 语义，会强加 `/` 前缀、破坏 `C:\` 盘符与 UNC）。

### 5.2 `server/local-exec.js`

- `exec(command, {cwd, timeout, onOut, onErr, maxOutput})` → `{code, signal, stdout, stderr, timedOut, stopped}`
- 默认 `cwd = localWorkspace`；`command` 以 `cd` 开头时不注入。
- 用 `child_process.exec`（`windowsHide:true`），输出截断策略对齐远程 `EXEC` 常量。
- `kill(runId)` 通过 `child.kill` 停止。

### 5.3 本地工具集（`server/agent/tools.js`）

新增（完整读写，与远程工具一一对应）：

`list_local_dir` / `read_local_file` / `write_local_file` / `edit_local_file` /
`create_local_dir` / `delete_local_path` / `search_local_code` / `run_local_command` / `get_local_info`

- 每个工具的 `run` 走 `local-fs.js` / `local-exec.js`，复用现有 `capText`、`treeLines`、
  `edit 替换`、`resolve 越界` 等辅助逻辑（抽成共享 helper，避免复制粘贴）。
- `delete_local_path` 同样禁止删除本地工作区根目录。
- `search_local_code`：本机探测 `rg`/`grep`（win32 用 `findstr`），找不到则报错提示。
- `get_local_info`：返回本地平台、工作区、家目录、工作区目录骨架，并缓存进环境快照。

### 5.4 守卫

- `run_local_command` 复用/扩展现有 `DANGEROUS_COMMANDS` 正则（`rm -rf /`、`mkfs`、`dd of=/dev/`、
  `chmod -R 777 /` 等），在本地执行同样做最后拦截。
- 所有本地文件工具走 `resolveInLocalWorkspace` 越界守卫（未选本地工作区时报错）。

### 5.5 system prompt（`server/agent/agent.js`）

`_systemPrompt` 增加：

```
本地工作区: <localWorkspace 或 (未设置)>
远程工作区: <remote workspace 或 (未设置)>
```

并加规则：

- 操作**本机**文件/命令用 `*_local` 工具，操作**远程**文件/命令用原工具。
- 不要跨用（本地工具传远程路径、远程工具传本地路径）都属错误。
- 本地工作区未设置时，提示用户先在界面选择本地工作区。

### 5.6 环境快照

`getEnvInfo` 从单一 `{workspace, summary}` 扩展为同时携带本地与远程快照；工作区变化时对应部分失效。

## 6. 本地路径与安全

- `resolveInLocalWorkspace(p, {allowRoot=true})`：把 `p` 解析为本地工作区内的绝对路径。
  - 未选工作区 → 抛"尚未选择本地工作区"。
  - 相对路径以工作区为基准；`..` 越界部分被剥离后重算；最终结果必须等于工作区或以
    `工作区 + path.sep` 为前缀，否则抛"路径超出本地工作区,被拒绝"。
- 删除本地工作区根目录一律拒绝。
- 服务端保持仅监听 `127.0.0.1`（现状已如此），本地 FS/命令能力只在本地浏览器可达；不做外网暴露。

## 7. 双向传输（快捷通道）

WS 新增两个 case（带 `transfer_progress` 进度事件，对齐现有 `delete_progress`）：

### 7.1 本地 → 远程（`local_to_remote`）
- 入参：本地路径列表 + 目标远程目录（默认当前远程目录）。
- 流程：`local-fs` 递归枚举 → 预建远程目标目录（按深度排序去重）→ 并发（8 路）`writeRemoteFile(maxBytes:0, mkdir:false)` 写 SFTP。
- 每完成一项推送 `transfer_progress`，结束推 `done`。

### 7.2 远程 → 本地（`remote_to_local`）
- 入参：远程路径列表 + 目标本地目录（默认当前本地目录）。
- 流程：复用 `collectRemotePaths` 枚举 + SFTP 读 → `fs` 写进本地目录（把现在 tar.gz 落盘改成写本地文件，目录递归创建）。
- 每完成一项推送 `transfer_progress`，结束推 `done`。

### 7.3 冲突处理
- 目标同名默认**询问**：覆盖 / 跳过 / 自动改名（副本）。复用现有复制逻辑的 `ERR_EXISTS` 语义。

## 8. 前端

### 8.1 `LocalFileManager.tsx`
镜像 `FileManager.tsx`：导航 / 面包屑 / 地址栏 / 多选（Ctrl/Shift/全选/Delete）/
右键菜单 / 双击打开（本地文件用 `read_local_file` 读，仍走 FileViewer）/ 上传下载。
差异点：
- 数据源改为 WS 本地 case（`list_local_dir` 等）。
- 顶部加"传到远程当前目录"按钮（`local_to_remote`）。
- 需要"本地工作区选择器"入口（未设本地工作区时引导选择）。

### 8.2 `LocalDirBrowser.tsx`
镜像 `DirBrowser.tsx`，用于选择本地工作区（服务端 `list_local_dir` 起步家目录）。

### 8.3 `WorkspacePanel.tsx`
左侧面板顶部加"本地文件 / 远程文件"两个 Tab（或上下分栏）。本地面板未选工作区时显示引导。
两侧各自记住"当前目录"，切走再切回不丢失。

### 8.4 `FileManager.tsx`（远程）
顶部加"传到本地当前目录"按钮（`remote_to_local`），目标为本地面板的当前目录。

## 9. 错误处理

- 未选本地工作区：面板显示引导，工具抛"尚未选择本地工作区"。
- 越界路径：`resolveInLocalWorkspace` 抛错，结构化错误结果返回给模型/前端，不终结整个会话。
- 本地命令超时/非零退出：返回 `{code, signal, stdout, stderr, timedOut}`，模型可据此判断。
- 传输目标同名：走 §7.3 冲突处理。
- 大文件：`readFileChunk` 分片（`maxBytes` 默认 30KB，最大 100KB），`writeFile` 不限制（传输走 `maxBytes:0`）。

## 10. 测试策略

- `test/local-fs.test.js`：list/read/write/越界守卫/删除根目录拦截/复制到自身内部拦截。
- `test/local-exec.test.js`：本地命令执行、超时、危险命令拦截、输出截断。
- `test/transfer.test.js`：local→remote、remote→local（含目录递归、进度事件、冲突）。
- `test/agent-local.test.js`：用 mock LLM 走通"本地 list → read → write"完整工具循环；双工作区 system prompt 断言。
- `test/e2e.js`：补本地场景联调。
- 现有测试全部保持绿。

## 11. 分步实施顺序

1. `local-fs.js` + `test/local-fs.test.js`（地基）
2. WS 本地浏览/读写 case + `LocalFileManager` / `LocalDirBrowser` / `WorkspacePanel`（先跑起本地文件面板）
3. 双向传输 + `transfer_progress` + 冲突处理（快捷通道）
4. 本地工具集 + `run_local_command` + system prompt + 环境快照（AI 双工作区）
5. `test/local-exec`、`test/transfer`、`test/agent-local`、e2e 收尾

## 12. 明确不做（YAGNI）

- 不做本地文件实时同步/watch。
- 不做远程↔本地的目录自动双向同步（仅手动一键传输）。
- 不做本地版本控制、diff、权限管理界面。
- 不把服务端暴露到外网（保持 127.0.0.1）。

## 13. 技能边界统一（追加需求）

### 13.1 问题现象与根因

- 现象：设置 → 技能列表能看到大量本机/内置技能；但 Agent 使用/调用技能时"一个都找不到"。
- 根因：Agent 侧技能目录被 `ssh.workspace` 门控卡死。
  - `getSkillsCatalog()`（[server/agent/tools.js:632-635](server/agent/tools.js#L632-L635)）开头 `if (!ssh.workspace || skillsCache.ws !== ssh.workspace) return []`：未选远程工作区时永远返回空数组。
  - 导致 system prompt 的技能目录（`renderSkillCatalog(getSkillsCatalog())`）注入为空，模型不知道有哪些技能可用。
  - 且 `skill` 工具的 `loadSkillContent()` 未命中时只在 `ssh.connected` 才回退重扫，未连 SSH 时本机/内置技能完全加载不了。
- 设置面板用的是另一条 `skills_list` → `refreshSkillsCatalog()`（直接扫内置 + 本机 + 远程），所以两处表现不一致。

### 13.2 修复（核心）

1. **缓存 key 复合化**：`skillsCache` 的 key 从单一 `ssh.workspace` 改为 `本地根 + 远程工作区(ssh.workspace) + 远程家目录(ssh.home)` 的复合键；`getSkillsCatalog()` 不再以 `!ssh.workspace` 门控，本地/内置技能在无连接、无工作区时也始终返回。
2. **`skill` 工具无条件回退重扫**：`loadSkillContent()` 未命中时去掉 `ssh.connected` 前提，直接 `refreshSkillsCatalog()`（本机/内置扫描无需 SSH）。
3. **回归验证四条技能入口**，均须在"未连接 SSH、未选远程工作区"下可用：
   - `/` 斜杠菜单技能候选
   - `/技能名 [需求]` 前缀注入（`_runTurn` → `getSkillFull`）
   - `skill` 工具按名加载
   - system prompt 的 `<available_skills>` 目录注入

### 13.3 边界合并（新增第六级来源）

- 技能来源五级 → 六级，新增 **`local-workspace`** = `<本地工作区>/.agents/skills`，与远程 `project`（`<远程工作区>/.agents/skills`）对称；复用本次新增的本地工作区概念。
- 覆盖优先级（低 → 高，同名后者覆盖前者）：
  `builtin < local-user < user < local-project < local-workspace < project`
  （同级"本机 > 远程"；工作区级最高；`local-project` 保留兼容，指向工具运行目录 `.agents/skills`）。
- 前端同步：设置 → 技能面板（SkillsPanel）来源分组、斜杠菜单技能候选，均显示 `local-workspace` 来源；技能管理（新建/编辑/删除/复制内置）的 target 增加 `local-workspace`。

### 13.4 测试

- 新增 `test/skills-catalog.test.js`：
  - 未连 SSH、未选远程工作区时，`refreshSkillsCatalog()` / `getSkillsCatalog()` 返回内置 + 本机技能，不为空。
  - `loadSkillContent()` 在未连 SSH 时能加载本机/内置技能正文。
  - 六级来源同名覆盖优先级断言。
  - `skill` 工具走通"目录 → 按名加载正文"完整链路。

### 13.5 与本地工作区功能的关系

- 本技能边界统一与第 2–11 节的"本地工作区"功能**共享同一个 `localWorkspace` 状态**（`server/local-fs.js` 持有），`local-workspace` 技能扫描即读取该状态。
- 实施时归为独立工作流（Track B），与本地文件面板（Track A）可并行推进；两者在"本地工作区"这一状态点上汇合。
