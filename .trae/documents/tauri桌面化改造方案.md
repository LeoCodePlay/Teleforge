# Teleforge 桌面化改造方案（Tauri v2 + Node 后端 Sidecar）

## Context

Teleforge 目前是「Vite+React 前端 + Fastify Node 后端」的 Web 应用（生产模式由 Node 后端直接托管 `web/dist`，前端全部使用相对 URL）。需求：

1. 打包成**桌面端**，支持 Windows / macOS / Linux，使用 **Tauri 框架**；
2. **隔离后端服务**：后端保持独立 Node 服务，桌面端内置启动它，同时具备独立部署能力（为后续接入登录、模型网关做准备）；
3. **保留 Web 端**：`npm run dev` 的浏览器开发/使用方式不变。

已确认环境：本机 Windows + Rust 1.89 + Node 24；git 远程 `github.com/LeoCodePlay/Teleforge.git`。

## 架构总览

- **桌面壳 = Tauri v2**（Rust）。生产模式：主窗口先加载极简 loading 页（`frontendDist`），Rust 在 setup 中用 `std::process::Command` 启动打包进来的 **Node 运行时 + `server/index.ts`**（动态空闲端口，`DATA_DIR` 指向 App 数据目录），轮询 `/api/health` 就绪后 `window.navigate` 到 `http://127.0.0.1:{port}`。
- 前端所有相对 URL（`/api/*`、`ws://{location.host}/ws`、`/api/media`）因与应用页同源而**天然可用，零前端 URL 改动**。
- **后端随包方式**：携带 Node 运行时二进制 + `server/` 源码副本（Node 22.18+ 类型剥离直接跑 .ts，已验证无 enum/namespace）+ 生产依赖 node_modules（每平台 `npm ci --omit=dev`，获得平台正确的 node-pty 预编译）。**不用 pkg**（规避 node-pty ABI 难题）。
- **下载功能**：webview 中 `window.open` 不可用，改由 Rust 命令 `download`（reqwest 从本机后端拉流 + 原生保存对话框 + 写盘），前端检测到 `window.__TAURI__` 时改调该命令，浏览器模式回落 `window.open`。
- **远程域 IPC**：Tauri v2 无 `dangerousRemoteDomainIpcAccess`，等价机制是 capabilities 的 `remote.urls`；且 **Tauri ≥2.11.2 对远程 origin 的自定义命令有 ACL 门控**，必须用 `AppManifest::commands` 在 build.rs 注册 `download` 并授予 `allow-download`。
- **开发模式**：`beforeDevCommand` 跑现有 `npm run dev`（vite 5173 + server 4000），`devUrl=http://localhost:5173`；Rust 侧 `#[cfg(debug_assertions)]` 不 spawn 后端、不 navigate。

## 文件清单

### 新建

| 文件 | 职责 |
|---|---|
| `src-tauri/Cargo.toml` | `tauri`、`tauri-plugin-dialog`、`serde`、`serde_json`、`reqwest`(default-features=false, features=["stream"]) |
| `src-tauri/build.rs` | `tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(&["download"])))` |
| `src-tauri/tauri.conf.json` | 见下「关键配置」 |
| `src-tauri/capabilities/main.json` | 主窗口：`core:default` + `dialog:default` + `allow-download` + `remote.urls: ["http://127.0.0.1:*/*","http://localhost:*/*"]` |
| `src-tauri/loading/index.html` | 极简启动加载页（内联 CSS 转圈，无外部资源） |
| `src-tauri/src/main.rs` | `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` + 调 `teleforge_lib::run()` |
| `src-tauri/src/lib.rs` | Builder：注册 dialog 插件；setup 里生产模式后台线程 spawn 后端；`invoke_handler![commands::download]`；`RunEvent::ExitRequested` 杀子进程 |
| `src-tauri/src/backend.rs` | 后端生命周期：`TcpListener::bind("127.0.0.1:0")` 取空闲端口 → spawn node（env: PORT/HOST/DATA_DIR，`creation_flags CREATE_NO_WINDOW`(win)，stdout/stderr 落 `app_data_dir/backend.log`）→ 原始 TCP GET 轮询 `/api/health`（30s 超时）→ `run_on_main_thread` 里 `WebviewWindow::navigate`；`stop()` 杀进程 |
| `src-tauri/src/commands.rs` | `#[tauri::command] async fn download(app, api_path, suggested_name)`：保存对话框（用回调式 `.save_file(|p|…)` 避免 GTK 阻塞）→ reqwest 拉 `http://127.0.0.1:{port}{api_path}` → 写盘 |
| `scripts/build.mjs` | 桌面资源打包脚本（产出 `src-tauri/resources/`，见「打包脚本」） |
| `.github/workflows/desktop.yml` | 三平台 CI 构建（见「CI」） |

