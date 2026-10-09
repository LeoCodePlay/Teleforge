# Teleforge 图标规范 · 工作区 + 顶部导航

> 本次重新设计的范围:**远程工作区 / 本地工作区**(含「不绑目录」与下拉项)+ **顶部三枚固定标签:AI 编程助手 / 终端 / 自动化任务**(顺带把同一条标签条上的「浏览器预览」也换成 SVG,免得一条标签条 emoji 与 SVG 混排)。
>
> 后续按同一套规范补充的设计:**对话统计胶囊**(轮/步 + 解码速度、token 用量)、**SSH 连接列表的「编辑」**、**SSH 表单的「返回」**、**文件编辑器右键菜单**(撤销 / 重做 / 剪切 / 全选 / 保存)、**终端列表的本机 / 远端归属标记**、**目录浏览弹窗的快捷入口与文件行**、**顶部标签条右键菜单**(置顶 / 关闭当前 / 关闭其它 / 关闭全部)。

## 1. 为什么要重做

- 原来这些位置用的是 emoji(📂 🖥 🌐 💬 ⌨️ 🕘):字形随系统字体/Segoe UI Emoji 版本漂移,粗细和占位都不受控,和面板内既有的线性图标完全对不上。
- 远程/本地这对语义在代码里本来就是**互相矛盾**的:`ChatPanel` 用 📂=远程、🖥=本地,`SessionPanel` 却用 🖥=远程、📂=本地。
- 现在统一为一套**内联 SVG**(`web/src/components/icons/icons.tsx`),颜色随所在行文字色(`currentColor`),尺寸由 `size` 显式控制,不再受字体影响。

## 2. 风格规范(必须遵守)

| 项 | 规范 |
| --- | --- |
| 网格 | `viewBox="0 0 16 16"`,内容 bbox 统一居中于 `(8,8)` |
| 描边 | `stroke="currentColor"`、`stroke-width="1.6"`、`stroke-linecap="round"`、`stroke-linejoin="round"` |
| 填充 | `fill="none"`。**两处实心是表意需要**:`IconAiChat16` 的星芒(AI 的视觉锚点)、`IconTheme16` 的对比半圆(半明半暗只剩描边看不出来) |
| 圆角 | 1.4~2.2(按形状在网格上取整;同级元素用同一值) |
| 留白 | 单侧 1.2~2.8 网格单位(含 0.8 描边外扩后仍完整落在 0~16 内,不裁切) |
| 命名 | `Icon<PascalName><Grid>`,如 `IconCloud16`;文件内按「填充图标 / 线性图标 / 应用级导航图标」三段分组 |
| 组件 API | `{ size?: number; className?: string }`;尺寸必须显式传 `size`(不依赖 `font-size`),颜色靠容器文字色 |
| 配色 | 不在 SVG 内写死颜色;语义色交给 CSS(`.ws-chip` 远程=强调色、`.ws-chip.local` 本地=绿色、`.ws-chip.none` 中性色) |

### 尺寸基线

| 场景 | size | 说明 |
| --- | --- | --- |
| 顶部标签条 `.btab-icon` / 侧栏终端按钮 `.rsb-term` | 14 / 15 | 标签字号 12.5px,图标略大一档更醒目 |
| 工作区 chip `.ws-chip-ico`、下拉项、分组头 `.s-group-ico` | 13 / 14 | 与 12~12.5px 文字同行 |
| 手机底部栏 `.bb-ico` | 20 | 触屏点击目标,配 11px 标签 |

## 3. 语义映射(重新定义的一对)

远程与本地**各用一个完整形状**,不做「文件夹叠小角标」的合成图 —— 在 12~14px 下叠图会糊成一团。

| 概念 | 图标 | 组件 | 形状理由 |
| --- | --- | --- | --- |
| 远程工作区 | ☁ 云 | `IconCloud16` | 云 = 远端(和 Dropbox/OneDrive 的「远端=云」直觉一致) |
| 本地工作区 | 📁 文件夹 | `IconFolder16` | 本机目录;同时复用到手机栏「文件」 |
| 不使用工作区(整台服务器) | 机架 | `IconServer16` | 不绑目录,边界=整台机器 |
| 不使用工作区(整台电脑) | 显示器 | `IconDesktop16` | 不绑目录,边界=这台电脑 |
| 家目录(下拉项) | 房子 | `IconHome16` | — |

