# 方案:通过浏览器扩展把「本机真实浏览器」接入 AI 控制

> 目标:让 AI 能操控用户本机那个**真实的、已登录的** Chrome/Edge(开新标签、关标签、点元素、输入、截图……),
> 并且在扩展未连接时自动回退到现有的内置预览浏览器。
> 本文只描述设计与实施路径,尚未写代码。

---

## 1. 结论先行

三层结构,**扩展是唯一可行的"连接真实浏览器"通道**:

```
┌──────────────────────────────┐     WebSocket(127.0.0.1:4000/ws/ext, 带配对 token)
│ Teleforge Auto(MV3 扩展)      │◄──────────────────────────────────────────────┐
│  background SW: 标签 / 页面操作 │                                              │
└──────────────────────────────┘                                              │
                                                                              │
┌─────────────────────────────────────────────────────────────────────────────┴──┐
│ Teleforge 服务端 (server/)                                                      │
│  core/browser-bridge.ts  ← 新增:扩展连接 + 请求应答 + 状态事件                     │
│  core/browser-manager.ts ← 既有:Playwright 内置预览(兜底)                        │
│  agent/browser-backends.ts ← 新增:统一后端接口 (native | preview)                 │
│  agent/browser-tools.ts  ← 改造:默认 auto 路由,有扩展走真机,否则走预览            │
└─────────────────────────────────────────────────────────────────────────────────┘
                                                                              │
┌──────────────────────────────┐                                              │
│ Web 前端 BrowserPanel         │◄──── 既有 /ws 通道(RPC):连接状态 / 标签列表 / 开关 ┘
└──────────────────────────────┘
```

**为什么不用别的路子**
- `--remote-debugging-port` 直连:新版 Chrome 已禁止对**默认用户配置目录**开放远程调试,拿不到用户日常那个带登录态的浏览器;而且要求浏览器按特定参数启动,体验差。
- Native Messaging:需要写注册表 + 本地 host 程序,Windows 上安装繁琐,扩展还要额外审批,收益不大。
- 纯 CDP 扩展(`chrome.debugger`)其实就是在扩展里拿 CDP,能力与现有 Playwright 几乎 1:1 对齐,**复用成本最低**。

---

## 2. 现状(已核实,含证据行号)

| 能力 | 位置 | 说明 |
|---|---|---|
| 内置预览浏览器 | `server/core/browser-manager.ts` | `BrowserManager extends EventEmitter`(:354),Playwright 启动,优先系统 Chrome → Edge → 自带 Chromium(:213-225) |
| 页面快照脚本 | 同上 `SNAPSHOT_SCRIPT`(:246-318) | 自包含函数,给元素打 `data-tp-ref="eN"` 并返回结构化 JSON |
| 快照格式化 | 同上 `formatSnapshot`(:320-342) | 把上面的 JSON 转成模型看的文本 |
| 按键归一化 | 同上 `normalizeKey`(:345-352) | |
| 浏览器工具(11 个) | `server/agent/browser-tools.ts` | open/snapshot/navigate/click/type/press/scroll/wait/screenshot/eval/close |
| 工具注册点 | `server/agent/tools.ts:1246` | `for (const def of browserToolDefs) registry.register(withSafety(def))` |
| WS 通道 | `server/core/ws.ts:45-65` | 现有 3 个:`/ws`(前端)、`/ws/term`、`/ws/browser`;upgrade 路由在 :55-65,未匹配即 `socket.destroy()` |
| WS 鉴权 | 无 | 全 server 无 token / Origin 校验 / CORS —— **新通道必须自己加** |
| RPC 模块 | `server/api/rpc/*.ts`,注册于 `api/rpc/router.ts:44-51` | 按 `msg.type` 分发 |
| 前端 | `web/src/components/BrowserPanel/BrowserPanel.tsx`、`web/src/components/toolviews/BrowserRow.tsx` | 预览面板与工具卡片 |
| 扩展相关代码 | 无 | 全仓搜索 extension / chrome.debugger / nativeMessaging / 9222 均零命中 |