`src-tauri/resources/`、`src-tauri/target/`、`src-tauri/gen/` 加入 `.gitignore`。

### 修改（存量，改动小）

| 文件 | 改动 |
|---|---|
| `package.json` | devDependencies 加 `@tauri-apps/cli`；scripts 加 `tauri`/`desktop:dev`/`desktop:build`/`desktop:prepare`/`desktop:icon` |
| `server/config.ts` | 新增 `DATA_DIR`（`process.env.DATA_DIR \|\| <项目根>/data`）及全部 store 路径导出（UI_STATE_FILE/SSH_PROFILES_FILE/AI_PROVIDERS_FILE/ATTACHMENTS_DIR/AGENT_TOOLS_FILE/PROMPT_INJECT_FILE/SESSIONS_FILE/SESSIONS_DIR/SETTINGS_FILE/CHAT_HISTORY_FILE） |
| `server/store/{session-store,settings-store,ssh-profiles-store,ui-state-store,ai-providers-store,attachments-store,history-store}.ts`、`server/agent/{prompt-inject,tool-settings}.ts` | 改为从 `config.ts` 导入统一路径（保留各自 env 覆盖，测试注入 DATA_DIR 隔离目录的逻辑不变） |
| `web/src/components/FileManager/FileManager.tsx` | `doDownload`（约 L444-459）：桌面端改调 `invoke('download', …)`，浏览器保留 `window.open` |
| `web/src/components/FileViewer/FileViewer.tsx` | "下载"按钮（约 L105）同款改造 |
| `web/src/utils/desktop.ts`（新增） | `isDesktop()`（`'__TAURI__' in window`）、`downloadViaTauri(apiPath, suggestedName)`（浏览器回落 window.open） |

## 关键配置

`src-tauri/tauri.conf.json` 要点：

```jsonc
{
  "productName": "Teleforge",
  "identifier": "com.teleforge.desktop",
  "build": {
    "beforeDevCommand": "npm run dev",          // vite 5173 + server 4000
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "npm run build && node scripts/build.mjs",
    "frontendDist": "loading"                    // 仅内嵌 loading 页，应用页由 sidecar 托管
  },
  "app": {
    "withGlobalTauri": true,                     // 注入 window.__TAURI__
    "windows": [{ "label": "main", "title": "Teleforge - 远程 AI 编程工具",
                  "width": 1440, "height": 900, "minWidth": 1024, "minHeight": 640, "center": true }],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true, "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
    "resources": { "resources/": "" }            // src-tauri/resources/ 原样铺到 $RESOURCE
  }
}
```

后端 spawn 关键点（backend.rs）：

```rust
let res = handle.path().resource_dir().unwrap();
let node = if cfg!(windows) { res.join("node/node.exe") } else { res.join("node/bin/node") };
let entry = res.join("server/index.ts");
let data_dir = handle.path().app_data_dir().unwrap();
let child = Command::new(&node).arg(&entry)
    .env("PORT", port.to_string()).env("HOST", "127.0.0.1").env("DATA_DIR", &data_dir)
    .current_dir(&res)
    .stdout(log).stderr(log)
    .creation_flags(0x0800_0000)  // windows CREATE_NO_WINDOW
    .spawn()?;
```

## 打包脚本 `scripts/build.mjs`

产出 `src-tauri/resources/`：

