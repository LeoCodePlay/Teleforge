# Teleforge — AI Coding Tool Bridging SSH Remote & Local

**Languages / 语言：[English](README.en.md) · [简体中文](README.md)**

Teleforge is a self-hosted, browser-based AI coding tool that spans **remote and local** environments. Connect to a server over **SSH** (kept alive with auto-reconnect) and the AI agent operates **directly on the remote machine** — reading real files, editing real code, and running real commands in your actual environment; disconnect and the same agent works on your **local machine** instead. One UI, one tool loop — whichever side of the connection you are on.

![Node](https://img.shields.io/badge/Node-%3E%3D22.18-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)
![Platform](https://img.shields.io/badge/Platform-Local%20Web-7c8aa0)

---

## Screenshot

<p align="center">
  <img src="docs/images/homepage.png" alt="Teleforge main interface" width="800" />
</p>

---

## Key Features

**Connection & Access**

- **Persistent SSH** — 10s heartbeat keepalive, exponential-backoff auto-reconnect, live status; password & private-key auth (incl. passphrase).
- **Named profiles** — save host/port/user/auth as profiles stored server-side (`server/data/ssh-profiles.json`); secrets never leave the server. Switch between **multiple servers** from a dropdown.
- **Multi-server parallelism** — switching servers never interrupts an answering session: it keeps running on its original server in the background (its tools still act there), and the "running" entry stays in the session list so you can switch back and see every generated token.

**Dual Workspaces: Remote ↔ Local**

- **Remote workspace** — browse the remote filesystem and pick any directory as the workspace; the agent's write/edit/delete is confined to it, and **deleting the workspace root is forbidden**.
- **Local workspace** — with no connection you work on your **local machine** with the same tools and UI (file read/write, search, commands).
- **Navigational file manager** — per-directory browsing with double-click to open; **multi-select** (Ctrl/Shift, Ctrl+A, Delete), right-click **delete/download/copy/paste**; server-side permission checks on save.
- **File viewer** — open a file to preview its content, download from the viewer.

**AI Agent Coding**

- Describe the task in conversation; the agent operates **for real** in the target environment (remote or local) via tools:
  - `list_directory` · `read_file` (chunked reads, binary-aware)
  - `write_file` · `edit_file` (precise text replacement)
  - `run_command` (**streaming output**, timeout, 100k-char truncation: head 60k + tail 40k)
  - `create_directory` / `delete_path` (workspace-confined) · `get_workspace_info` · `search_code` (rg/grep)
- **Tool-limited loop** — up to 500 iterations per round, serial by default for observability; each tool can be **enabled/disabled persistently** (disabled tools are invisible to the model and rejected by the execution guard).
- **Auto-compaction** — live context estimation against the model's `contextWindow`; when over budget, **early turns are compressed into a summary** and the run continues seamlessly.
- **Ask the user** — the model can pause and ask a question in the UI, then continue after your answer.
- **Context meter** — live estimate of used context split into **system prompt / tool calls / conversation**, with per-provider input/output window settings.

**Terminal & Command Console**

- **Built-in terminal** — a real PTY interactive shell (`/ws/term`, full-duplex).
- **Command console** — run commands manually with live output & exit code; stop with「⏹」or **Ctrl+C** (SIGINT first, hard-kill fallback).

**File Transfer**

- Upload files/folders to the current directory with progress (auto-refresh on completion); download files or **stream folders as `tar.gz`** from the context menu.

**Models**

- 20+ presets (DeepSeek / OpenAI / Kimi / Zhipu / Qwen / Doubao / Ollama / vLLM …); add **custom providers** (name / Base URL / model list / API key, switch or remove anytime).
- **Last-used model is remembered** per provider; one-click provider/model switcher under the input box; type `/` to open **slash commands**; `mock` mode for **offline end-to-end testing**.

**Sessions & Memory**

- Create/switch/rename/delete/**fork sessions from any earlier message**; event-sourced logs persist and are **restored on restart**; new sessions are auto-named after the first instruction.

**Skills**

- Built-in skill library; the agent loads `SKILL.md` instructions **on demand** via a skill tool; browse/search/create/edit skills in the panel, and duplicate built-ins into editable copies.

**Global Instruction Injection**

- Maintain a prompt-inject text in settings that is automatically injected into every session as a **high-priority system instruction**.

**Theme & UI**

- Liquid-glass dark IDE-style UI; multiple built-in themes plus **custom themes** (design tokens managed centrally, one-click apply).

## Quick Start

> Requirements: **Node.js ≥ 22.18**. The backend is pure TypeScript and runs directly on Node (no build step). The tool listens on `127.0.0.1:4000` by default.

```bash
npm install        # install dependencies
npm run build      # build frontend (outputs web/dist)
npm start          # start server -> http://127.0.0.1:4000
```

Development (frontend hot reload):

```bash
npm run dev        # starts server (:4000) + vite (:5173) -> http://127.0.0.1:5173
```

Usage:

1. Open the page, fill in **SSH connection** (host/port/user + password or private key), click Connect.
2. After connecting, browse the **remote workspace** and pick a directory (or type a path) as your workspace.
3. Configure **AI model** — Base URL / API Key / model name (use `mock` to try the full flow without a real key).
4. Give instructions in the **AI Assistant**, e.g. "Map out this project's structure, then fix the bug in src/main.js".
5. Run commands manually in the **command console** to verify.

## Architecture

```
Browser (React UI)
   │  WebSocket (RPC + real-time events / streaming)
   ▼
Node backend (TypeScript, runs directly on Node 22.18+)
   ├─ api/      Fastify HTTP routes + WebSocket RPC router
   ├─ core/     ssh-manager ── ssh2 ──► remote SSH server (keepalive / reconnect)
   │                 SFTP (files) / exec (commands) / local-fs & local-exec
   ├─ agent/    tool loop ──► tools act on the active connection
   │                 └─ llm (OpenAI-compatible streaming / mock)
   └─ store/    JSON persistence (sessions / SSH profiles / AI providers / UI state)
```

## Tech Stack

| Module | Choice |
|--------|--------|
| Backend | Node.js 22.18+ · TypeScript · Fastify (HTTP) + `ws` (WebSocket) |
| SSH client | `ssh2` (native JS: keepalive / SFTP / exec / Server mode) |
| Real-time transport | `ws` (WebSocket): request/response + event push (streaming) |
| LLM inference | OpenAI-compatible `chat/completions` streaming + function calling |
| Frontend | React 18 + Vite, dark IDE-style UI, lightweight custom Markdown renderer |

## Directory Structure

```
.
├── package.json
├── tsconfig.json / tsconfig.server.json   # frontend / backend TS configs
├── server/                 # Node backend (TypeScript, runs directly on Node ≥22.18)
│   ├── index.ts            # entry: Fastify HTTP + WebSocket + plugin assembly
│   ├── config.ts           # global constants (port / timeouts / output limits)
│   ├── api/                # public interface layer
│   │   ├── http/           #   HTTP routes (basic / providers / transfer / ui-state / static)
│   │   └── rpc/            #   WS RPC message router (router.ts aggregates domains)
│   ├── core/               # infrastructure
│   │   ├── ssh-manager.ts  #   SSH connection pool: keepalive / reconnect / SFTP / exec
│   │   ├── ws.ts           #   WebSocket layer (/ws RPC + /ws/term real PTY)
│   │   ├── local-fs.ts     #   local filesystem adapter (SFTP-aligned API)
│   │   ├── local-exec.ts   #   local command execution
│   │   └── transfer.ts     #   local ↔ remote transfer (per-item progress)
│   ├── agent/              # AI agent engine (event sourcing + tool-limited loop)
│   │   ├── agent.ts        #   main loop: instruction → streaming LLM → tools → iterate
│   │   ├── session.ts      #   append-only session event log (source of truth)
│   │   ├── llm.ts          #   OpenAI-compatible streaming client + offline mock
│   │   ├── tools.ts        #   tool definitions & execution (fs / command / search / ask…)
│   │   ├── registry.ts     #   tool registration · schema whitelisting · guard pipeline
│   │   ├── compact.ts      #   automatic context compression when window is exceeded
│   │   ├── ask-user.ts     #   model→user question seam
│   │   ├── prompt-inject.ts#   global instruction injection
│   │   └── tool-settings.ts#   persist tool enable/disable
│   ├── store/              # JSON persistence (zero-dep · atomic writes)
│   │   ├── session-store.ts    # multi-session event log → project-root data/
│   │   ├── history-store.ts    # cross-turn memory → project-root data/
│   │   ├── ai-providers-store.ts  # AI providers → server/data/
│   │   ├── ssh-profiles-store.ts  # SSH profiles (secrets stay server-side) → server/data/
│   │   └── ui-state-store.ts      # LLM-selection UI state → server/data/
│   └── skills/             # built-in skill library (one SKILL.md dir per skill)
├── web/                    # frontend (React 18 + Vite + TS + SCSS)
│   ├── index.html
│   ├── vite.config.ts      # dev proxy / build config
│   ├── public/             # static assets (logo)
│   ├── LIQUID_GLASS.md     # liquid-glass UI design spec
│   └── src/
│       ├── main.tsx        # entry
│       ├── App.tsx         # layout & state orchestration
│       ├── styles.scss     # global styles
│       ├── api/            # WS client (auto-reconnect + request/reply)
│       ├── components/     # UI components (incl. toolviews/ tool-call views)
│       ├── context/        # React global state (feedback / llm-config)
│       ├── hooks/          # custom hooks
│       ├── types/          # shared types
│       ├── utils/          # helpers (scrollbar / token estimate / tool-row model)
│       ├── data/           # static data (preset LLM providers)
│       └── theme/          # theme system (design tokens)
├── data/                   # runtime data: session history etc. (gitignored)
└── test/                   # tests (local mock SSH server — no real server / API key needed)
    ├── mock-ssh-server.js  # mock SSH server (ssh2 Server mode)
    ├── e2e.js              # end-to-end automation tests
    └── *.test.js           # unit tests (sessions / compact / transfer / local exec)
```

## Testing

The repo ships a **local mock SSH server** so you can run the full flow without a real server or API key:

```bash
npm test
```

Covers: SSH connect → platform detection → list directory → read file → pick workspace → write file → run command (cd prefix) → **full Agent tool loop** (list/read/command/write/summarize).

## Configuration

| Item | Where | Notes |
|------|-------|-------|
| Listen address/port | env `HOST` / `PORT` | default `127.0.0.1:4000`, local access only |
| Model service | "AI model" panel in UI | Base URL / Key / model; custom providers stored in `server/data/ai-providers.json` |
| SSH profiles | "SSH connect" panel | stored in `server/data/ssh-profiles.json` (secrets stay server-side, never sent to the client) |
| Workspace | "Remote workspace" panel | switchable per session; agent writes/edits/deletes are confined to it |
| Session history | project-root `data/` | event-sourced logs, auto-restored on restart (gitignored) |

## Security Notes

- The server **listens on `127.0.0.1` by default**; add a reverse proxy + HTTPS when needed.
- **Custom-provider API keys are stored in plain text at `server/data/ai-providers.json`** (gitignored, never committed); on first launch, providers from `~/.openclaw/openclaw.json` are imported into it. Do not deploy on shared/public networks.
- Agent write/edit/delete is **restricted to the workspace directory** and refuses to delete the workspace root; commands run with timeouts and output caps.
- Use a **dedicated low-privilege account with key auth** on the remote server, and be cautious about letting the agent run destructive commands.
- Running with root privileges allows the tool to read any local file — a normal risk of any local tool.
- All operations and data stay on the local machine and the connected SSH servers; nothing is uploaded to the internet or to the author's servers.

## Roadmap

Implemented: built-in terminal (real PTY), multi-server management, upload/download, concurrent sessions, automatic long-task compaction.

Planned:

- Git operations, error auto-rollback.

## Contributing

Issues and Pull Requests are welcome! Please ensure:

- Code follows the existing style (TypeScript + SCSS, frontend components under `web/src/components/`).
- Fixes/features ship with corresponding tests (see `test/`; tests are built on a local mock SSH server — no real server needed).
- Run `npm run typecheck` and `npm test` before submitting.

## License

Licensed under the **GNU General Public License v3.0**. See [LICENSE](LICENSE).

Copyright (C) 2026 liaozhenqiang.