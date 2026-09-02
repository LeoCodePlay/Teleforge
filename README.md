# Teleforge — 支持 SSH 远程与本地互通的 AI 编程工具

**语言 / Languages：[简体中文](README.md) · [English](README.en.md)**

一个本地运行的 Web 工具：通过 SSH 连接远程服务器并**保持连接**，让 **AI Agent 在远程服务器上真实地读写文件、执行命令、搜索代码**；未连接时则在本机工作区上执行同样的操作。远程与本地一套界面、一套工具，像把 AI 编程助手直接装进目标环境一样。

![Node](https://img.shields.io/badge/Node-%3E%3D22.18-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)
![Platform](https://img.shields.io/badge/Platform-Local%20Web-7c8aa0)

---

## 界面预览

<p align="center">
  <img src="docs/images/homepage.png" alt="Teleforge 主界面" width="800" />
</p>

---

## 核心能力

**连接与访问**

- **SSH 连接保持**：10s 心跳保活，断线后按指数退避**自动重连**，实时状态展示；支持密码认证与私钥认证（含口令）。
- **连接配置保存**：把主机/端口/用户/认证方式/密码或密钥保存为命名配置（存于服务端 `server/data/ssh-profiles.json`，密码/私钥只留服务端、不下发前端），下拉即可在**多台服务器**间快速切换。
- **多服务器并行**：切换服务器**不会中断**正在回答的会话——它绑定原服务器继续在后台运行（工具操作仍作用于原服务器），会话列表里保留该「运行中」条目，切回后已生成的内容一条不少。

**远程 ↔ 本地双工作区**

- **远程工作区**：连接后浏览远程文件系统，选任意目录作为工作区；Agent 的写/改/删以工作区为界，且**严禁删除工作区根目录**。
- **本地工作区**：未连接时进入本地模式，Agent 可在本机目录上执行**同样的操作**（读写/搜索/命令），远程与本地共用同一套界面与工具。
- **导航式文件管理**：按目录逐层浏览、双击打开；**多选**（Ctrl/Shift 点选、Ctrl+A 全选、Delete 删除），右键菜单对选区执行**删除/下载/复制/粘贴**；编辑保存由服务端做越权校验。
- **文件查看器**：点击即可查看文件内容，并支持从查看器直接下载。

**AI Agent 编程**

- 对话式下达指令，Agent 通过工具在目标环境（远程或本地）**真实操作**：
  - `list_directory` 列目录 · `read_file` 读文件（分片读取、二进制识别）
  - `write_file` 写文件 · `edit_file` 精确文本替换
  - `run_command` 执行命令（**流式输出**、超时、输出截断：前 60k + 后 40k）
  - `create_directory` / `delete_path`（仅限工作区）· `get_workspace_info` 环境感知 · `search_code` 代码搜索（rg/grep）
- **工具有限循环**：单轮对话最大迭代 500 次、默认串行执行便于观察；工具开关可**持久化启停**（禁用后模型不可见也不可调用）。
- **自动压缩续推**：按模型 `contextWindow` 实时估算上下文水位，超限时自动把**早期对话压缩为摘要**再继续，长任务不中断。
- **向用户提问**：模型需要补充信息时可暂停并向页面提问，等待你的回答后继续。
- **上下文水位显示**：实时估算已用上下文，按**系统提示词 / 工具调用 / 对话消息**分项展示；各提供方可配置模型的输入/输出窗口。

**终端与命令台**

- **内置终端**：真实 PTY 交互式 shell（`/ws/term` 双工通道）。
- **命令台**：手动执行命令，实时输出与退出码；「⏹ 停止」或 **Ctrl+C** 终止（先发 SIGINT，兜底强杀）。

**文件传输**

- 「⬆ 文件 / ⬆ 文件夹」上传本地文件/目录树到当前目录（带进度条，完成后自动刷新）；右键「⬇ 下载」文件直接下载、**文件夹流式打包 tar.gz** 下载。

**模型接入**

- 预置 20+ 主流提供商（DeepSeek / OpenAI / Kimi / 智谱 / 通义 / 豆包 / 千帆 / 混元 / 硅基流动 / 本地 Ollama·vLLM 等）；「＋」**添加自定义提供商**（名称/Base URL/模型清单/API Key，随时切换或删除）。
- 各提供方**记住上次使用的模型**；输入框下方一键切换提供方/模型；输入 `/` 唤出**快捷指令**（slash 命令）；`mock` 模式可**离线联调**完整流程。

**会话与记忆**

- 多会话**切换/新建/重命名/删除/分支**（可从任意历史消息分支出新会话）；事件溯源日志持久化，**重启自动恢复**；新会话自动以首条指令命名。

**技能系统**

- 内置技能库，Agent 通过 skill 工具**按需加载** `SKILL.md` 指令；面板支持搜索/新建/编辑，内置技能可复制为可编辑副本。

**全局指令注入**

- 在设置中维护 prompt-inject 文本，自动作为**高优先级 system 指令**注入每次会话。

**主题与界面**

- 液态玻璃（Liquid Glass）风格的深色 IDE 界面；内置多套主题并支持**自定义主题**（设计 token 集中管理，一键套用）。

## 快速开始

> 环境要求：**Node.js ≥ 22.18**。后端为纯 TypeScript，由 Node 直接运行（无需编译步骤）。

```bash
npm install        # 安装依赖
npm run build      # 构建前端(输出 web/dist)
npm start          # 启动服务 -> http://127.0.0.1:4000
```

开发模式（前端热更新）：

```bash
npm run dev        # 同时启动 server(:4000) 与 vite(:5173), 打开 http://127.0.0.1:5173
```

使用步骤：

1. 打开页面，填 **SSH 连接**（主机/端口/用户 + 密码或私钥），点「连接」
2. 连接后在「远程工作区」浏览选择目录作为工作区（或直接输入路径）
3. 在「AI 模型配置」填 Base URL / API Key / 模型名并保存（不填真实 Key 时可用 `mock` 体验）
4. 到「AI 编程助手」下达指令，如：「梳理一下这个项目的结构，然后修复 src/main.js 里的 bug」
5. 到「命令台」可手动执行命令验证

## 目录结构

```
.
├── package.json
├── tsconfig.json              # 前端 TS 配置
├── tsconfig.server.json       # 后端 TS 配置
├── server/                    # Node 后端(TypeScript,由 Node ≥22.18 直接运行)
│   ├── index.ts               # 入口:Fastify HTTP + WebSocket + 插件装配
│   ├── config.ts              # 端口 / 超时 / 输出上限等全局常量
│   ├── api/                   # 对外接口层
│   │   ├── http/              #   HTTP 路由(基础/提供商/传输/UI 状态/静态托管)
│   │   └── rpc/               #   WS RPC 消息路由(router.ts 汇总各领域模块)
│   ├── core/                  # 基础设施
│   │   ├── ssh-manager.ts     #   SSH 连接池:保活 / 自动重连 / SFTP / exec
│   │   ├── ws.ts              #   WebSocket 服务层(/ws RPC + /ws/term 真实 PTY)
│   │   ├── local-fs.ts        #   本地文件系统适配(与 SFTP 对齐签名)
│   │   ├── local-exec.ts      #   本地命令执行
│   │   └── transfer.ts        #   本地 ↔ 远程双向传输(逐项进度)
│   ├── agent/                 # AI Agent 引擎(事件溯源 + 工具有限循环)
│   │   ├── agent.ts           #   主循环:指令 → 流式 LLM → 工具 → 迭代
│   │   ├── session.ts         #   append-only 会话事件日志(唯一事实源)
│   │   ├── llm.ts             #   OpenAI 兼容流式客户端 + mock 离线联调
│   │   ├── tools.ts           #   工具定义与执行(读写/命令/搜索/提问…)
│   │   ├── registry.ts        #   工具注册 · schemas 白名单投影 · 守卫管线
│   │   ├── compact.ts         #   上下文窗口超限自动压缩续推
│   │   ├── ask-user.ts        #   模型向用户提问接缝
│   │   ├── prompt-inject.ts   #   全局指令注入(prompt-inject 管理)
│   │   └── tool-settings.ts   #   工具启用 / 禁用持久化
│   ├── store/                 # JSON 持久化(零依赖 · 原子写)
│   │   ├── session-store.ts   #   多会话事件日志 → 项目根 data/
│   │   ├── history-store.ts   #   跨轮对话记忆 → 项目根 data/
│   │   ├── ai-providers-store.ts  # AI 提供商配置 → server/data/
│   │   ├── ssh-profiles-store.ts  # SSH 配置(密码/私钥只存服务端)→ server/data/
│   │   └── ui-state-store.ts      # LLM 选择级 UI 状态 → server/data/
│   └── skills/                # 内置技能库(每个技能一个含 SKILL.md 的目录)
├── web/                       # 前端(React 18 + Vite + TS + SCSS)
│   ├── index.html
│   ├── vite.config.ts         # 开发代理 / 构建配置
│   ├── public/                # 静态资源(logo)
│   ├── LIQUID_GLASS.md        # 液态玻璃 UI 设计规范
│   └── src/
│       ├── main.tsx           # 入口
│       ├── App.tsx            # 布局与状态编排
│       ├── styles.scss        # 全局样式
│       ├── api/               # WS 客户端(自动重连 + 请求/应答)
│       ├── components/        # UI 组件(含 toolviews/ 工具调用视图)
│       ├── context/           # React 全局状态(feedback / llm-config)
│       ├── hooks/             # 自定义 Hook
│       ├── types/             # 共享类型
│       ├── utils/             # 工具函数(滚动条 / token 估算 / 工具行模型)
│       ├── data/              # 静态数据(预置 LLM 提供商)
│       └── theme/             # 主题系统(设计 token)
├── data/                      # 运行期数据:会话历史等(gitignore,不入库)
└── test/                      # 测试(基于本地 mock SSH 服务器,无需真实服务器 / API Key)
    ├── mock-ssh-server.js     # mock SSH 服务器(ssh2 Server 模式)
    ├── e2e.js                 # 全链路自动化测试
    └── *.test.js              # 会话/压缩/传输/本地执行等单元测试
```

## 运行测试

内置一个**本地 mock SSH 服务器**（无需真实服务器、无需 API Key 即可跑完全链路）：

```bash
npm test
```

覆盖：SSH 连接 → 平台探测 → 列目录 → 读文件 → 选工作区 → 写文件 → 命令执行（cd 前缀） → **Agent 完整工具循环**（列表/读/命令/写/总结）。

## 配置说明

| 项 | 位置 | 说明 |
|----|------|------|
| 监听地址/端口 | 环境变量 `HOST` / `PORT` | 默认 `127.0.0.1:4000`，仅本机访问 |
| 模型服务 | 界面「AI 模型配置」 | Base URL / Key / 模型名，自定义提供商存 `server/data/ai-providers.json` |
| SSH 服务器配置 | 界面「SSH 连接」 | 保存的配置存 `server/data/ssh-profiles.json`（密码/私钥只留服务端，不下发前端） |
| 工作区 | 界面「远程工作区」 | 每会话可换，Agent 的写/改/删被限制在该目录内 |
| 会话历史 | 项目根 `data/` | 多会话事件日志与跨轮记忆，重启自动恢复（gitignore，不入库） |

## 安全说明

- 服务**默认只监听 127.0.0.1**，有条件时建议再加反向代理 + HTTPS。
- **自定义提供商的 API Key 保存在本机 `server/data/ai-providers.json`**（明文，已 .gitignore，不入库）；首次启动会自动把 `~/.openclaw/openclaw.json` 里的提供商导入该配置。请勿用于共享/公网部署。
- Agent 的写/改/删操作被限制在**工作区目录内**，且禁止删除工作区根；命令执行有超时与输出上限。
- 建议用**单独的低权限账号 + 密钥登录**远程服务器，并谨慎让 Agent 执行破坏性命令。
- 本机拿根权限后本工具可读任意文件，属本地工具的正常风险。

## 扩展路线 / Roadmap

已实现：内置终端（真实 PTY）、多服务器管理、上传/下载、多会话并行、长任务自动总结续推。

尚在规划：

- Git 操作、错误自动回滚

## 贡献 / Contributing

欢迎 Issue 与 Pull Request！请确保：

- 代码遵循现有风格（TypeScript + SCSS，前端组件放 `web/src/components/`）。
- 新功能/修复附带对应测试（见 `test/`，测试基于本地 mock SSH 服务器，无需真实服务器）。
- 提交前运行 `npm run typecheck` 与 `npm test`。

## 许可证 / License

本项目基于 **GNU General Public License v3.0** 开源，详见 [LICENSE](LICENSE)。

Copyright (C) 2026 liaozhenqiang.