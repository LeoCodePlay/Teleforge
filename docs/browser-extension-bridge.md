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

### 3.6 多服务端(每服务端一条 WebSocket)

一台机器上常常同时跑着桌面端和开发用的网页端(`npm run dev`),各自占 `4000-4019` 里的一个端口,
`data/browser-bridge.json` 里的配对 token 也是各自的。扩展因此**对每个服务端各持一条 WS**
(`background.js` 的 `conns` 表),而不是只连一个:

- 只连一个时,后连的会顶掉先连的 —— 表现就是"连上网页端后桌面端再也用不了";
- `ext_result` 只发回发起该 `ext_call` 的那条连接(每个服务端有各自的 `snapshotScript`,按连接保存);
- `ext_event`(`tabs_changed`)与暂停开关是浏览器全局的,广播给所有连接。

配对响应里多带一个 `kind`(`desktop` / `web`,由 `TELEFORGE_SHELL=desktop` 环境变量判定),
扩展 popup 只用它把列表里的每一项标成「桌面端」还是「网页端」,不参与任何连接逻辑。

### 3.7 多浏览器(每浏览器一条 WebSocket,服务端侧按实例 id 分表)

上面那节说的是**扩展连多个服务端**;这里说的是**服务端接多个浏览器**。
同一台机器上 Chrome 和 Edge 各装一份扩展(同一个目录、同一个扩展 id,所以扩展 id 区分不了),
两边都会扫到同一批服务端,于是同一个服务端会收到两条 `/ws/ext`。

- 扩展在 `ext_hello` 里上报 `instanceId`(首次运行生成一次,写进 `chrome.storage.local`)。
  服务端用它区分「同一台浏览器重连(替换旧连接)」与「另一台浏览器(各占一条连接)」——
  没有这个字段就没法区分,只能像旧版那样"新连接顶掉旧的"(见 4.3)。
- 每条连接**各自**持有标签清单、标签授权(ai/granted)、操作模式。tabId 在不同浏览器之间会重复
  (两边都从 1 开始编号),合并成一份授权表会串台,所以一律按连接隔离。
- 工具层用 `browser` 参数(内核名 `chrome`/`edge`,或连接 id)指定操作哪一台;不传就用
  「本对话绑定的那台 → 默认目标那台」。会话绑定记的是 (实例, tabId) 组合,切浏览器时不会错用另一台的 tabId。
- `browser_id` 的 native 形式因此扩成 `native:<实例>:tab:<tabId>`(旧格式 `native:tab:<n>` 仍能解析)。

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

**会话级标签绑定(用户手动操作不受干扰的前提)**

`resolveOps()` 每次工具调用都新建一个 ops,闭包里的 `cur` 只在这一次调用内有效 —— 所以
"没传 `tab_id`"时如果没有别的依据,就只能回落到**当前活动标签**,也就是用户此刻正在看的那个:
用户随手切一下标签,AI 下一步就可能对着别的标签快照/点击(默认 `ai-tabs` 下被 `canOperate`
拒掉变成一步失败,`all` 模式下更会真的操作错标签)。

因此 `browser_open` 打开标签后会把它记到**发起它的会话**上(`browser-backends.ts` 的
`sessionTabs`),之后该会话所有不带 `tab_id` 的 `browser_*` 都作用于这个标签;标签被关掉
(或扩展重连后清单里没了)时绑定自动失效,回落到旧的"活动标签 + 授权校验",不会拿死 tabId 去撞。
显式传 `tab_id` 始终优先。回归测试见 `test/browser-native-tab-binding.test.js`。

**互不干扰的边界(必须让用户知道)**

- 调试器是 per-tab 的:只有 AI 碰过的标签会被 attach(顶部黄条),用户其它标签完全不受影响;
- 反过来,用户在同一标签里的手动操作、以及打开 DevTools,都会影响 AI 那一步(同一个页面 / 调试器被抢);
- 同一浏览器 profile 的 cookie 与登录态是共享的,AI 的登录/登出会影响用户其它标签 —— 这是浏览器层面的行为,无法隔离;
- `browser_open` 会新开前台标签并抢一次焦点(标签本来就是给用户看的)。

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

---

## 11. v2 实现记录(协议 v2 / 扩展 1.1.0)

这一轮把「快、稳、不打扰、可管控」四件事补上。**服务端与扩展同版本发布**,
协议版本在 `ext_hello.protocol` / `ext_welcome.protocol` 里协商,不匹配时按下面的兼容表降级。

### 11.1 快照 v2(`server/core/browser-snapshot.ts`)