**可直接复用的资产**:`SNAPSHOT_SCRIPT`、`formatSnapshot`、`normalizeKey`、`/ws/browser` 的通道写法、`api/rpc/browser.ts` 的 RPC 写法、`api/http/computer-use.ts` 的"外部进程回调服务端"先例。

---

## 3. 扩展侧设计(Teleforge Auto,`extension/` 目录)

### 3.1 文件结构

```
extension/
  manifest.json          MV3
  background.js          service worker:连接、路由、标签与页面操作
  cdp.js                 chrome.debugger 封装(attach/detach/send)
  page-ops.js            snapshot / click / type / press / scroll / wait 的 CDP 实现
  snapshot-script.js     与 server 的 SNAPSHOT_SCRIPT 同源(构建时从 server 复制,避免两份漂移)
  popup.html / popup.js  连接状态、配对 token 输入、暂停开关、标签授权
  icons/
```

### 3.2 权限

```json
{
  "manifest_version": 3,
  "permissions": ["tabs", "debugger", "scripting", "storage", "alarms", "activeTab"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" }
}
```

`debugger` 是重权限(会提示"读取和更改所有网站上的所有数据"),所以**按需 attach**:只有真要操作某个标签时才 attach,操作完可 detach(可配置常驻以减少抖动)。

### 3.3 消息协议(WS `/ws/ext`)

```jsonc
// 扩展 → 服务端
{ "type": "ext_hello", "token": "...", "version": "1.0.0", "browser": "chrome", "capabilities": ["tabs","cdp","screenshot"] }
{ "type": "ext_result", "id": 42, "ok": true, "data": { /* ... */ } }
{ "type": "ext_result", "id": 42, "ok": false, "error": "标签已关闭" }
{ "type": "ext_event", "event": "tab_updated", "data": { "tabId": 7, "url": "...", "title": "..." } }
{ "type": "ext_pong" }

// 服务端 → 扩展
{ "type": "ext_welcome", "ok": true, "heartbeatMs": 20000 }
{ "type": "ext_call", "id": 42, "method": "click", "params": { "tabId": 7, "ref": "e3" } }
{ "type": "ext_ping" }
```

`ext_call` 的 `id` 由服务端自增,与 `ext_result.id` 配对 —— 与现有 `reqId` 的"请求-应答"约定同构,前端那条 `/ws` 通道不受影响。

### 3.4 方法清单与 CDP 映射

| method | 实现 | 对应 AI 工具 |
|---|---|---|
| `tabs.list` | `chrome.tabs.query({})` | 新增 `browser_tabs` |
| `tabs.open` | `chrome.tabs.create` + 等 `tabs.onUpdated:complete` | `browser_open` |
| `tabs.close` | `chrome.tabs.remove` | `browser_close` |
| `tabs.activate` | `chrome.tabs.update({active:true})` | 新增 |
| `navigate` | `Page.navigate` | `browser_navigate` |
| `reload` / `back` / `forward` | `Page.reload` / `Page.getNavigationHistory`+`Page.navigateToHistoryEntry` | 同上 |
| `snapshot` | attach → `Runtime.evaluate(SNAPSHOT_SCRIPT, returnByValue)` | `browser_snapshot` |
| `click` | `Runtime.evaluate` 取 `[data-tp-ref]` 的 rect → `Input.dispatchMouseEvent`(move/down/up) | `browser_click` |
| `type` | `Runtime.evaluate` 聚焦+清空 → `Input.insertText` / `Input.dispatchKeyEvent`;`submit` 再发 Enter | `browser_type` |
| `press` | `Input.dispatchKeyEvent`(rawKeyDown/keyUp + modifiers) | `browser_press` |
| `scroll` | `Input.dispatchMouseEvent{type:mouseWheel}` | `browser_scroll` |
| `wait` | 轮询 `Runtime.evaluate`(text / selector / url) | `browser_wait` |
| `screenshot` | `Page.captureScreenshot({captureBeyondViewport: fullPage})` | `browser_screenshot` |
| `evaluate` | `Runtime.evaluate` | `browser_eval` |

