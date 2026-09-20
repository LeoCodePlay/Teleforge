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
- **Multi-browser sessions** — several browser windows/tabs can be online at once; status and agent events broadcast to all of them, and agent events produced while **every** client is disconnected are buffered in order and replayed on the next connection — no more "finished in the background but the UI is stuck on streaming".

**Dual Workspaces: Remote ↔ Local**

- **Remote workspace** — browse the remote filesystem and pick any directory as the workspace; the agent's write/edit/delete is confined to it, and **deleting the workspace root is forbidden**.
- **Local workspace** — with no connection you work on your **local machine** with the same tools and UI (file read/write, search, commands).
- **Navigational file manager** — per-directory browsing with double-click to open; **multi-select** (Ctrl/Shift, Ctrl+A, Delete), right-click **delete/download/copy/paste**; server-side permission checks on save.
- **Code editor** — text files open directly in a **CodeMirror 6 editor**: syntax highlighting (JS/TS/Python/Go/Rust/Java/C/C++/PHP/SQL/HTML/CSS/Markdown/YAML/XML/Shell and more), line numbers, code folding, bracket matching, autocompletion, search, undo/redo, context menu (cut/copy/paste/copy path), and **Ctrl+S to save back** (remote via SFTP with server-side permission checks; local writes straight to disk); the file's line-ending style is preserved (LF/CRLF applied file-wide).
- **Media preview** — images / video / audio / PDF play inline; the server streams bytes by extension with **Range request support** (video/audio seeking), and files can be downloaded straight from the preview.
- **File viewer** — text edits are tracked with a dirty marker and saved back in one click; binary files are detected and flagged.

**AI Agent Coding**

- Describe the task in conversation; the agent operates **for real** in the target environment (remote or local) via tools:
  - `list_directory` · `read_file` (chunked reads, binary-aware)
  - `write_file` · `edit_file` (precise text replacement)
  - `run_command` (**streaming output**, timeout, 100k-char truncation: head 60k + tail 40k)
  - `create_directory` / `delete_path` (workspace-scoped) · `get_workspace_info` environment awareness · `search_code` code search (rg/grep)
  - `browser_*` controls the built-in browser preview (open / snapshot / click / type / wait / screenshot / evaluate script) — see "Browser Preview" below
  - `subagent` dispatches a **read-only research sub-agent**: the dispatch must include a self-contained **objective + scope** (or a full prompt; too vague and the tool rejects it and gives you a template). The sub-agent uses **in-process execution** (same model, same tool stack, same local/remote workspace) and does **not** call any external agent provider (requesting one will error). Give it a self-contained task, it uses **isolated context** to look things up (cannot see the current conversation, no intermediate results sent back) and returns only the final findings — ideal for "run several parallel explorations" or "keep a large search out of this turn's context". Sub-agents can only read (list dirs / read files / search code / env info / web search); writes and command execution remain with the main agent. Every dispatch creates a run record, accessible from the **Activity Panel** on the right (prompt / step-by-step outputs / tool calls and results). The panel merges "Running Terminal" and "Sub-agent" into one entry (each shows only when it has content); it is read-only and appears only on the AI tab.
  - `todo_write` **Task planning**: create, update and complete task plans inside a conversation; the plan panel persists across turns, unfinished items are carried over to the next model turn, and completed plans are shown once then removed. At most one todo list can be outstanding at a time.
  - `generate_image` **Image generation**: ask the agent to draw an image inside a conversation. A text model can autonomously choose text-to-image (t2i) or image-to-image (i2i, automatically reusing the last generated image as a reference); supports size / quality parameters and multi-turn iteration on a reference. You can also configure a **pure image-endpoint model** (`imageGen`), which routes the whole turn to the image generation pipeline instead of a text chat.
  - `ask_user_question` **Ask the user**: when the model needs more information it pauses and asks a question on the page; execution resumes after your answer. Questions from multiple conversations are queued in order and never overwrite each other.
