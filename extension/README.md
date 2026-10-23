# Teleforge Auto

把**本机真实的 Chrome/Edge**(你日常那个、带登录态和 cookie 的浏览器)接入 Teleforge,
让 AI 能开标签、点元素、输入、截图,并且**一次调用跑完一整套流程**。

服务端在 `server/core/browser-bridge.ts`,工具层路由在 `server/agent/browser-backends.ts`,
快照脚本在 `server/core/browser-snapshot.ts`。设计说明见 `docs/browser-extension-bridge.md`。

当前版本 **1.1.0**(协议 v2)。与 1.0.x 的差别见文末「版本与兼容」。

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

> **改完扩展文件一定要点「重新加载」**。popup 每次打开都从磁盘读(立刻是新版),而
> service worker 是加载时的那份:不重载就会出现「新界面配旧后台」,表现是报「未知方法:batch」。

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
> 各自占 4000-4019 里的一个端口。扩展对每个服务端各持一条 WebSocket,互不影响。
>
> **多台浏览器可以同时在线**:Chrome 和 Edge 各装一份扩展时,服务端按浏览器实例各留一条连接,
> AI 用 `browser` 参数(填 `chrome` / `edge`,或工具结果里 `browsers[].id`)指定操作哪一台。
>
> popup 底部会显示当前连接的协议版本:出现 **旧服务端(建议升级)** 说明对面 Teleforge 版本太老,
> 升级后重启即可。

> token 存在 `data/browser-bridge.json`(仅本机)。要撤销某个浏览器的访问权,
> 删掉该文件后重启 Teleforge,或在 popup 里重新配对即可。
> 1.1.0 起 token 走 WebSocket 子协议(`Sec-WebSocket-Protocol: tf.<token>`)而不是 URL 查询参数,
> 不会出现在访问日志里;对面是老服务端时会自动退回旧写法。

## AI 怎么用它

扩展连着的时候,AI 的 `browser_*` 工具会**自动走真机浏览器**;扩展没连(或用户暂停了)就回退到内置预览浏览器。
工具返回值里的 `backend` 字段会说明这次操作落在哪边。

| 工具 | 说明 |
|---|---|
| `browser_open` | 新开标签并等加载完成。**默认不抢焦点**(`focus:true` 才切到前台) |
| `browser_snapshot` | 结构化快照(稳定 ref / shadow DOM / 子框架 / scope) |
| `browser_click` / `browser_type` / `browser_press` / `browser_scroll` | 通过 CDP 发**可信输入事件**,和真人操作等价 |
| `browser_batch` | **一次调用跑完整段流程**(导航/点击/输入/等待/断言/最后快照) |
| `browser_act` | 通用动作:hover / dblclick / rightClick / select / upload / dialog / console / networkIdle / text / assert |
| `browser_wait` | 轮询等待文本 / 选择器 / URL 出现 |
| `browser_screenshot` | `Page.captureScreenshot`(支持整页、可叠加 AI 光标) |
| `browser_eval` | 在页面里执行 JS |
| `browser_memory` | 记下/查看某个站点的操作经验(下次 `browser_open` 自动提示) |
| `browser_close` | 关掉该标签 |

显式控制目标:工具参数 `target` = `auto`(默认)/ `native`(强制真机)/ `preview`(强制内置预览);
`tab_id` 指定真机浏览器里的标签。

## 批处理:为什么它最重要

一步一次工具调用,意味着每一步都要一次模型往返 + 一份页面描述。5 步流程就是 5 次往返。
`browser_batch` 把整段流程压进**一次**调用,扩展在一个标签上按顺序执行:

```jsonc
// 调用一次,模型只往返一次
browser_batch({
  "steps": [
    { "op": "click", "ref": "e3f9a" },
    { "op": "type",  "selector": "#q", "text": "报销单", "submit": true },
    { "op": "wait",  "text": "搜索结果" },
    { "op": "click", "text": "导出" },
    { "op": "assert","text": "已导出" }
  ],
  "snapshot": "on_error"   // always | on_error(默认) | never
})
```

- 失败默认**就此打住**(不在错误页面上继续点),返回每一步的 ✓/✗ 和失败步号;
- `snapshot=on_error` 只在失败时附快照,成功时只回执,省 token;
- 步骤支持 `navigate/click/type/press/scroll/hover/dblclick/rightClick/select/upload/wait/networkIdle/assert/text/eval/load`。

## 快照 v2

给 AI 的不是截图也不是 HTML,而是紧凑的结构化文本:

```
页面标题:订单管理
地址:https://admin.example/orders
视口:800px 高 · 已滚动 0/2400px

页面结构(18 个节点,12 个可操作;ref 形如 e3f9a,跨快照稳定):
     -    heading "订单管理" h1
   e3f9a  button "新建订单" loc=#new-order
   e7c21  link "ORD-1024" → /orders/1024
     -    heading "最近订单" h2
   e1a09  checkbox "已开票" loc=#rows > label:nth-of-type(2)
子框架 1 「payment」:https://pay.example/
   f1:e2b31  button "确认支付"
```