**关键取舍:扩展只回"原始数据",格式化留在服务端**。`snapshot` 返回 `SNAPSHOT_SCRIPT` 的原始 JSON,由服务端复用 `formatSnapshot()` 渲染成文本 —— 保证 native 与 preview 两种后端的快照**逐字一致**,模型不需要学两套。

### 3.5 保活(MV3 的坑)

- 服务端每 20s 发 `ext_ping`,扩展回 `ext_pong`;**WebSocket 活跃会重置 SW 空闲计时器**(Chrome 116+ 行为),足以维持常驻。
- 断线指数退避重连(1s→2s→5s→15s,上限 30s)+ `chrome.alarms` 每 30s 兜底唤醒。
- 若实测仍被杀,升级为 **offscreen document** 持有 WS(官方推荐的 MV3 长连接做法),SW 只做消息中转。

---

## 4. 服务端桥接(`server/core/browser-bridge.ts`,新增)

```ts
class BrowserBridge extends EventEmitter {
  get status(): { online: boolean; version: string | null; browser: string | null; tabs: TabInfo[] }
  isReady(): boolean
  call<T>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T>
  // 事件:'change'(连接/断开/标签变化)
}
export const browserBridge = new BrowserBridge();
```

**WS 通道**:照 `/ws/browser`(`core/ws.ts:332-398`)的样板加第 4 个 `extWss`,别忘了这些"隐藏清单":
1. `core/ws.ts:46-50` 新增 `new WebSocketServer({ noServer: true, maxPayload })`
2. `core/ws.ts:55-65` upgrade 路由加 `/ws/ext` 分支(漏了会落到 `socket.destroy()`)
3. `core/ws.ts:448` 把 `extWss` 加进心跳定时器
4. `core/ws.ts:458` 的 return 一起返回
5. `server/index.ts:53 / 68 / 74-79` 解构、返回、shutdown 关闭

**鉴权(必须做,不能省)**

- 服务端首次启动生成随机 token,持久化到 `data/browser-bridge.json`(文件权限尽量收紧)。
- 用户在扩展 popup 粘贴一次,存 `chrome.storage.local`。
- upgrade 时同时校验:①`Origin` 以 `chrome-extension://` 开头;②`?token=` 匹配。
- 为什么必须:现有 `/ws` 通道**完全没有鉴权**,而 WebSocket 不受同源策略限制 —— 任意本机打开的网页都能连 `ws://127.0.0.1:4000/...`。若不加 token,任何网页都能冒充扩展接管用户浏览器,这是最高危的漏洞。

**标签授权模型**

| 模式 | AI 可操作的标签 |
|---|---|
| `ai-tabs`(**默认**) | AI 自己创建的标签 + 用户在 popup/面板里显式"交给 AI"的标签 |
| `all` | 所有标签(含已登录站点;需用户在 UI 明确开启并二次确认) |

所有 native 操作写审计日志(时间、方法、tabId、URL),落 `data/browser-bridge.log` 或现有日志通道。

---

## 5. 工具层改造:统一后端 + auto 路由

### 5.1 后端接口(新增 `server/agent/browser-backends.ts`)

```ts
interface BrowserTarget { kind: 'native' | 'preview'; id: string; url: string; title: string }

interface BrowserBackend {
  kind: 'native' | 'preview';
  available(): boolean;
  list(): BrowserTarget[];
  open(url: string, opts): Promise<BrowserTarget>;
  navigate(targetId: string, url: string): Promise<...>;
  snapshot(targetId: string): Promise<string>;   // 都返回同一格式的文本
  click(targetId: string, t: { ref?; selector?; text? }): Promise<string>;
  fill / press / scroll / waitFor / screenshot / evaluate / close
}
```

- `preview` 后端 = 现有 `browserManager` 的薄包装(行为完全不变)。
- `native` 后端 = `browserBridge.call(...)` + 复用 `formatSnapshot`。