| 变化 | 为什么 |
|---|---|
| ref 从 `e1..eN` 改为 `role|name|css` 的短哈希(`e3f9a`) | v1 按出现顺序编号,页面上多一个元素后面全错位;模型跨轮拿着旧 ref 就是随机点错 |
| 输出 `loc=`(id 优先的 CSS 路径) | ref 失效时的稳定兜底,也是"站点经验"能沉淀的基础 |
| 递归 open shadow root | v1 只扫 `document`,自定义元素/设计系统里的按钮完全读不到 |
| 子框架逐个抓,ref 加 `fN:` 前缀 | 后台系统大量用 iframe;跨进程(OOPIF)读不到的会明确标注,不假装成功 |
| 默认不带正文,`text:` 按需 | v1 每次塞 2000 字正文,单份快照 2~5k token,而模型多数时候只关心按钮 |
| `scope: viewport/full_page/subtree` | 长页面一次全抓又贵又吵 |
| 按标题层级缩进 | 平铺列表看不出"这个「保存」属于哪个区块" |

文本渲染仍在服务端(`formatSnapshot`),扩展只回原始 JSON —— 真机与预览逐字一致,
老扩展回 v1 数据也能渲染(向后兼容分支)。

### 11.2 可操作性检查(`extension/page-ops.js`)

点击/输入前:存在 → 可见 → 未禁用 → `scrollIntoView` → rect 非零 → `elementFromPoint` 命中检测
(穿 shadow 边界:命中宿主算命中影子内容)→ 60ms 后复核坐标,防点在动画中途。
失败会带上"被谁遮挡/为什么不可见",而不是让模型猜"点了没反应"。

### 11.3 批处理(`browser_batch`)

- 真机:一条 `batch` 指令,扩展在同一个标签上顺序执行;每标签有串行队列,和单步调用不会交叉。
- 预览:服务端循环(`browserManager.batch`),省掉的是**模型往返**而不是 IPC 往返。
- 失败默认停在该步(`stopOnError`),`snapshot=on_error/always/never` 控制是否附最终快照。
- 支持 `click/type/press/scroll/navigate/wait/hover/dblclick/rightClick/select/upload/networkIdle/assert/text/eval/load`。

### 11.4 不抢焦点

`tabs.open` 改为 `active: p.active === true`(默认后台);工具层 `browser_open` 的 `focus` 默认 `false`。
后台标签收不到键盘事件 → attach 时开 `Emulation.setFocusEmulationEnabled`,并用
`Page.setWebLifecycleState('active')` 防冻结。工具栏角标显示当前被控制的标签数。

### 11.5 事件采集与动作原语

`cdp.js` 加了事件订阅表(chrome.debugger.onEvent → 每标签监听器),据此实现:
弹窗自动处置(`Page.javascriptDialogOpening`)、console/异常缓冲(Runtime,按需开)、
网络 in-flight 计数(Network,按需开)。`browser_act` 暴露 hover/dblclick/rightClick/select/upload/
dialog/console/networkIdle/text/assert;`upload` 走 `DOM.setFileInputFiles`(真机)与 `setInputFiles`(预览)。

### 11.6 回执与视觉反馈

`browser_click` / `browser_type` 默认只回「结果 + 当前 url/title」,不再每步附全量快照
(要看就显式 `snapshot:true` 或单独 `browser_snapshot`)。动作会在页面里画一个 AI 光标 +
目标高亮 + 动作说明(1.2s 自动消失),截图可叠加。

### 11.7 站点经验(`server/core/browser-memory.ts`)

`data/browser-learnings.json` 按域名存最多 12 条短笔记;`browser_memory` 工具 save/list/forget,
`browser_open` 结果里自动附最多 3 条提示。只提示不重放:选择器会过期,照搬比重新找更危险。

### 11.8 安全

| 项 | 做法 |
|---|---|
| token 传输 | 优先 `Sec-WebSocket-Protocol: tf.<token>`(不进 URL);服务端 `handleProtocols` 回选;老服务端自动退回 `?token=` |
| 域名策略 | `browser-bridge.json` 里的 `allowedDomains` / `blockedDomains`;`canOperate` 在授权检查之后再过一遍,按域名而不是按标签(切标签绕不过去) |
| 审计 | `data/browser-audit.log`(JSONL,2MB 轮转);只记工具/目标/URL/结果/耗时,**输入文本只记长度** |
| RPC | `ext_domains`(读/写)、`ext_audit`(最近 N 条),仍不暴露 token |

### 11.9 保活:为什么没有引入 offscreen document

