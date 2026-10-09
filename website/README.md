# Teleforge 官网(独立目录)

这是 Teleforge 的产品官网,单独放在 `website/`,**与桌面端打包完全无关**。

## 为什么不会被打包进桌面端

桌面端的资源打包脚本 `scripts/build.mjs` 只往 `src-tauri/resources/` 里放四样东西:

```
node/          平台对应的 Node 运行时
server/**      后端源码副本
web/dist/**    前端构建产物(vite build 的输出)
node_modules/  生产依赖(npm ci --omit=dev)
extension/**   Teleforge Auto 扩展
```

`src-tauri/tauri.conf.json` 的 `bundle.resources` 也只声明了 `resources/` 这一个来源。
`website/` 既不在打包脚本的拷贝清单里,也不在 Tauri 的资源声明里,所以:

- `npm run desktop:build` 打出的安装包里**没有**这个目录;
- 仓库根 `tsconfig.json` 的 `include` 只有 `web/src` 与 `web/vite.config.ts`,
  根 `npm run typecheck` / `npm run build` / `npm test` 都不会扫到 `website/`;
- 这个目录有自己的 `package.json` 与 `node_modules`(已在根 `.gitignore` 的 `node_modules/` 规则覆盖范围内)。

## 技术选型

- **Next.js 15 App Router + React 19**:页面默认是 Server Component,除几个动效岛之外
  全部在服务端渲染成 HTML(可以直接 `curl` 看到完整文案,关掉 JS 也能读到全部内容)。
  由于没有任何动态数据,`next build` 会把它预渲染成静态 HTML,首屏更快。
- **动效**:`motion`(`motion/react`)只在 `'use client'` 的叶子组件里使用,
  并且只动 `transform` / `opacity`;所有滚动动效都走 `useScroll` 的进度值,
  没有一处 `window.addEventListener('scroll')`。reduced-motion 下全部退化为静态。
- **样式**:手写 CSS + CSS 变量(没有引入 UI 框架),令牌集中在
  `app/globals.css` 的 `:root` / `:root[data-theme='light']` 两块里。
- **字体**:`next/font/google` 自托管 Geist 与 Geist Mono(构建时下载,不引外链);
  中文走系统字体栈(PingFang SC / 微软雅黑 / Noto Sans SC …),不额外下载 CJK 字体。
- **图标**:`@radix-ui/react-icons`,没有手写 SVG 图标路径。

## 开发 / 构建

```bash
cd website
npm install
npm run dev        # http://localhost:3100
npm run build      # 生产构建(SSR / 预渲染)
npm start          # 跑生产构建
npm run typecheck
```

## 截图

`public/shots/*.webp` 是**真实运行的应用**的截图,由 Playwright 驱动本机 Chrome 拍摄:

- 用一份独立的 `DATA_DIR` 起第二个后端实例(`:4100`),不会干扰你正在用的 `:4000`;
- 远端用项目自带的 mock SSH 服务器(`test/mock-ssh-server.js`)扮演,根目录是
  `C:\srv-mock`,所以界面里看到的工作区是 `/srv/ledger-api` 这个示例工程;
- 模型走内置的 `mock` 提供方(免 Key),这样能跑完整的一轮工具循环而不花钱;
- 截图后统一转成 WebP(`server/skills/image-toolkit/scripts/imgtool.py`)。

拍摄脚本与原始 PNG 放在 `output/playwright/`(该目录已在 `.gitignore` 里),
仓库里只保留压缩后的成品图。

| 文件 | 内容 |
| --- | --- |
| `app-overview.webp` | 主界面整屏:会话列表、对话区的工具调用、远程文件、终端 |
| `agent-chat.webp` | 对话区:一条指令引发的四个工具调用 |
| `agent-tools.webp` | 工具调用记录特写:列目录 / 读文件 / 执行命令 / 写文件 |
| `files-panel.webp` | 远程文件面板 |
| `editor.webp` | CodeMirror 6 编辑器打开远程文件 |
| `terminal.webp` | 常驻终端会话 |
| `browser-preview.webp` | 内置浏览器预览(AI 可操控) |
| `ssh-profiles.webp` | SSH 连接与已保存的服务器配置 |
| `settings.webp` | 设置面板与模型提供商 |
| `mobile.webp` | 手机宽度下的单栏布局 |