### 5.2 路由规则(`browser-tools.ts`)

```ts
function pickBackend(args, ctx): BrowserBackend {
  if (args.target === 'preview') return previewBackend;
  if (args.target === 'native')  return requireNative();   // 不可用 → 明确报错,不静默回退
  // auto(默认):扩展在线且已授权 → 真机;否则 → 内置预览
  return nativeBackend.available() ? nativeBackend : previewBackend;
}
```

- 工具新增参数 `target?: 'auto' | 'native' | 'preview'`(默认 `auto`)、`tab_id?: number`。
- `browser_id` 语义不变(预览标签);native 的标识用 `native:tab:<tabId>`。
- 返回 `meta` 增加 `backend: 'native' | 'preview'`,让前端卡片和模型都能看出"现在操作的是哪个浏览器"。
- 工具名与参数**全部保持兼容**,现有对话/提示词不需要改。

### 5.3 回退行为

- 扩展断开:`browserBridge` 发 `change` → 前端状态条变灰 → 下一次工具调用自然走 preview。
- 执行中途断开:该次调用返回明确错误(`真机浏览器连接已断开,已回退内置预览,请重试`),**不静默换目标重放**(避免在错误页面上重复点击)。
- 标签被用户关闭 / DevTools 抢占了 debugger:返回可操作提示(如"请关闭该标签的 DevTools 后重试")。

---

## 6. 前端 UI(`web/src/components/BrowserPanel`)

- **状态条**:`真机浏览器:已连接 (Chrome 153) / 未连接 —— 回退内置预览`,带一键"暂停 AI 控制"。
- **标签列表**:native 模式下列出可操作标签,支持"交给 AI / 收回"。
- **配对引导**:展示 token + 复制按钮 + "打开 chrome://extensions"指引;首次连接后自动隐藏。
- **工具卡片**(`toolviews/BrowserRow.tsx`):显示 `backend` 徽标 + 目标标签标题。
- native 模式**不推 screencast 画面**(真机浏览器用户自己就看得见),这是与 preview 的本质差异,也省掉一路高频 JPEG。

RPC 侧新增 `server/api/rpc/extension.ts`:`ext_status` / `ext_pair_token` / `ext_set_mode` / `ext_tabs` / `ext_grant` / `ext_revoke`,注册进 `api/rpc/router.ts:44-51`。

---

## 7. 分期实施

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P0 MVP** | 扩展骨架(manifest + SW + WS 连接 + 配对)、`browser-bridge.ts`、`/ws/ext` 通道、native 后端(snapshot/click/type/open/close/screenshot/navigate)、`browser-tools` auto 路由 | AI 能在真机浏览器上开标签、点元素、输入、截图;断连自动回退 |
| **P1 完整** | popup(状态/暂停/标签授权)、前端状态条与标签列表、press/scroll/wait/eval、审计日志、保活与重连打磨 | 用户可管控的完整闭环 |
| **P2 打磨** | Edge 兼容、iframe / shadow DOM、`browser_tabs` 等新工具、可选的录制回放 | 体验与覆盖面 |

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| MV3 SW 休眠断连 | 心跳 + alarms 重连;必要时 offscreen document |
| `chrome.debugger` 黄色"正在调试"横幅 | 按需 attach / 操作完 detach;popup 里可切换常驻模式 |
| 用户打开 DevTools 导致 attach 失败 | 明确报错并提示关闭 DevTools |
| 扩展需开发者模式手动加载 | 提供打包 zip + 图文引导;P2 可做 Tauri 侧一键安装 |
| 任意网页冒充扩展 | **强制配对 token + Origin 校验**(见 §4) |
| AI 误操作已登录账号 | 默认 `ai-tabs` 模式,只碰 AI 自建/用户授权的标签 |
| 快照脚本两份漂移 | 构建时从 `server/core/browser-manager.ts` 抽取 `SNAPSHOT_SCRIPT` 生成 `extension/snapshot-script.js` |