- **Bounded tool loop**: up to 500 iterations per turn; **parallel tool calls** — read ops execute concurrently (bounded pool), write ops (write/edit/delete) are mutually exclusive to prevent races, and call order strictly follows the model's order. Tools can be **persistently enabled/disabled** (disabled tools are invisible to and cannot be called by the model).
- **Long-context governance** (multi-layer, no interruption on long tasks):
  - **Auto-compact resume**: using the model's `contextWindow`, Teleforge estimates context level in real time and auto-compacts early turns into **summaries** when the watermark is exceeded (default 80% of the usable window); compaction chunks align to tool-pair boundaries — **a deep tool task spawned from a single instruction can still be compacted mid-flight**. If summarization fails it falls back to truncation while preserving the original task anchors, so the conversation never dies on a compaction failure.
  - **Early tool-result folding**: when projecting back to the model, large early tool results are folded into "head + tail + read-back hint"; the event log stays intact (replay / branching still work).
  - **OOB auto-recovery**: when the upstream returns a "context window exceeded" error, Teleforge automatically folds and retries, with no manual steps.
  - A **"context compact" marker line** in the chat stream discloses every compaction (click to expand the summary); `/compact` forces a manual compact at any time, while `/clear` wipes history and `/fork` branches a session (and `/help` shows commands).
- **Message queue** — messages sent while the conversation is processing are queued and executed FIFO after the current turn; supports immediate execution, recall and delete.
- **Context usage display** — uses **real provider-reported token usage** when available (falls back to heuristic estimation when the gateway does not report it). Hover over the meter to see a breakdown (system prompt / tool calls / chat messages). Each provider can be configured with input/output context windows.
- **@ file reference** — type `@` in the input to pull up a workspace file/folder picker (remote + local, instant fuzzy filter); the selected item is sent to the model as a full path.
- **`/` shortcuts** — type `/` to pull up system commands (`/compact`, etc.) and skill commands.

**Permission Mode**

Four permission presets switchable mid-conversation (persisted in session event log):

| Mode | Behavior |
|------|----------|
| **Confirm (default)** | Prompts approval before writes, edits, deletes and commands |
| **Auto-edit** | File writes and edits run automatically; commands still need approval |
| **Plan** | Read-only research phase; write and command tools are rejected outright; the agent only researches and presents a plan |
| **Full-access** | All operations run automatically without prompting (dangerous command guards still apply) |

In Confirm mode, approval prompts are sent through the **`ask_user_question` channel** (Allow / Reject). Rejected operations return a structured error to the model so it can adjust its plan. Cancel, timeout and stop all share the same cleanup path. Tools that do not declare an access level default to **require approval** (fail-closed), so an unregistered write-class tool cannot silently run — even in Plan mode.

**Terminal & Command Console**