MV3 的 service worker 默认约 30s 空闲被回收,但 Chrome 116+ 起**WebSocket 有收发就会重置空闲计时器**
(manifest 的 `minimum_chrome_version` 正是 116),服务端 20s 一次的 `ext_ping` 足以维持常驻;
再加 `chrome.alarms` 30s 兜底与指数退避重连,实测没有"跑一会儿就断"的问题。

曾评估用 offscreen document 持有 WS(官方推荐做法之一),但:
- offscreen 需要 `AUDIO_PLAYBACK` 之类的长寿 reason(静音音频循环)才不会被自己回收,属于 hack;
- WS 挪进 offscreen 后,所有指令要经 `chrome.runtime.sendMessage` 中转一层,popup 与 SW 的状态同步变复杂;
- 现有方案的失败面(握手被拒、服务端重启)已经有明确的重连与提示。

因此这一轮没有引入 offscreen,而是把**重连路径**做扎实:子协议握手失败自动退回 `?token=`、
协议版本协商(旧服务端只下发 v1 快照也能跑)、`snapshotScriptSrc` 与连接一起清理避免用旧脚本。

### 11.10 测试

| 用例 | 覆盖 |
|---|---|
| `test/browser-snapshot.test.js` | 快照脚本:稳定 ref、shadow DOM、scope、按需正文、v1 渲染兼容(真 Chromium) |
| `test/browser-extension-ops.test.js` | **扩展 page-ops 本体**:把 `chrome.debugger.sendCommand` 接到 Playwright CDP,验证快照/遮挡/点击/输入/批处理/子框架(fN:) |
| `test/browser-preview-v2.test.js` | 预览后端:跨域 iframe 内点击、批处理、console、截图 |
| `test/browser-bridge-v2.test.js` | 协议:子协议 token、welcome 下发 v2 脚本、batch 单条指令、域名拒绝、审计 |
| `test/browser-native-tab-binding.test.js` | 既有:会话标签绑定不被用户切标签带偏 |

运行:`npm run test:browser`(没有可用 Chrome 的用例会自动跳过并算通过)。

### 11.11 第三条后端:ego(lite)

`target=ego` 用官方 `ego-browser nodejs` CLI 驱动 ego(lite)(App 把原生绑定注入子进程,
外部进程拿不到,只能走 CLI)。实现要点:

- 一个动作一次 CLI 调用,一个 `browser_batch` 一次进程跑完(ego Space 名按会话固定,跨调用续用);
- ego 的 `@N` 只在产生它的进程内有效 → 快照行里的 `loc=` 做短哈希成本端 ref(`e3f1a`),
  下次调用翻译回 `loc=...` 执行;`unstable/ambiguous` 的元素明确报错而不是瞎点;
- 脚本从 stdin 投递(绕开 Windows 引号/编码),结果用 `__TF__{json}` 标记回传;
- 未安装/App 没跑/版本过旧都有可操作的中文提示。

详见 `docs/ego-integration.md`,回归见 `test/ego-backend.test.js`(用假 CLI 覆盖全链路,不需要真装 ego)。

### 11.12 标签授权:从"内存里记一下"到"原子标记 + 落盘 + 继承"

用户报的现象:AI 用扩展开的标签,过一会儿读页面却提示「没有授权给 AI」。原因有三层,都修了:

| 漏洞 | 修法 |
|---|---|
| `markAiTab` 用 tabId **反查连接**:标签清单有 200ms 去抖、或同时开着 Chrome+Edge 时会标到错的那台上 | 新增 `BrowserBridge.openTab()`:在**执行 tabs.open 的那条连接**上直接标记,不再反查 |
| AI 自建标签只存在内存 (`conn.aiTabs`),服务端重启/进程重启就丢 | 授权按浏览器实例落盘到 `browser-bridge.json` 的 `auth` 字段;`finishHello` 在内存没有记录时从磁盘恢复。落盘是**合并写**,不会把别的实例的历史授权覆盖掉 |
| AI 标签里点开的新标签(链接 `target=_blank` / `window.open`)从来没被标记过 | 扩展在 `tabs.list` 里带上 `openerTabId`;服务端刷新清单时把"AI/已授权标签的子标签"传递性地归给 AI(多级弹窗也覆盖) |

安全边界没有放松:用户自己的标签、以及用户标签里点开的子标签,依然不算授权;
只有"AI 开的"和"用户显式交给 AI 的"才会传播。`revoke` 会同时清掉自建与授权标记并落盘。

回归:`test/browser-tab-permission.test.js`(13 项)覆盖 —— 开完立刻可读、写盘、换 socket 重连、
模拟服务端重启后从磁盘恢复、opener 子标签继承、用户子标签不误授权、多浏览器标记不串台。
