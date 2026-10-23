# 接入 ego(lite) 浏览器

Teleforge 原本有两条浏览器后端:内置预览(Playwright)和真机扩展(本机 Chrome/Edge)。
现在加了第三条:**ego(lite)** —— 用 `target=ego` 显式选择。

## 为什么是"调 CLI"而不是"直连 CDP"

ego(lite) 的调试通道是 App 注入到 `ego-browser` 子进程里的 `globalThis.ego` 原生绑定,
外部进程拿不到这个绑定;官方给 Agent 的接入方式就是:

```
ego-browser nodejs   # 从 stdin 读一段 JS,helper 已预注入
```

所以这里沿用官方姿势:

- **一个动作 = 一次 `ego-browser nodejs` 调用**(脚本从 stdin 喂,避开 Windows 引号/编码问题);
- **一个批处理 = 一次调用里跑完整段流程**(和 ego 自己的设计一致,一次进程、一次往返);
- 脚本用 `console.log('__TF__' + JSON.stringify(...))` 回结构化结果,服务端只认这个标记;
- ego 的 Space 名按 Teleforge 会话固定(`teleforge-<sid>`),所以多次调用天然接着用同一个工作区/标签页。

## 前置条件

1. 安装 ego(lite):https://lite.ego.app/ ,完成首次引导(onboarding 会把 `ego-browser` 注册到 PATH);
2. ego lite App 正在运行;
3. 新开一个终端确认 `ego-browser` 可用(Windows 上 PATH 只对新进程生效)。

自检:

```bash
ego-browser nodejs -e "console.log('ok')"
```

找不到命令时可以用环境变量指定:

```
EGO_BROWSER_BIN=C:\Users\me\AppData\Local\ego\ego-browser.exe
# 也可以指向一个 .js/.mjs(测试替身或自定义入口)
```

## 怎么用

```jsonc
// 打开
{ "tool": "browser_open", "args": { "url": "https://admin.example/orders", "target": "ego" } }

// 快照(拿到 ref)
{ "tool": "browser_snapshot", "args": { "target": "ego", "scope": "full_page" } }

// 点 + 输入(一次跑完)
{ "tool": "browser_batch", "args": {
  "target": "ego",
  "steps": [
    { "op": "click", "ref": "e3f1a" },
    { "op": "fill", "selector": "#q", "text": "报销单" },
    { "op": "wait", "text": "搜索结果" },
    { "op": "assert", "text": "搜索结果" }
  ],
  "snapshot": "on_error"
}}
```

其余工具(`browser_click` / `browser_type` / `browser_press` / `browser_scroll` / `browser_wait` /
`browser_screenshot` / `browser_eval` / `browser_close` / `browser_act`)全部支持 `target=ego`,
参数与另外两个后端一致。

## ref 怎么跨调用生效(关键设计)

ego 的 `@N` **只对产生它的那个进程里的 refMap 有效**,而每次工具调用都是新进程 —— 直接用 `@N`
跨调用会报 "Unknown ref"。做法:

1. 快照行里本来带 `loc=`(ego 给的稳定选择器),例如
   `button "提交" [ref=7, loc=css:#submit]`;
2. 我们把 `loc` 做短哈希,换成本端 ref(`e3f1a`),并把 `e3f1a → loc=css:#submit` 存进会话级映射;
3. 下一次调用传 `ref=e3f1a`,服务端翻译回 `loc=css:#submit` 交给 ego 执行。

因此:

- **同一个元素,loc 不变 → ref 就不变**,跨轮引用是稳的;
- ego 标记为 `loc=unstable` / `loc=ambiguous` 的元素**没有**跨调用 ref(快照里只给提示),
  点它时会明确报错,让你改用 `selector` 或 `text`;
- 也接受直接传 ego 原生写法:`@7`、`loc=css:#x`、`#x`、`text=提交`。

## 能力对照

| 能力 | native(扩展) | preview(Playwright) | ego(lite) |
|---|---|---|---|
| 复用用户登录态 | 原生浏览器 | 否(独立 profile) | 是(ego 里导入的 Chrome 数据) |
| 隔离工作区 | 标签级 | 独立 context | **Space(独立 BrowserContext)** |
| 跨域 iframe | 同进程可读,OOPIF 不行 | 支持 | 支持(ego 内核级快照) |
| 快照格式 | Teleforge v2 | Teleforge v2 | ego 语义快照(经本端 ref 重写) |
| 批处理 | 一条 WS 指令 | 本机循环 | **一个 Node 进程跑完** |
| 单动作延迟 | 低(CDP) | 低 | 中(每次起 Node 进程 + 连 App) |
| 右键 / console 历史 | 支持 | 支持 | 不支持(ego Page API 未暴露) |
| 需要额外安装 | 扩展 | 无 | ego lite App |

> 结论:**多步流程用 ego 很划算;零散单步操作用 native/preview 更快。**

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| `没有找到 ego-browser 命令` | 没装 ego lite,或 onboarding 没做完,或 PATH 只在旧终端生效(重开终端) |
| `无法连接 ego lite` | App 没在运行;或 `ego-browser` 是旧版,跑 `ego-browser upgrade` |
| `ego-browser 版本过旧(API=legacy)` | 装的是老版本(只有 `useOrCreateTaskSpace`):升级 ego lite |
| `没有可跨调用的稳定定位` | 该元素 ego 标了 unstable/ambiguous:改用 selector / text |
| 任务卡在"用户接管" | ego 检测到你在 Space 里手动操作:处理完再让 AI 继续 |
| 想看生成的脚本 | `TELEFORGE_EGO_DEBUG=1` 会把脚本打到服务端 stderr |

## 测试

`node test/ego-backend.test.js` 用 `test/fixtures/fake-ego.mjs` 模拟 `ego-browser nodejs` 的契约
(读 stdin 执行脚本、维护 Space/页面状态),覆盖:CLI 发现与探测、`__TF__` 解析、快照 ref→loc
跨调用映射、批处理、unstable 元素报错、工具层 `target=ego` 路由、未安装时的降级提示。

它不需要真的装 ego lite,所以能进 CI。