顶部导航三枚(加预览):

| 概念 | 组件 | 形状 |
| --- | --- | --- |
| AI 编程助手 | `IconAiChat16` | 对话气泡 + 星芒(AI 的通用记号) |
| 终端 | `IconTerminal16` | 圆角窗口 + 提示符 `›_` |
| 自动化任务 | `IconSchedule16` | 时钟:**表圈本身就是一圈循环箭头**(带箭头缺口)= 到点自动跑 |
| 浏览器预览 | `IconBrowser16` | 窗口 + 标题栏 |

设置面板左侧菜单(8 项,一枚一概念,互不重形):

| 菜单项 | 组件 | 形状 |
| --- | --- | --- |
| AI 配置 | `IconRobot16` | 机器人头(与原来的 🤖 同一心智) |
| 生图配置 | `IconImage16` | 相框 + 太阳 + 山 |
| 主题 | `IconTheme16` | 明暗对比圆(右半实心) |
| 技能 | `IconPuzzle16` | 拼图块 |
| 工具插件 | `IconPlug16` | 插头 |
| MCP 服务 | `IconHub16` | 中心节点 + 两个外部服务 |
| 全局指令 | `IconClipboard16` | 指令板(夹子 + 条目) |
| 关于与更新 | `IconInfo16` | 信息圆 |

> MCP 服务原来用 🔗:链接字形太泛(和「打开外部链接」混淆),换成「中心节点 + 两个外部服务」之后才说得清它是**把外部服务接进来的协议**。

文件列表右键菜单(本地/远程共用一套):

| 菜单项 | 组件 | 形状 |
| --- | --- | --- |
| 打开(目录)/ 新建文件夹 / 上传文件夹 | `IconFolder16` | 与列表行、本地工作区同一个文件夹图标 |
| 打开(文件)/ 新建文件 / 上传文件 | `IconFile16` | 文档 + 折角 |
| 下载 | `IconDownload16` | 托盘 + 下箭头 |
| 传到本地 / 传到远程当前目录 | `IconTransfer16` | 双向箭头 ⇄(跨端传输) |
| 复制 | `IconCopy16` | 既有成员(双矩形) |
| 复制路径 | `IconLink16` | 链环(🔗 的线性版) |
| 复制文件名 | `IconTag16` | 标签(名字牌) |
| 重命名 | `IconPencil16` | 铅笔 |
| 粘贴到此处 | `IconPaste16` | 剪贴板 + 下箭头 |
| 删除 | `IconTrashOutline14` | 既有成员(14 号) |

> 「下载」与「传到本地」原来是同一个 ⬇(两行挨着、含义不同):现在下载=托盘+下箭头(走浏览器下载),传到本地=⇄(跨端传输),一眼能分辨。多选操作条上的同名动作复用同一对图标,不在同一块面板里出现两种画法。

文件编辑器(CodeEditor)右键菜单 —— 复制类动作**不造第二枚**,与文件列表共用:

| 菜单项 | 组件 | 形状 |
| --- | --- | --- |
| 撤销 / 重做 | `IconUndo16` / `IconRedo16` | 一对镜像的折返箭头(左=回到过去,右=再做一次) |
| 剪切 | `IconCut16` | 剪刀(两片刀口交叉 + 两个握环) |
| 复制 / 粘贴 | `IconCopy16` / `IconPaste16` | 与文件列表菜单同一对 |
| 全选 | `IconSelectAll16` | 选择框 + 勾(框表示"整段范围",与纯勾的 `IconCheck16` 区分) |
| 保存 | `IconSave16` | 软盘 |
| 复制文件路径 / 复制文件名 | `IconLink16` / `IconTag16` | 与文件列表菜单同一对 |

> 编辑器菜单原来用的是 `↺ ↻ ✂ 📋 📥 ☑ 💾 📄 🏷` 九个字符字形:同一个「复制」在文件列表是 `IconCopy16`、在编辑器里是 📋,两处并排看就是两套语言。现在只补编辑器独有的五个动作,其余四个直接复用 —— 菜单图标列的 18px 定宽槽(`.ctxmenu .ctx-ico`)本来就已按 SVG 居中做好。

顶部标签条(TabStrip)右键菜单 —— 与文件 / 编辑器菜单共用 `.ctxmenu` 与 18px `.ctx-ico` 槽:

| 菜单项 | 组件 | 形状 |
| --- | --- | --- |
| 置顶标签 / 取消置顶 | `IconPin16` | 按钉(钉帽 + 收拢的针身 + 针尖);钉住 = 固定在标签条前端、不随滚动 |
| 关闭当前标签 | `IconClose16` | 复用「退出多选」那枚叉(全站关闭只此一枚) |
| 关闭其它标签 | `IconCloseOthers16` | 两片错位标签页 + 前片内一枚叉(除这个之外的一并关掉) |
| 关闭全部标签 | `IconTrashOutline14` | 复用文件菜单的垃圾桶(清空全部;原来就是 🗑) |

> 标签条右键菜单原来是 `📌 ✕ 🗂 🗑`:同一条标签条上的固定标签(AI 助手 / 终端 / 自动化任务 / 浏览器预览)早已是 SVG,隔壁的文件与编辑器菜单也早已是 SVG,只剩这里还是字形。四枚里两枚复用既有成员,只新增「置顶」与「关闭其它」。

工具栏 / 输入区 / 顶栏 / SSH 面板:

| 位置 | 组件 | 形状 |
| --- | --- | --- |
| 文件工具栏「上级」+ 选目录弹窗「上级」 | `IconFolderUp16` | 文件夹 + 上箭头 |
| 文件工具栏「上传 ▾」 | `IconUpload16` | 托盘 + 上箭头(与下载反向同一形状) |
| 文件工具栏「⌕ 刷新」 | `IconReload16` | 既有环形箭头(全站只此一枚刷新) |
| 文件工具栏「传到本地 / 传到远程」 | `IconTransfer16` | 与右键菜单同一枚 |
| 多选模式切换「退出多选」 | `IconClose16` | 叉 |
| composer 发送 | `IconSend16` | 纸飞机 |
| composer 停止 | `IconStop16` | 圆角方块(与发送同一按钮位,不能一个 SVG 一个 emoji) |
| 顶栏「打开/收起右侧栏」 | `IconSidebar16` | 窗口 + 竖向分栏线 |
| SSH 面板「编辑 / 删除」 | `IconEditLine16` / `IconTrashOutline14` | 编辑 = 铅笔 + 下方编辑线(按需求重做,见下注);删除复用既有 14 号 |
| SSH 面板表单「返回」 | `IconBack16` | 带箭杆的左箭头(表单 → 列表),替代原来的文字字形 `←` |
| 对话统计胶囊(面板最底一行) | `IconStopwatch16` / `IconDatabase16` | 秒表 = 轮/步 + 解码速度;数据仓(圆柱) = token 用量与缓存命中 |
| 终端列表「本机 / 远端」标记 | `IconDesktop16` / `IconCloud16` | 直接复用工作区那一对:显示器 = 跑在这台电脑上,云 = 跑在远端服务器上 |
| 目录浏览弹窗「我的电脑 / 家目录」 | `IconDesktop16` / `IconHome16` | 也与工作区同一枚:显示器 = 这台电脑、房子 = 家目录(原来本地侧是 `💻`/`🏠`,远程侧的「家目录」却挂着文件夹 `📁`) |
| 目录浏览弹窗的目录行 / 文件行 | `IconFolder16` / `IconFile16` | 目录行早已是文件夹;这次把**不可点的文件行**也从 `📄` 收敛到同族文档图标 |

> **SSH 面板的「编辑」为什么和文件菜单的「重命名」不是同一枚**:两者动作层级不同 —— 重命名是**改一个名字**(`IconPencil16`,纯铅笔),编辑服务器是**改一份配置**(`IconEditLine16`,铅笔 + 编辑线)。`IconPencil16` 仍专属文件列表右键菜单,两枚同网格同描边,只在「有没有编辑线」上区分。这是对下面「同一动作不造第二枚」的唯一例外,理由是需求明确要求为 SSH 编辑重新设计。

> 刷新**没有新造**:`IconReload16` 已经在用(环形箭头),同一个动作在全站只能有一枚图标 —— 再造一枚"更好看的刷新"就是给以后留不一致。

## 4. 落位清单(改动的文件)