1. 清场重建 `node/ server/ web/ node_modules/`；
2. **Node 运行时**：按当前平台/架构下载固定版本（如 `v22.22.0`，≥22.18 保证类型剥离默认开启）——win 取 zip 内 `node.exe`，mac/linux 取 tar 内 `node/bin/node`；支持 env `TF_USE_LOCAL_NODE=1` 用本机 node（本地开发）；
3. **server 源码副本**：`fs.cp('server', …)` 排除 `data/`、`output/`、`node_modules/`、`test/`、`*.log`；
4. **前端产物**：`fs.cp('web/dist', 'resources/web/dist')`（目录名必须 `web`，保证 `static.ts` 的 `../../../web/dist` 相对计算成立）；
5. **精简 node_modules**：`package.json`+`package-lock.json` 拷到临时 staging → `npm ci --omit=dev` → 移到 `resources/node_modules`（Windows 长路径用 `\\?\` 或 robocopy）；
6. Unix `chmod +x resources/node/bin/node`；打印各目录体积与 `node --version` 自检。

## CI（`.github/workflows/desktop.yml`）

- 矩阵：`windows-latest`(nsis) / `macos-latest`(dmg, arm64 + x64) / `ubuntu-22.04`(deb+appimage)。
- 步骤：checkout → `dtolnay/rust-toolchain@stable` → `Swatinem/rust-cache` → Linux 装 `libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libfuse2 file` → `actions/setup-node@v4`(node 24) → `npm ci`（平台本地安装，得到正确 node-pty）→ `npx tauri build --bundles <按平台>`（`NO_STRIP=true` 供 AppImage）→ upload artifact。
- 触发：`v*` tag + workflow_dispatch。

## 实现步骤

1. **后端服务隔离**：`server/config.ts` 加 DATA_DIR 及统一路径导出 → 各 store 改引（保 env 覆盖）→ 跑 `npm test` 与 `npm run typecheck` 回归。
2. **前端下载适配**：新增 `web/src/utils/desktop.ts`，改造 FileManager/FileViewer 下载分支；`npm run build` 验证。
3. **Tauri 壳**：`npm i -D @tauri-apps/cli`；`npx tauri init` 后改写 tauri.conf.json / Cargo.toml / build.rs / capabilities；写 loading 页、main.rs/lib.rs/backend.rs/commands.rs。
4. **图标**：`npx tauri icon web/public/logo.png` 生成 `src-tauri/icons/`。
5. **打包脚本**：写 `scripts/build.mjs`，本地跑一次产出 resources，验证 `resources/node/… --version` 与 `resources/server/index.ts` 可被该 node 启动。
6. **本地冒烟**：`npm run desktop:dev`（vite 代理模式）确认开发态；`npm run desktop:build` 出 Windows 安装包，安装后验证：窗口加载、SSH 连接、终端、文件下载（重点验证远程域 ACL 的 `download` 命令）。
7. **CI**：补 workflow；本地 `cargo check` + 一次 `tauri build` 确保无编译错误后提交。

## 验证

- 后端隔离回归：`npm run typecheck` + `npm test`（原有 62+ 用例，重点 `session-scope`/`compact` 涉及 DATA_DIR 注入）。
- 浏览器模式不回退：`npm run dev` 照常。
- 桌面 Windows 产物：安装 → 启动（无黑窗闪现）→ 加载页 → 主界面；SSH 连接 + 终端可交互；文件下载走原生保存框；退出后进程树无残留 node。
- `tauri build` 产物里实际点一遍下载（远程域 ACL 只在生产产物暴露）。
- CI 三平台产物上传成功（mac/linux 本机无法测，靠 CI）。

## 已知限制 / 后续

- 数据迁移：现有开发目录 `data/`、`server/data/` 不会自动带入桌面 App 数据目录（首启为空），后续可加一次性迁移。
- macOS 未签名：首次运行需右键打开或 ad-hoc 签名；正式分发接入签名/公证。
- 后续接入登录/模型网关：后端已是独立服务（env 配置 + /api/health），桌面端把 `BASE_URL` 指向远端即可；前端届时加 base-url 配置层（本次不动）。