要点:

- **ref 稳定**:`e3f9a` 由 `role|name|css 路径` 算短哈希,DOM 上加/删别的元素不会让整页 ref 错位;
  文案或结构大改才会变。跨轮引用同一个元素是常态,不是运气。
- **穿透 shadow DOM**:自定义元素里的按钮/输入框能读到(open shadow root)。
- **子框架**:同源与同进程的跨域 iframe 都能读,ref 带 `f1:` 前缀,点击/输入照写即可。
  跨进程(OOPIF)框架扩展读不到其 DOM,会明确标出来 —— 这种场景用 `target=preview`。
- **scope**:`viewport`(默认)/ `full_page` / `subtree`(`root` 给某个 ref 只看那一块)。
- **正文按需**:默认**不带**页面正文,要读文章/表格时传 `text: 2000`。这一条把单次快照从
  2~5k token 压到几百 token。

## 动作可靠性(可操作性检查)

每个点击/输入前都会检查:元素存在 → 可见 → 未禁用 → 滚动进视口 → **该坐标上确实是它**(遮挡检测)
→ 两次采样坐标一致(避免点在动画中途)。失败会明确说是哪一条:

- `元素被遮挡:div modal-mask` —— 有弹窗/遮罩挡住了,先关掉它;
- `没找到匹配的元素(ref=e3f9a)` —— 页面变了,重新 `browser_snapshot` 拿新 ref;
- `元素是禁用状态` / `元素在视口外(滚动没生效)`。

**输入会回读校验**:写入后读一次输入框/富文本的实际内容,不一致就用 `execCommand('insertText')`
或原生 value setter 兜底重写一次,再校验;仍不一致会明确报「输入校验失败」而不是把错误内容留在页面上。
这条是给中文输入准备的 —— 第一次输入被 IME/渲染吞掉、第二次才对的情况,现在一次就能写对。

## 不抢焦点,不打断你

- AI 新开的标签默认**后台打开**,不会把你正在看的页面顶掉;`focus:true` 才切前台。
- 后台标签收不到键盘事件 —— 扩展会开 `Emulation.setFocusEmulationEnabled` 让页面以为自己在前台,
  输入照样能进。
- 工具栏图标上的红色角标 = 当前被 AI 控制的标签数。
- 你在同一个标签里的手动操作仍会干扰 AI(同一个页面),其它标签完全不受影响。

## 站点经验(`browser_memory`)

同一个后台每次都要重新摸索一遍很浪费。让 AI 把验证过的事实记下来:

```
browser_memory({ action: "save", note: "导出按钮在右上角「⋯」菜单里", selector: "#toolbar > button:nth-of-type(3)" })
```

下次 `browser_open` 打开该域名时,这些经验会作为提示附在结果后面(最多 3 条)。
它只是提示,不会自动重放 —— 选择器会过期,照搬比重找更危险。

## 审计与域名策略

- 所有会改变页面的工具调用都会写一条审计:`data/browser-audit.log`(JSONL)。
  只记工具名、目标(ref/选择器)、URL、标签 id、结果与耗时;**输入的具体文本从不落盘**,只记长度。
  超过 2MB 自动轮转一份 `.1`。
- 域名白/黑名单存在 `data/browser-bridge.json`,RPC `ext_domains` 读写:
  - `allowed` 非空 = 只允许这些域;`blocked` 永远优先;
  - 支持 `*.example.com`,同域的任意端口都算。
- 默认模式 `ai-tabs`:AI 只能操作它自己新开的标签 + 用户显式授权的标签。

## 权限模型(默认只碰"该碰的")

默认模式 `ai-tabs`:**AI 只能操作它自己新开的标签,以及用户显式授权的标签**。
你浏览器里那些已经登录的标签,AI 是动不了的 —— 尝试操作会拿到一条明确的拒绝说明。

AI 开过的标签会**记住**,不会被"换一条 socket"或"服务端重启"抹掉:

- `browser_open` 开标签时,服务端在**执行这条指令的那条连接**上原子标记为 AI 自建
  (不会因为标签清单还没刷新、或同时开着 Chrome + Edge 而标错浏览器);
- 标记写入 `data/browser-bridge.json` 的 `auth.<浏览器实例>` 里,服务端重启/扩展重连后自动恢复;
- **AI 标签里点开的子标签**(链接 `target=_blank`、`window.open`)按 `openerTabId` 自动归给 AI,
  不会出现"AI 点开一个详情页,下一步读它就说没授权";
- 用户自己的标签里点开的标签不会被顺带授权。