- **Built-in terminal** — real PTY interactive shell (dual-channel `/ws/term`).
- **Command console** — run commands manually with live output & exit code; stop with「⏹」or **Ctrl+C** (SIGINT first, hard-kill fallback).
- **Terminal list** — the right side of the command console shows a **terminal list**: open new **remote terminals** (SSH server PTY) or **local terminals** (your machine's `cmd.exe`/`bash`); delete the current terminal with 「✕」 (at least one must remain). Each terminal is an **independent long-lived session** with its own screen / scroll buffer and shell process; switching is show/hide only, no interference, and they stay connected. Status dots on list items show the session state.

**Browser Preview (AI-controllable)**

- **One-click preview of a project address** — when the AI starts a dev server and its output prints something like `http://localhost:5173`, a clickable 「🌐 Preview」 chip appears in the top bar; local addresses in chat replies are clickable too. Both open in a **Browser Preview tab** next to the AI Assistant / Terminal / file tabs (draggable, closable, restored after reload).
- **Links never hijack the app** — clicking any **http(s) link** in chat replies, tool output or release notes opens it in a **Browser Preview tab** (local dev servers and public pages like GitHub alike). On desktop the shell **never navigates the app page itself**, because the shell has no back button — being replaced means a restart. Hold **Ctrl/Cmd** while clicking, or use 「Open in system browser」 in the preview toolbar and context menu, to hand the URL to your default browser.
- **A real browser picture** — the server drives a real Chromium through Playwright and streams the viewport to the front end as binary JPEG frames via CDP screencast; you can **click, scroll and type (IME included)** in the preview exactly as in a browser (frame streaming stops automatically while nobody is watching).
- **The AI drives the very same page** — `browser_open / browser_snapshot / browser_click / browser_type / browser_press / browser_scroll / browser_wait / browser_screenshot / browser_eval / browser_close` let the agent open a page, click/type by the `ref` from a snapshot, wait for conditions, take structured page snapshots and full-page screenshots. What you see is what the AI operates (the same browser session).
- **One preview belongs to one conversation** — a preview browser is bound to whichever conversation opened it, and from then on **only that conversation's AI and its user can drive it**: other conversations cannot click it and their AI cannot call tools on it (the server refuses and names the owner). The conversation is encoded in the tab id (`preview:<sessionId>:<n>`), a convention both ends share, so **one conversation can open several previews** (the `+` button in the tab strip, or the AI passing a new `browser_id`) and different conversations never interfere.
- **Ownership is always visible** — the preview panel shows **「Connected session: <title>」 in its bottom-left corner**. When the preview belongs to a conversation you are not currently in, the panel switches to an amber read-only state and offers a one-click **Bind to current conversation** action (rebinding closes the old browser and recreates it under the new owner, so the page reloads).
- **The AI knows which previews it owns** — while a conversation owns previews, every model request gets the current list injected into its system prompt (`browser_id` → URL / title / loading state) plus the usage rules, so the agent sees a preview it just opened on its **very next step** and clicks/screenshots it instead of calling `browser_open` again. That is also why the `browser_id` argument of every `browser_*` tool may be omitted — omitting it means "my own preview".
- **Draft sessions are carried over** — a preview opened in a brand-new conversation before its first message is bound to a draft id (`d_…`), and both ends rename it onto the real session once that first message creates it, so it never becomes an unowned orphan.
- **Automatic tunnel for remote projects** — with a remote workspace, `localhost:<port>` is forwarded over the existing SSH connection to a local loopback port before previewing (the tunnel is shown in the top bar); in local mode the address is reached directly. Use the `tunnel` argument to force either behavior.
- **Dependency & browser source** — only `playwright-core` is added (no bundled browser download). Launch order is system Chrome → system Edge → Playwright's bundled Chromium; override with `BROWSER_PREVIEW_EXECUTABLE` (path) or `BROWSER_PREVIEW_CHANNEL=chrome|msedge`, and set `BROWSER_PREVIEW_HEADLESS=0` for a headed browser while debugging. A clear message is shown when no browser can be started.
- **Mobile** — a 「🌐 Preview」 entry in the phone bottom bar (with a count badge). Inside the preview a **finger drag scrolls the page and a tap clicks** (no "drag does nothing" like a mouse-only viewer); the `⌨` button in the toolbar raises the soft keyboard on demand, so tapping the page does not pop it by accident; the address bar uses a 16px font so iOS Safari will not zoom the page on focus.
- **Manual entry point** — the 「＋」 at the right of the tab strip (same place as a browser's "new tab") or the phone's 「🌐 Preview」 bottom-bar item opens a preview tab any time; the empty panel accepts a typed/pasted address and lists the **just-detected address plus recent ones** for one-click open.
- **Full-bleed & adaptive** — the preview container's size is synced to the remote page's viewport in real time (switching tabs, resizing the window and rotating the screen all re-apply it), so a page **fills the whole tab area by default** with no black bars and no scaling. Only when the container is smaller than the server's minimum viewport (240px) does it fall back to proportional scaling to avoid stretching.
- **Keyboard & clipboard** — click the page and just type (desktop); on phones press the toolbar `⌨` to raise the soft keyboard, and tapping the page afterwards no longer dismisses it. `Ctrl/Cmd+C / V / X / A` are bridged both ways: after drag-selecting text on the remote page, `Ctrl+C` copies the **remote selection into your clipboard**, while `Ctrl+V` types **your clipboard into the remote page**. The preview is a JPEG frame with nothing selectable locally, so copy/paste always goes through the remote page; phones have no shortcuts, so long-press the page (right-click on desktop) for a copy / paste / cut / select-all menu.

**File Transfer**

- Upload files/folders to the current directory with progress (auto-refresh on completion); right-click 「⬇ Download」 for a file, or **stream a folder as `tar.gz`**.

**Models**

- 20+ presets (DeepSeek / OpenAI / Kimi / Zhipu / Qwen / Doubao / Qianfan / Hunyuan / SiliconFlow / local Ollama / vLLM …); **add custom providers** (name / Base URL / model list / API key, switch or remove anytime).
- **Last-used model is remembered** per provider; one-click provider/model switcher under the input box; type `/` for **slash commands** and `@` to reference workspace files; `mock` mode for **offline end-to-end testing**.

**Skills System**

- **Skill catalog** — built-in skills + local user skills + local-workspace skills (`.agents/skills/`); priority: local-workspace > local-user > built-in. The agent loads `SKILL.md` instructions **on demand** via a `skill` tool; browse / search / create / edit skills in the panel, and duplicate built-ins into editable copies.
- **Skill injection awareness** — when a skill's instructions have already been injected into the current turn, the catalog prompt drops the redundant "call the skill tool to load it" reminder, preventing the model from wasting context on a duplicate load.
- **Works without SSH** — the skill catalog still discovers and loads local skills when no SSH connection is active; it does not depend on a remote workspace.

**Global Instruction Injection**

- Maintain a prompt-inject text in settings that is automatically injected into every session as a **high-priority system instruction**.

**Attachment System**

- Images and other media generated or referenced in a conversation are stored as **attachments** (under `data/attachments/`), each with a unique ID and metadata (type / size / path). Generated images from previous turns are automatically carried forward as references for image-to-image generation.
- **Attachment merging** — multiple batches of images generated in the same turn are **merged cumulatively** and deduplicated by ID. Replays (e.g. after a reconnect) do not overwrite or duplicate attachments: generate three times, see all three.

**Turn Visibility & Rollback**

- **Why the turn stopped** — when a turn is interrupted (model request fails and retries, upstream stream is truncated, or the bound server disconnects), a **visible record** is left in the conversation (`notice` type) that names the reason (e.g. "connection to XX lost", "this turn was not executed"). This never enters the context sent to the model.
- **Partial rollback** — when a model request fails mid-turn and is retried, the system precisely rolls back only the "in-flight but not yet committed" segments from the current step. Already-committed text and tool cards from previous steps are preserved, so retries do not duplicate partial text.

**Sessions & Memory**

- Create / switch / rename / delete / **fork** sessions from any earlier message; event-sourced logs persist and are **restored on restart**; new sessions are auto-named after the first instruction. Supports **group session deletion**: delete multiple sessions at once.

**Theme & UI**

- Liquid-glass dark IDE-style UI; multiple built-in themes plus **custom themes** (design tokens managed centrally, one-click apply).
- **Mobile** — under 768px the layout switches to a **bottom-tab single column** (💬 AI Assistant / ⌨️ Terminal / 📁 Files) with sessions in a top-bar ≡ drawer; tablets get a collapsible sidebar. Lists (file manager, sessions…) support **long-press for the context menu**, and the editor handles the soft keyboard via visual-viewport adaptation.

## Quick Start

> Requirements: **Node.js ≥ 22.18**. The backend is pure TypeScript and runs directly on Node (no build step). The tool listens on `127.0.0.1:4000` by default.

**Desktop installer** (Windows / macOS / Linux) is available directly from **GitHub Releases** — no Node required:

```bash
https://github.com/LeoCodePlay/Teleforge/releases
```

After installation, update from the app via **Settings → About & Update** (one-click installer on Windows; macOS / Linux redirect to Releases for a manual download).

Source-code run:

```bash
npm install        # install dependencies
npm run build      # build frontend (outputs web/dist)
npm start          # start server -> http://127.0.0.1:4000
```

Development mode (frontend HMR):

```bash
npm run dev        # server (:4000) + vite (:5173) in parallel -> http://127.0.0.1:5173
```

Usage:

1. Open the page, fill in **SSH connection** (host / port / user + password or private key), click Connect.
2. After connecting, browse the **Remote Workspace** and pick a directory (or type a path) as your workspace.
3. Configure **AI model** — Base URL / API Key / model name (use `mock` to try the full flow without a real key).
4. Give instructions in the **AI Assistant**, e.g. "Map out this project's structure, then fix the bug in src/main.js".
5. Run commands manually in the **command console** to verify.

## Directory Structure

```
.
├── package.json
├── tsconfig.json / tsconfig.server.json   # frontend / backend TS configs
├── server/                 # Node backend (TypeScript, runs directly on Node ≥22.18)
│   ├── index.ts            # entry: Fastify HTTP + WebSocket + plugin assembly
│   ├── config.ts           # global constants (port / timeouts / output limits)
│   ├── api/                # public interface layer
│   │   ├── http/           #   HTTP routes (basic / providers / transfer / media streaming / tar / ui-state / static)
│   │   └── rpc/            #   WS RPC message router (router.ts aggregates domains, incl. ref.ts @-reference candidates)
│   ├── core/               # infrastructure
│   │   ├── ssh-manager.ts  #   SSH connection pool: keepalive / reconnect / SFTP / exec
│   │   ├── browser-manager.ts #   Browser preview core (Playwright + CDP screencast / input / snapshot)
│   │   ├── port-tunnel.ts  #   Remote port → local loopback SSH tunnel
│   │   ├── ws.ts           #   WebSocket layer (/ws RPC + /ws/term real PTY + /ws/browser preview frames)
│   │   ├── local-fs.ts     #   local filesystem adapter (SFTP-aligned API)
│   │   ├── local-exec.ts   #   local command execution
│   │   └── transfer.ts     #   local ↔ remote transfer (per-item progress)
│   ├── agent/              # AI agent engine (event sourcing + tool-limited loop)
│   │   ├── agent.ts        #   main loop: instruction → streaming LLM → tools → iterate
│   │   ├── session.ts      #   append-only session event log (source of truth)
│   │   ├── llm.ts          #   OpenAI-compatible streaming client + offline mock
│   │   ├── tools.ts        #   tool definitions & execution (fs / command / search / ask / skills / env…)
│   │   ├── registry.ts     #   tool registration · schema whitelisting · guard pipeline
│   │   ├── permission.ts   #   permission modes (confirm / auto-edit / plan / full-access)
│   │   ├── compact.ts      #   automatic context compression & compaction resume
│   │   ├── ask-user.ts     #   model→user question seam
│   │   ├── image-gen.ts    #   image generation pipeline (t2i / i2i, auto-iterate reference images)
│   │   ├── prompt-inject.ts#   global instruction injection (prompt-inject)
│   │   ├── tool-settings.ts#   persist tool enable / disable
│   │   └── subagent.ts     #   read-only research sub-agent
│   ├── store/              # JSON persistence (zero-dep · atomic writes)
│   │   ├── session-store.ts    # multi-session event log → project-root data/
│   │   ├── history-store.ts    # cross-turn memory → project-root data/
│   │   ├── ai-providers-store.ts  # AI providers → server/data/
│   │   ├── ssh-profiles-store.ts  # SSH profiles (secrets stay server-side) → server/data/
│   │   ├── ui-state-store.ts      # LLM-selection UI state → server/data/
│   │   ├── settings-store.ts    # global settings (permission mode / image-gen config) → data/
│   │   ├── attachments-store.ts # attachments (images / videos) storage
│   │   └── subagent-store.ts    # sub-agent run records
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
│       ├── utils/          # helpers (scrollbar / token estimate / tool-row model / attachment merge / command card / rollback)
│       ├── data/           # static data (preset LLM providers)
│       └── theme/          # theme system (design tokens)
├── data/                   # runtime data: session history etc. (gitignored)
└── test/                   # tests (local mock SSH server — no real server / API key needed)
    ├── mock-ssh-server.js  # mock SSH server (ssh2 Server mode)
    ├── e2e.js              # end-to-end automation tests
    └── *.test.js           # unit tests (sessions / compact / transfer / permissions / image-gen / browser / attachments / skills / env-tools)
```

## Testing

The repo ships a **local mock SSH server** so you can run the full flow without a real server or API key:

```bash
npm test
```

Covers: SSH connect → platform detection → list directory → read file → pick workspace → write file → run command (cd prefix) → **full Agent tool loop** (list/read/command/write/edit/skill/sub-agent/plan/ask-user/image-gen/browser), plus unit tests for compaction/tool-result folding, permission mode (confirm / auto-edit / plan / full-access), RPC registry, image generation (text-to-image / image-to-image / reference handling), attachment merging, turn visibility & rollback, command-card merge on `/compact`, skill catalog discovery, environment search tool auto-install, and a long-context optimization smoke test.

## Configuration

| Item | Where | Notes |
|------|-------|-------|
| Listen address/port | env `HOST` / `PORT` | default `127.0.0.1:4000`, local access only |
| Model service | "AI model" panel in UI | Base URL / Key / model; custom providers stored in `ai-providers.json` (see Desktop config below) |
| SSH profiles | "SSH connect" panel | stored server-side (`ssh-profiles.json`); secrets never sent to the client |
| Workspace | "Remote workspace" panel | switchable per session; agent writes/edits/deletes are confined to it |
| Session history | `data/` | event-sourced logs, auto-restored on restart (gitignored, not committed) |
| Permission mode | session event log / Settings | `confirm` / `auto-edit` / `plan` / `full-access`, persisted per session |
| Image generation | Settings "Image generation" | Base URL / API Key / model / quality / size (`settings.json`) |
| Browser preview | env `BROWSER_PREVIEW_EXECUTABLE` / `BROWSER_PREVIEW_CHANNEL` | pick Chrome / Edge for Playwright (default: auto-detect, fallback bundled Chromium); `BROWSER_PREVIEW_HEADLESS=0` enables headed mode |

### Desktop (Tauri installer) configuration directory

The installer **carries no user configuration** (no bundled providers, SSH profiles or session history). On first run it creates its own files under the system App Data directory, per platform:

| Platform | Config directory |
|----------|------------------|
| Windows | `%APPDATA%\com.teleforge.desktop\` |
| macOS | `~/Library/Application Support/com.teleforge.desktop/` |
| Linux | `~/.local/share/com.teleforge.desktop/` |

That directory contains `ai-providers.json` (custom model providers, including API key), `ssh-profiles.json`, `sessions/` (session history), `settings.json`, etc. **The first run does not carry providers in from any third-party config** — "My Providers" starts empty, and you add providers manually under **Settings → AI Config** after install. **Settings → About & Update** lets you view or copy the config directory path.

### Desktop auto-update (Windows)

- Every `v*` tag, GitHub Actions builds installers for all three platforms and publishes them to **GitHub Releases** (`https://github.com/LeoCodePlay/Teleforge/releases`); in-app downloads also resolve to that page.
- The app silently checks GitHub for the latest version at startup. A new version adds an update badge to the top bar; from **Settings → About & Update** you can read release notes and **one-click download → close app → run installer** (one-click install currently only on Windows; macOS / Linux open Releases in the browser for a manual download).
- Update checks need no account or token (public GitHub API; 60 reqs/hour/IP, normal usage is fine).

## Security Notes

- The server **listens on `127.0.0.1` by default**; add a reverse proxy + HTTPS when needed.
- **Custom-provider API keys are stored locally only**: on desktop, under the App Data directory above; in a source install, under `data/ai-providers.json` (plain text, gitignored, never committed). Do not deploy on shared/public networks.
- Agent write/edit/delete is **restricted to the workspace directory** and refuses to delete the workspace root; commands run with timeouts and output caps. The permission mode further controls which operations need approval.
- Use a **dedicated low-privilege account with key auth** on the remote server, and be cautious about letting the agent run destructive commands.
- Running with root privileges allows the tool to read any local file — a normal risk of any local tool.
- Browser preview runs **locally** (server-side Playwright-driven Chromium) and accesses only what you or the agent specifies. Remote projects are forwarded over SSH to a local loopback port; nothing is exposed to the public internet.
- Except for the **model provider you configure** (conversation content must be sent to it for inference), all operations and data stay on the local machine and the connected SSH servers — nothing is uploaded to any third party or the author's servers.

## Roadmap

Implemented: built-in terminal (real PTY), multi-server management, upload/download, concurrent sessions, automatic long-task compaction, code editor & media preview, browser preview (AI-controllable), mobile support, **read-only research sub-agents**, **permission modes** (confirm / auto-edit / plan / full-access), **image generation** (text-to-image / image-to-image / auto-iterate), **task planning** (`todo_write`, cross-turn persistence), **skill catalog** (built-in / local-user / local-workspace), **global instruction injection** (prompt-inject), **attachment system** (multimodal, merged & deduplicated), **turn visibility & rollback**, **command-card merge on /compact**, **environment search tool auto-install**, **mobile support**, **desktop auto-update**.

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