| 文件 | 改动 |
| --- | --- |
| `web/src/components/icons/icons.tsx` | 新增 9 枚图标(云/文件夹/机架/显示器/房子/AI 气泡/终端/时钟/浏览器) |
| `web/src/App.tsx` | 标签条固定标签与预览标签换 SVG;标签条末端「在侧栏打开终端」换 `IconTerminal16`;顶栏「检测到项目地址」的预览 chip 也用 `IconBrowser16` |
| `web/src/components/BottomBar/BottomBar.tsx` | 手机底部栏 5 项全部换 SVG(含「文件」用 `IconFolder16`) |
| `web/src/components/ChatPanel/ChatPanel.tsx` | 工作区 chip(图标+文案拆两段,锁定时用既有的 `IconLock16`);下拉项:浏览选择→`IconFolder16`、家目录→`IconHome16`、不使用工作区→`IconServer16`/`IconDesktop16`、删除→`IconTrashOutline14` |
| `web/src/components/SessionPanel/SessionPanel.tsx` | 分组头 `icon` 由字符串改为 `ReactNode`:远程=`IconCloud16`、本地=`IconFolder16` |
| `web/src/components/FileManager/FileManager.tsx`、`LocalFileManager.tsx` | 文件列表的**文件夹**图标 📁 → `IconFolder16`(含「新建文件夹」那一行);普通文件 📄 / 软链 🔗 未动 |
| `web/src/components/DirBrowser/DirBrowser.tsx`、`LocalDirBrowser.tsx` | 选择目录弹窗里的**目录行** 📁 → `IconFolder16` |
| `web/src/components/SettingsPanel/SettingsPanel.tsx` | 左侧菜单 8 项 🤖🖼️🎨🧩🔌🔗📌ℹ️ → `IconRobot16 / IconImage16 / IconTheme16 / IconPuzzle16 / IconPlug16 / IconHub16 / IconClipboard16 / IconInfo16`;`MENUS` 的 `icon` 由字符串改为 `ReactNode` |
| `web/src/components/FileManager/FileManager.tsx`、`LocalFileManager.tsx` | 文件列表**右键菜单**与多选操作条:📂📄📁⬇⬆📋🔗📝✏️📥🗑 → 上表那套;`styles.scss` 的 `.ctx-ico` 由 `text-align:center` 改 flex 居中 |
| `FileManager.tsx`、`LocalFileManager.tsx`、`DirBrowser.tsx`、`LocalDirBrowser.tsx`、`ChatPanel.tsx`、`App.tsx`、`SshConnectModal.tsx` | 工具栏/输入区/顶栏/SSH 面板:⬆ 上级 / ↻ / ⬆ 上传 / ⬇ 传到本地 / ✎ 编辑 / 🗑 删除 / ➤ 发送 / ⏹ 停止 / ▤ 右侧栏 → 上表那套;新增 `button.icon-btn`(图标+文字按钮交给按钮自己居中排版) |
| `App.scss` / `ChatPanel.scss` / `BottomBar.scss` / `fm.scss` / `dirbrowser.scss` / `SettingsPanel.scss` | 图标槽改 flex 居中;`.btab-icon` 补 `position: relative`;目录行图标 `vertical-align: -0.5px`(实测值,图标中心与文字行中心重合);设置菜单图标槽定宽 16px(原来 emoji 字宽不齐,标签左缘会错位) |

后续补充的几处:

| 文件 | 改动 |
| --- | --- |
| `web/src/components/StatsPills/StatsPills.tsx` / `StatsPills.scss` | 两个胶囊的 ⏱ / 🗄 → `IconStopwatch16` / `IconDatabase16`(统计行 12 号);`Pill` 的 `icon` 由字符串改 `ReactNode`;`.stat-pill-icon` 由字体尺寸改 flex 容器(SVG 不再是字形,`display:block` 防基线间隙撑高 24/28px 胶囊) |
| `web/src/components/SshConnectModal/SshConnectModal.tsx` | 已保存服务器行的「编辑」`IconPencil16` → `IconEditLine16`(13 号);表单底部「← 返回」文字箭头 → `IconBack16` + 复用 `button.icon-btn`(图标与文字已经是 flex gap 5px) |
| `web/src/components/FileViewer/CodeEditor.tsx` | 编辑器右键菜单九项的 `↺ ↻ ✂ 📋 📥 ☑ 💾 📄 🏷` → 五个新动作 `IconUndo16 / IconRedo16 / IconCut16 / IconSelectAll16 / IconSave16`(14 号)+ 四个复用(`IconCopy16 / IconPaste16 / IconLink16 / IconTag16`);`.ctxmenu .ctx-ico` 已是 18px 的 flex 槽,样式无需改动 |
| `web/src/components/ConsolePanel/ConsolePanel.tsx` / `ConsolePanel.scss` | 终端列表名前的 `🌐 / 💻`(桌面列表与手机下拉两处)→ `IconCloud16` / `IconDesktop16`(13 号);`.term-list-name` 改为 flex 容器,名字单独包 `.term-mode-text` 承担 overflow ellipsis(整格挂 ellipsis 会把图标一起截掉) |
| `web/src/components/DirBrowser/DirBrowser.tsx` / `LocalDirBrowser.tsx` / `dirbrowser.scss` | 弹窗快捷入口与文件行:`💻 我的电脑` → `IconDesktop16`、`🏠 家目录` / 远程侧的 `📁 家目录` → `IconHome16`、不可点的 `📄 文件行` → `IconFile16`(13 号);两个入口按钮改用全局 `button.icon-btn`(flex 排版),文件行补上目录行同款 `<span>` 以便名字超长时截断 |
| `web/src/App.tsx` | 标签条右键菜单的 `📌 ✕ 🗂 🗑` → `IconPin16`(新增)/ `IconClose16` / `IconCloseOthers16`(新增)/ `IconTrashOutline14`,统一 14 号并复用既有 `.ctx-ico` 槽(样式零改动);`关闭全部标签` 的垃圾桶随 `.danger` 走 `--red` |

> **顺带修掉的一个 bug**:`.btab-dot`(自动化任务「到点没跑」的小红点)是 `position:absolute`,但 `.btab-icon` 没有定位,真正生效的定位祖先是外层 `.layout` —— 红点其实被甩到了主区右上角。现在给 `.btab-icon` 加了 `position: relative`,红点回到「自动化任务」图标上。

## 5. 使用规则

- ✅ 新增同类图标时,复用 `icons.tsx` 里的 `LINE` 辅助函数(16 网格 / 1.6 描边 / 圆头),不要另起一套网格或描边宽度。
- ✅ 图标颜色只由文字色决定;需要强调时改容器的 `color`,不要在 SVG 里写 `stroke="#xxx"`。
- ✅ 尺寸显式传 `size`;同一区域内保持一致(见「尺寸基线」)。
- ❌ 不要再用 emoji 承担导航/工作区语义(文件标签按媒体类型的 🖼️/📄 例外:那是内容类型标记)。
- ❌ 不要在 16 网格里塞两个以上重叠图元做「角标」;需要表达组合语义时,拆成两个独立图标或改用文案。
- ❌ 不要给这组图标加 `animation`/`filter`:它们是静态 UI 图标,动效交给容器 CSS(如 `.btab-dot` 的呼吸)。

## 6. Canvas 说明

**当前不需要 Canvas。** 触发 Canvas 的条件是:同一画布上万级图元、逐像素读写、或每帧重绘的复杂动效;这组图标都是静态界面图标,用 SVG 更小、更好换色、可访问性也更好。
若后续要做 Canvas 版(例如把标签条画在自绘顶栏里),直接复用这里的 `d` 常量以 `new Path2D(d)` 绘制,颜色用 `getComputedStyle(el).color` 取主题色即可 —— 路径与 SVG 版不会分叉。

## 7. 交付物与验证

- `docs/design/icons/icon-preview.html`:暗/亮两套主题、12/14/20/32 四档尺寸、并按「真实落位」摆出标签条、工作区 chip、文件菜单、对话统计行与 SSH 列表行的样子(内联 sprite,`file://` 直接打开)。
- `docs/design/icons/icon.sprite.svg`:`<symbol>` sprite,可被 `ui-generation-workflow-runner` 之类直接 `<use>` 复用(跨文件 `use` 需 http(s))。
- `docs/design/icons/icon.manifest.json`:图标清单、语义、落位、技术建议。
- 验证:① `npx tsc --noEmit` 通过;② 在浏览器里用 `getBBox()` 实测各枚图标的 bbox,确认留白落在 1.2~2.8、且含 0.8 描边外扩后仍完整落在 0~16 内(实测值见 manifest 的 `qualityGates.geometry`)。
