# Teleforge Auto

把**本机真实的 Chrome/Edge**(你日常那个、带登录态和 cookie 的浏览器)接入 Teleforge,
让 AI 能直接开标签、关标签、点元素、输入、截图。

服务端在 `server/core/browser-bridge.ts`,工具层路由在 `server/agent/browser-backends.ts`。
设计说明见 `docs/browser-extension-bridge.md`。

---

## 下载

两种拿法,内容完全一样:

- **从 GitHub Releases 下载**:在 [Releases](https://github.com/LeoCodePlay/Teleforge/releases) 里找
  `teleforge-auto-v<版本>.zip`,解压到任意固定目录(扩展加载的是这个目录本身,别放临时目录);
- **用桌面端自带的一份**:Teleforge 安装目录里的 `extension/`(与 zip 同一份文件)。

## 加载(开发者模式,一次性)

1. 打开 `chrome://extensions`(Edge 是 `edge://extensions`)。
2. 右上角打开 **开发者模式**。
3. 点 **加载已解压的扩展程序**,选择本目录(仓库根的 `extension/`)。
4. 扩展出现在列表里,可以固定到工具栏。

## 配对并连接

1. 确认 Teleforge 正在运行(`npm run dev` / 桌面端打开均可)。
2. 点扩展图标打开 popup。
3. 点 **扫描全部**(地址留空即可)。
   - 扩展会并行扫 `127.0.0.1:4000-4019`,把**所有**在跑的 Teleforge 都找出来(网页端和桌面端
     各连各的,互不顶替),再各自向 `/api/browser-bridge/pair` 取一份配对 token,
     然后连上对应的 `/ws/ext`。
   - 状态点点亮 = 已连接;列表里每个服务端后面标着它是 `桌面端` 还是 `网页端`。
4. 知道端口就直接填:**只填端口号即可**(例如 `4011`),点 **连接**。
5. 之后每次浏览器启动,扩展会自动重连所有已配对的服务端(断线按 1s→30s 指数退避)。

> **可以同时连多个服务端**:桌面端和开发用的网页端(`npm run dev`)常同时在一台机器上跑,
> 各自占 4000-4019 里的一个端口。扩展对每个服务端各持一条 WebSocket,互不影响 ——
> 连上网页端不会把桌面端挤掉,两边都能用 AI 控制浏览器。
>
> **多台浏览器可以同时在线**(扩展 v1.0.3 起):同一台机器上 Chrome 和 Edge 各装一份扩展时,
> 服务端按浏览器实例各留一条连接,不会再互相顶掉。AI 用 `browser` 参数(填 `chrome` / `edge`,
> 或工具结果里 `browsers[].id`)指定操作哪一台;不填就是本对话已绑定的那台,其次默认目标那台。
>
> **为什么是"扫描"而不是固定端口**:安装版桌面端启动时会在 `127.0.0.1:4000-4019`
> 里挑一个空闲端口(`src-tauri/src/backend.rs` 的 `PORT_RANGE_*`),避免和开发用的
> 4000 端口打架。扩展必须能自己找出来,否则用户根本无从知道该填什么。
> 两边这个区间必须保持一致 —— 改一边要同步改另一边。

> token 存在 `data/browser-bridge.json`(仅本机)。要撤销某个浏览器的访问权,
> 删掉该文件后重启 Teleforge,或在 popup 里重新配对即可。

## AI 怎么用它

扩展连着的时候,AI 的 `browser_*` 工具会**自动走真机浏览器**;扩展没连(或用户暂停了)就回退到内置预览浏览器。
工具返回值里的 `backend` 字段会说明这次操作落在哪边。

| 工具 | 真机浏览器里的行为 |
|---|---|
| `browser_open` | 新开一个标签并等加载完成 |
| `browser_snapshot` | 用与内置预览**同一份**脚本抓结构化快照(带 `e[n]` ref) |
| `browser_navigate` | 导航当前正在操作的那个标签(不会越开越多) |
| `browser_click` / `browser_type` / `browser_press` / `browser_scroll` | 通过 CDP 发**可信输入事件**,和真人操作等价 |
| `browser_wait` | 轮询等待文本 / 选择器 / URL 出现 |
| `browser_screenshot` | `Page.captureScreenshot`(支持整页) |
| `browser_eval` | 在页面里执行 JS |
| `browser_close` | 关掉该标签 |

显式控制目标:工具参数 `target` = `auto`(默认)/ `native`(强制真机)/ `preview`(强制内置预览);
`tab_id` 指定真机浏览器里的标签。

## 权限模型(默认只碰"该碰的")

默认模式 `ai-tabs`:**AI 只能操作它自己新开的标签,以及用户显式授权的标签**。
你浏览器里那些已经登录的标签,AI 是动不了的 —— 尝试操作会拿到一条明确的拒绝说明。

要放开:在 Teleforge 侧把模式切到 `all`(RPC `ext_set_mode`),或在面板里把某个标签「交给 AI」(RPC `ext_grant`)。

## 会不会影响我自己在用的标签?

调试器是**按标签**挂的(`chrome.debugger.attach({tabId})`),所以两边基本互不干扰:

| 情形 | 结果 |
|---|---|
| 你手动操作**其它**标签 | 完全不受影响:那些标签没有被 attach,点击/输入/导航都不经过扩展 |
| 你切标签、开关别的标签 | **不影响 AI**:一个对话在 `browser_open` 之后固定操控它开的那个标签(会话级绑定),不会跟着你的活动标签跑 |
| 你手动操作 **AI 那个标签** | 会互相影响 —— 同一个页面,你在改它 AI 也在改它 |
| 你在 AI 那个标签上开 DevTools | 调试器被 DevTools 抢走,AI 那一步会明确报错;关掉 DevTools 重试即可 |
| 你关掉 AI 那个标签 | AI 会收到"没有可操作的标签/没有授权"的明确说明,**不会**转头去动你的标签 |
| AI 新开标签 | 浏览器会切到那个标签并抢一次焦点(标签是给用户看的);同一站点已登录的 cookie 是共享的 |
| 另一个对话 | 各自绑定各自的标签;没绑定过的对话回落到活动标签时,会被上面的授权模型挡住 |

> 会话级绑定只在**服务端内存**里(见 `server/agent/browser-backends.ts` 的 `sessionNativeTab`):
> 标签被关掉或扩展重连后清单里没了,绑定自动失效,不会拿着死 tabId 继续撞。


## 关于那条黄色横幅

用 `chrome.debugger` 操作页面时,Chrome 会在该标签顶部显示「**正在调试此浏览器**」。
这是浏览器强制的,任何扩展都隐藏不了(能隐藏的话就等于能偷偷读你的页面了)。

- 只影响**被 AI 操作过的那些标签**,其他标签不受影响;
- popup 里的 **停止调试(去掉黄条)** 会立刻断开所有调试器;
- 断开连接或关闭标签也会自动摘掉。

## 排错

| 现象 | 原因与处理 |
|---|---|
| popup 提示连不上服务端 | Teleforge 没跑,或端口填错;桌面端的端口在它自己的日志里,也可以直接点「扫描全部」 |
| 桌面端 / 网页端只有一边能用 | 旧版扩展只连一个服务端(后连的顶掉先连的);升级到 v1.0.2 后点「扫描全部」会全部连上 |
| Chrome 和 Edge 都装了,状态点一直闪(连上又断开) | 旧版扩展没上报实例 id,服务端只能保留一条扩展连接,两个浏览器按 1s 的重连节奏互相顶掉;升级到 v1.0.3 后重新加载扩展即可同时在线 |
| 改了扩展文件后行为没变(报「未知消息:xxx」、还是旧按钮文案) | popup 每次打开都从磁盘读(是新版),而 **service worker 是加载时的那份**(MV3 常驻,改文件不会自动生效)—— 于是出现"新界面配旧后台"。到 `edge://extensions` / `chrome://extensions` 点 **重新加载**(必要时完全退出浏览器再开) |
| 配对接口返回 403 | 服务端版本太旧(不含浏览器桥接),升级后重启 |
| 提示 token 不匹配 | 服务端换过 token(删过 `data/browser-bridge.json`);在 popup 里「断开」后重新「连接」 |
| 「该标签已被开发者工具占用」 | 该标签开着 DevTools;关掉后重试 |
| 「无法调试标签 N」 | 标签已关闭,或 `chrome://` 等受保护页面(浏览器不允许调试) |
| 点击没反应 | 元素被遮挡或在 iframe 里;先 `browser_snapshot` 确认 ref,必要时改用 `selector` |
| 状态点一直黄(连接中) | 服务端在重启;等几秒或点一次「断开」→「重连」 |

## 目录结构

```
extension/
  manifest.json    MV3 清单(权限:tabs / debugger / storage / alarms / scripting)
  background.js    service worker:每个服务端一条 WS、保活重连、指令分发、标签变化上报
  cdp.js           chrome.debugger 封装(attach / detach / sendCommand)
  page-ops.js      页面操作(snapshot / click / type / press / scroll / wait / screenshot)
  popup.html/js    服务端列表与连接状态、按端口连接、暂停开关、停止调试
```

快照脚本**不在**这里 —— 它由服务端在握手时下发(`ext_welcome.snapshotScript`),
保证真机浏览器与内置预览永远跑同一份脚本,不会出现两边格式漂移。