> 升级前就已经开着的标签不会被追溯授权(那时还没有落盘记录):在面板里「交给 AI」一次,或让 AI 重新 `browser_open` 即可。

要放开:在 Teleforge 侧把模式切到 `all`(RPC `ext_set_mode`),或在面板里把某个标签「交给 AI」(RPC `ext_grant`)。

## 会不会影响我自己在用的标签?

调试器是**按标签**挂的(`chrome.debugger.attach({tabId})`),所以两边基本互不干扰:

| 情形 | 结果 |
|---|---|
| 你手动操作**其它**标签 | 完全不受影响:那些标签没有被 attach |
| 你切标签、开关别的标签 | **不影响 AI**:会话绑定在它自己开的标签上 |
| 你手动操作 **AI 那个标签** | 会互相影响 —— 同一个页面 |
| 你在 AI 那个标签上开 DevTools | 调试器被 DevTools 抢走,AI 那一步会明确报错 |
| 你关掉 AI 那个标签 | AI 收到"没有可操作的标签/没有授权",**不会**转头去动你的标签 |
| 另一个对话 | 各自绑定各自的标签;同一标签上的指令串行执行,不会交叉 |

## 关于那条黄色横幅

用 `chrome.debugger` 操作页面时,Chrome 会在该标签顶部显示「**正在调试此浏览器**」。
这是浏览器强制的,任何扩展都隐藏不了(能隐藏就等于能偷偷读你的页面了)。

- 只影响**被 AI 操作过的那些标签**;
- popup 里的 **停止调试(去掉黄条)** 会立刻断开所有调试器(角标同时清零);
- 断开连接或关闭标签也会自动摘掉。

## 排错

| 现象 | 原因与处理 |
|---|---|
| popup 提示连不上服务端 | Teleforge 没跑,或端口填错;点「扫描全部」 |
| 桌面端 / 网页端只有一边能用 | 旧版扩展只连一个服务端;升级到 1.0.2+ 后点「扫描全部」 |
| Chrome 和 Edge 都装了,状态点一直闪 | 旧版扩展没上报实例 id;升级到 1.0.3+ |
| 报「未知方法:batch / act」 | 扩展还是 1.0.x:去 `chrome://extensions` 点「重新加载」,或换 1.1.0 |
| 报「需要浏览器扩展 1.1.0+(协议 v2)」 | 同上,服务端已经升级但扩展没更新 |
| popup 显示「旧服务端(建议升级)」 | 反过来:扩展是新的,Teleforge 太老 |
| 「该标签已被开发者工具占用」 | 关掉该标签的 DevTools 后重试 |
| 「元素被遮挡:div …」 | 有弹窗/遮罩;先 click 掉它,或加 `wait` 步骤 |
| 「没找到匹配的元素(ref=…)」 | 页面重渲染了,重新 `browser_snapshot` |
| 「子框架 f1(…)是跨进程框架」 | OOPIF 扩展读不到;用 `target=preview` 操作该框架 |
| 改了扩展文件后行为没变 | service worker 是加载时那份:点「重新加载」,必要时完全退出浏览器 |
| 配对接口返回 403 | 服务端版本太旧(不含浏览器桥接),升级后重启 |
| 提示 token 不匹配 | 服务端换过 token;popup 里「断开」后重新「连接」 |
| 点击没反应 | 先 `browser_act(console)` 看有没有 JS 报错;元素可能被遮挡或在跨进程框架里 |
| 状态点一直黄(连接中) | 服务端在重启;等几秒或点一次「断开」→「重连」 |

## 目录结构

```
extension/
  manifest.json     MV3 清单(权限:tabs / debugger / storage / alarms / scripting)
  background.js     service worker:多服务端 WS、保活重连、指令分发、每标签串行队列、角标
  cdp.js            chrome.debugger 封装(attach / detach / sendCommand / 事件订阅 / 焦点模拟)
  page-ops.js       快照编排 / 可操作性检查 / 交互 / 批处理 / console·网络·弹窗
  popup.html/js     服务端列表与连接状态、协议版本、暂停开关、停止调试
```

快照脚本**不在**这里 —— 它由服务端在握手时下发(`ext_welcome.snapshotScriptSrc`),
保证真机浏览器与内置预览永远跑同一份脚本,不会出现两边格式漂移。

## 版本与兼容

| | 行为 |
|---|---|
| 扩展 1.1.0 + 服务端 0.4+ | 全部能力(batch / snapshot v2 / act / 子协议 token) |
| 扩展 1.1.0 + 老服务端 | 自动退回 `?token=` 与 v1 快照(batch/act 用不了,因为对面不下发) |
| 扩展 1.0.x + 新服务端 | 快照仍是 v1;`browser_batch` / `browser_act` 会明确报「需要扩展 1.1.0+」 |