---

## 9. 需要你拍板的取舍

1. **页面操作方式**:`chrome.debugger`(CDP,能力最全、与现有实现对齐,但有黄色调试横幅)/ 纯 `chrome.scripting` 注入(无横幅,但输入是合成事件、截图受限)/ 混合按需 attach。
2. **默认标签范围**:只碰 AI 自己开的 + 用户授权的标签(安全),还是默认放开所有标签。
3. **本轮做到哪**:直接开始 P0 实现,还是先补细化设计(接口/协议定稿)再动手。

---

## 10. P0 实施记录(已完成)

已按选定取舍落地:**CDP(`chrome.debugger`)为主** + **仅 AI 自建/用户授权的标签** + **直接做 P0**。

| 层 | 文件 | 说明 |
|---|---|---|
| 桥接内核 | `server/core/browser-bridge.ts`(新增) | 配对 token、鉴权、请求应答、标签授权、状态事件 |
| 通道 | `server/core/ws.ts`、`server/index.ts`(改) | 新增第 4 个 WSS `/ws/ext`;upgrade 阶段校验 token + Origin,不通过直接销毁 socket |
| 配对接口 | `server/api/http/browser-bridge.ts`(新增) | `GET /api/browser-bridge/pair`(要求 `X-Bridge-Pair` 头)、`POST /api/browser-bridge/reset` |
| RPC | `server/api/rpc/extension.ts`(新增) | `ext_status` / `ext_tabs` / `ext_grant` / `ext_revoke` / `ext_set_mode`(刻意不暴露 token) |
| 后端抽象 | `server/agent/browser-backends.ts`(新增) | 把内置预览与真机浏览器统一成同一个 `BrowserOps` 接口 |
| 工具路由 | `server/agent/browser-tools.ts`(改) | 11 个工具默认 `auto`:扩展在线走真机,否则回退内置预览;新增 `target` / `tab_id` 参数 |
| 扩展 | `extension/`(新增) | MV3:manifest / background / cdp / page-ops / popup;安装与排错见 `extension/README.md` |

两个刻意的设计决定:

- **快照脚本由服务端下发**(`ext_welcome.snapshotScript`),而不是在扩展里再存一份 ——
  真机与内置预览永远跑同一份脚本,不会出现"改了服务端忘了改扩展"的格式漂移。
  依赖 Node 的类型剥离:运行时 `SNAPSHOT_SCRIPT.toString()` 已是合法 JS(已实测 `new Function` 可构造)。
- **配对 token 不进 RPC 通道**:现有 `/ws` 完全没有鉴权,而 WebSocket 不受同源策略限制,
  把 token 放上去等于让任意本机网页都能接管浏览器。token 只走要求自定义头的 HTTP 接口。

验证方式:两个隔离实例(PORT 4199 / 4198 + 临时 `DATA_DIR`)的自测脚本,覆盖
配对接口鉴权、`/ws/ext` 无 token/错 token 拒绝、握手与脚本下发、请求应答往返、
标签授权模型、扩展返回失败时的错误透传、断线后自动回退、工具层 `backend` 路由 —— 全部通过。

尚未做(P1):前端「真机浏览器」状态条与标签列表、操作审计日志、扩展一键安装引导。

### 10.1 扩展的分发与发布

| 事项 | 做法 |
|---|---|
| 打包 | `node scripts/build-extension.mjs` → `output/teleforge-auto-v<版本>.zip`(纯 Node 写标准 ZIP,不引第三方依赖) |
| 版本号 | `extension/manifest.json` 的 `version` 是唯一来源;CI 在 `extension-v*` tag 上校验 tag 与它一致 |
| 独立发布 | `.github/workflows/extension.yml`:打 `extension-v*` tag 或手动触发 → 打包并发布 GitHub Release |
| 随桌面端一起 | `scripts/build.mjs` 把 `extension/` 复制进 `src-tauri/resources/extension/`,安装包里自带一份;桌面 release 也附上同一个 zip |
