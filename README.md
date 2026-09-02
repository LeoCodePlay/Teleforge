# Teleforge — SSH 远程 AI 编程工具 / Remote AI Coding over SSH

保持 SSH 连接，把 **AI Agent** 放进你的远程服务器：真实读写文件、执行命令、搜索代码，像在服务器上直接写代码一样。

A local web tool that keeps an SSH connection alive, lets you pick a remote directory as your workspace, and drives an **AI Agent** that genuinely reads/writes files, runs commands, and searches code on your remote server.

![Node](https://img.shields.io/badge/Node-%3E%3D18.17-339933?logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)
![Platform](https://img.shields.io/badge/Platform-Local%20Web-7c8aa0)

---

## English Overview / 英文简介

### What is Teleforge?

**Teleforge** is a self-hosted, browser-based AI coding tool for remote servers. Unlike editors that run an agent locally, Teleforge connects to your server over **SSH** (kept alive with auto-reconnect), so the AI agent operates **directly on the remote machine** — reading real files, editing real code, and running real commands in your actual environment.

### Key Features / 功能摘要

- **Persistent SSH** — 10s heartbeat keepalive, exponential-backoff auto-reconnect, live status; supports password & private-key auth.
- **Named connection profiles** — save host/port/user/auth as profiles (stored locally only), switch between servers from a dropdown.
- **Remote workspace** — browse the remote filesystem, pick any directory as the workspace; navigational file manager with multi-select, delete/download/copy/paste.
- **AI Agent tool loop** — `list_directory`, `read_file`, `write_file`, `edit_file`, `run_command` (streaming output / timeout / truncation), `create_directory`, `delete_path`, `search_code`, `get_workspace_info` — all confined to the workspace.
- **Command console** — run commands manually with live output & exit code; stop with 「⏹」or **Ctrl+C** (SIGINT first, hard-kill fallback).
- **File transfer** — upload files/folders to the current directory with progress; download files or stream folders as `tar.gz`.
- **Multi-model** — 20+ presets (DeepSeek / OpenAI / Kimi / Zhipu / Qwen / Doubao / Ollama / vLLM …), custom providers, and an offline `mock` mode for full flow testing without an API key.
- **Multi-session, multi-server** — parallel sessions persist across restarts; switching servers never interrupts an answering session (it keeps running on its original server in the background).

### Quick Start

```bash
npm install        # install dependencies
npm run build      # build frontend (outputs web/dist)
npm start          # start server -> http://127.0.0.1:4000
```

Development (frontend hot reload):

```bash
npm run dev        # starts server (:4000) + vite (:5173) -> http://127.0.0.1:5173
```

### Architecture

```
Browser (React UI)
   │  WebSocket (real-time events / streaming)
   ▼
Node backend (Express + ws)
   ├─ ssh-manager   ── ssh2 ──► remote SSH server (keepalive / reconnect)
   │                    └─ SFTP (files) / exec (commands)
   └─ agent ── tools ──┘
        └─ llm (OpenAI-compatible API / mock)
```

### Tech Stack / 技术选型

| Module | Choice |
|--------|--------|
| SSH client | `ssh2` (native JS: keepalive / SFTP / exec / Server mode) |
| Real-time transport | `ws` (WebSocket): request/response + event push (streaming) |
| LLM inference | OpenAI-compatible `chat/completions` streaming + function calling |
| Frontend | React 18 + Vite, dark IDE-style UI, lightweight custom Markdown renderer |

### License

Licensed under the **GNU General Public License v3.0**. See [LICENSE](LICENSE).

---

## 中文文档 / Chinese Documentation

一个本地运行的 Web 工具：通过 SSH 连接远程服务器并**保持连接**，选择远程某个目录作为**工作区**，然后就能让 **AI Agent 在远程服务器上真实地读写文件、执行命令、搜索代码**，像在你的服务器上直接写代码一样。

### 核心能力

- **SSH 连接保持**：10s 心跳保活，断线后按指数退避**自动重连**，实时状态展示。支持密码认证与私钥认证（含口令）。
- **连接配置保存**：把主机/端口/用户/认证方式/密码或密钥保存为命名配置（仅存本机），下拉即可切换服务器，快速在多台服务器间往返。
- **远程工作区**：连接后可浏览远程文件系统，选任意目录作为工作区；文件管理器按目录**导航式浏览**（进入哪个目录就显示哪个目录的内容，双击打开文件夹/文件），**支持多选**（Ctrl/Shift 点选、Ctrl+A 全选、Delete 删除），右键菜单对选区执行**删除/下载/复制/粘贴**，编辑保存由服务器做越权校验。
- **AI Agent 编程**：在对话中下达指令，Agent 通过工具在远程真实操作：
  - `list_directory` 列目录、`read_file` 读文件（分片/二进制识别）
  - `write_file` 写文件、`edit_file` 精确文本替换
  - `run_command` 执行命令（流式输出、超时、输出截断）
  - `create_directory` / `delete_path`（仅限工作区，严禁删除根目录）
  - `get_workspace_info` 环境感知、`search_code` 代码搜索（rg/grep）
- **命令台**：手动执行远程命令，观察实时输出与退出码；运行中的命令可点「⏹ 停止」或直接按 **Ctrl+C** 终止（先发 SIGINT，兜底强杀）。
- **文件传输**：文件管理器「⬆ 文件 / ⬆ 文件夹」把本地文件/目录树上传到**当前目录**（带进度条，上传后自动刷新）；右键「⬇ 下载」文件直接下载、文件夹流式打包成 tar.gz 下载；文件查看器也提供「⬇ 下载」。
- **多模型接入**：预置 20+ 主流提供商（DeepSeek / OpenAI / Kimi / 智谱 / 通义 / 豆包 / 千帆 / 混元 / 硅基流动 / 本地 Ollama·vLLM / 等），一键切换提供商与模型；可点「＋」**添加自己的提供商**（名称/Base URL/模型清单/API Key 一并保存，随时切换或删除）；`mock` 模式可**离线联调**完整 Agent 流程。
- **历史会话**：支持建立多个会话并在此列表间**切换/新建/重命名/删除**，每个会话的对话记忆独立持久化，服务重启后自动恢复；新会话首次提问会自动以首条指令命名。**多服务器并行**：切换 SSH 服务器**不会中断**正在回答的会话——它绑定原服务器继续在后台运行（工具操作仍作用于原服务器），会话列表里保留该「运行中」条目（带服务器标记，点击切回查看），切回后已生成的内容一条不少；只有**断开它所属的那台服务器**才会中断，中断时已流式生成的部分内容也会保留在历史里。

### 快速开始

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

### 目录结构

```
.
├── package.json
├── server/                  # Node 后端(NODE 18.17+)
│   ├── index.js             # HTTP + 静态托管 + 接口入口
│   ├── config.js            # 端口/超时/上限等常量
│   ├── ssh-manager.js       # SSH 连接管理:保活/自动重连/SFTP/exec
│   ├── ws.js                # WebSocket 协议层
│   ├── transfer.js          # 文件上传/下载(流式 tar.gz)
│   ├── session-store.js     # 会话历史持久化
│   ├── ai-providers-store.js# AI 提供商配置存储
│   ├── ssh-profiles-store.js# SSH 连接配置存储
│   ├── local-fs.js          # 本地文件系统操作
│   ├── local-exec.js        # 本地命令执行
│   ├── builtin-skills/      # 内置技能目录(skill 目录)
│   └── agent/
│       ├── agent.js         # Agent 主循环(工具有限循环)
│       ├── llm.js           # LLM 客户端(OpenAI 兼容流式 + mock)
│       ├── tools.js         # 工具定义与实现
│       ├── compact.js       # 长会话自动总结续跑
│       └── registry.js      # 技能/工具注册
├── web/                     # 前端(React 18 + Vite + TS + SCSS)
│   └── src/
│       ├── App.tsx          # 布局与状态编排
│       ├── api.ts           # WS 客户端(自动重连 + 请求/应答)
│       ├── components/      # 连接/工作区/对话/命令台/文件查看
│       └── styles.scss
└── test/
    ├── mock-ssh-server.js   # 本地 mock SSH 服务器(基于 ssh2 Server 模式)
    └── e2e.js               # 全链路自动化测试
```

### 运行测试

内置一个**本地 mock SSH 服务器**（无需真实服务器、无需 API Key 即可跑完全链路）：

```bash
npm test
```

覆盖：SSH 连接 → 平台探测 → 列目录 → 读文件 → 选工作区 → 写文件 → 命令执行（cd 前缀） → **Agent 完整工具循环**（列表/读/命令/写/总结）。

### 配置说明

| 项 | 位置 | 说明 |
|----|------|------|
| 监听地址/端口 | 环境变量 `HOST` / `PORT` | 默认 `127.0.0.1:4000`，仅本机访问 |
| 模型服务 | 界面「AI 模型配置」 | Base URL / Key / 模型名，自定义提供商存 `server/data/ai-providers.json` |
| 工作区 | 界面「远程工作区」 | 每会话可换，Agent 的写/改/删被限制在该目录内 |

### 安全说明

- 服务**默认只监听 127.0.0.1**，有条件时建议再加反向代理 + HTTPS。
- **自定义提供商的 API Key 保存在本机 `server/data/ai-providers.json`**（明文，已 .gitignore，不入库）；首次启动会自动把 `~/.openclaw/openclaw.json` 里的提供商导入该配置。请勿用于共享/公网部署。
- Agent 的写/改/删操作被限制在**工作区目录内**，且禁止删除工作区根；命令执行有超时与输出上限。
- 建议用**单独的低权限账号 + 密钥登录**远程服务器，并谨慎让 Agent 执行破坏性命令。
- 本机拿根权限后本工具可读任意文件，属本地工具的正常风险。

### 扩展路线 / Roadmap

- 内置终端（交互式 shell，经 WebSocket 双工）
- 多服务器管理、上传/下载文件
- Agent 多会话/并行、超长任务的自动总结续跑
- Git 操作、错误自动回滚

### 贡献 / Contributing

欢迎 Issue 与 Pull Request！请确保：

- 代码遵循现有风格（TypeScript + SCSS，前端组件放 `web/src/components/`）。
- 新功能/修复附带对应测试（见 `test/`，测试基于本地 mock SSH 服务器，无需真实服务器）。
- 提交前运行 `npm run typecheck` 与 `npm test`。

### 许可证 / License

本项目基于 **GNU General Public License v3.0** 开源，详见 [LICENSE](LICENSE)。
