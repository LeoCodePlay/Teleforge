---
name: computer-use
version: 2.0.0
description: 直接操作本机电脑(看屏幕 + 动鼠标键盘):列窗口/启动或激活应用、UI Automation 元素级点击与输入、OCR 按文字定位、坐标兜底点击。用于自动化没有 API 的桌面软件、跨应用流程与 GUI 验证。仅 Windows 可用。
triggers:
  - 操作我的电脑
  - 帮我点一下
  - 打开微信/QQ/某个软件
  - 控制鼠标键盘
  - 桌面自动化
  - computer use
allowed-tools:
  - computer_control
  - computer_windows
  - computer_launch
  - computer_ui
  - computer_ui_action
  - computer_ocr
  - computer_screenshot
  - computer_action
  - ask_user_question
---

# computer-use(AI 操作本机电脑)

## 适用场景

需要**直接驱动 GUI** 时用这套工具,而不是找 API 或写脚本:自动化没有命令行/API 的桌面软件、
跨应用流程(在 A 应用复制、到 B 应用粘贴)、验证界面改动的真实效果。

不适用:能用 `run_command` / `read_file` 完成的,优先用那些(更快、更稳、可复现)。

## 硬性前提(安全机制)

1. **必须先开启控制**:第一步调用 `computer_control(action="start")`。开启后所有显示器上会弹出
   「AI 操控中」悬浮窗,用户随时看得到。
2. **未开启时截图/操作会被拒绝**:这是设计如此,不要重试,先 start。
3. **用户手动急停不可自行解除**:用户点了悬浮窗「停止」后进入"用户已锁定",你再调 `start` 会被
   拒绝。此时停下来,请用户在界面(设置 → 工具插件 → AI 电脑操控)重新开启,不要反复尝试。
4. 任务结束或用户说"停"时,主动 `computer_control(action="stop")` 收尾。

## 核心:定位目标的手段按优先级选,不要一上来就估坐标

| 优先级 | 手段 | 什么时候用 | 准确率 |
| --- | --- | --- | --- |
| 1 | `computer_ui` + `computer_ui_action` | 标准应用(资源管理器、浏览器、Office、设置、大多数 Win32/WPF/UWP)。按控件名拿 `ref` 后直接 invoke/set_value | **不会点偏**(不经过坐标) |
| 2 | `computer_ocr` → 用返回的中心坐标点击 | 自绘应用(微信 PC 版、QQ、部分游戏/工具),UIA 里只有匿名容器 | 高(按文字行中心点) |
| 3 | `computer_action` + **相对坐标** rx/ry | 目标位置相对窗口固定,但既没有元素也没有文字(如画布某处) | 高(不受窗口移动/缩放影响) |
| 4 | `computer_action` + 图片坐标 x/y | 上面都不行时的兜底 | 一般(模型估像素必然有误差) |

**关键:第 4 种是最后手段。** 实测教训——靠估像素点击,在多屏拼图(缩放 0.43)上会系统性点偏,
然后就是"点错 → 截图 → 再点错"的死循环。能用元素或文字定位就绝不要估坐标。

## 打开应用:先查在不在跑,再决定启动

**不要**用 Win 键搜索 + 点结果(最容易点错,还会开出第二个实例)。正确姿势:

```
computer_launch(app="微信", match="Weixin")     # 已经在跑 → 自动切到前台,不重复启动
                                              # 没在跑 → 启动并等窗口出现
computer_windows()                            # 需要看全部窗口 / 拿 hwnd 时用
computer_action(action="click", ...)          # 但激活窗口请用 computer_launch 或下面这条
```

`computer_launch` 内部会先枚举窗口:命中标题或进程名就直接激活已有窗口。微信的进程名是
`Weixin`、窗口标题是「微信」,所以 `app="微信"` 时把 `match="Weixin"` 一起给它最稳。

被遮挡/最小化的窗口要切到前台,用 `computer_launch` 再调一次即可(它就是"打开或激活")。

## 标准循环

```
computer_control(action="start")
computer_launch(app="...")        # 打开或激活目标应用
computer_ui()                     # 看当前窗口的元素(或 computer_ui(query="搜索"))
computer_ui_action(ref="e7", action="invoke")   # 元素级操作:不会点偏
computer_ui()                     # 再看一次,确认状态变了
```

规则:

- **每次动手前先确认目标**;不确定当前窗口是谁,先 `computer_windows` 看前台是哪个。
- **优先 `set_value` 而不是 `type`**:元素支持 ValuePattern 时直接写文本,不依赖焦点和键盘布局。
- 操作后**必须再看一次**(`computer_ui` 或 `computer_ocr` 或 `computer_screenshot`)确认结果。
- `computer_action` 每次鼠标动作后会回报"落点元素"。**如果那不是你要点的东西,立刻停下重新定位**,
  不要继续下一步。

## 自绘应用(微信 PC 版这类)实操

微信的 UIA 只暴露外壳(左侧导航按钮、标题栏按钮),聊天列表和消息区全是匿名容器。
所以流程是"OCR 定位 + 相对坐标兜底":

```
computer_launch(app="微信", match="Weixin")     # 打开/激活
computer_ocr(hwnd=<微信窗口>, match="廖钧涛")     # 模糊匹配直接给候选 + 中心坐标
computer_action(action="click", sx=<候选中心x>, sy=<候选中心y>)   # 点联系人
computer_action(action="click", rx=0.5, ry=0.9, hwnd=<微信窗口>)  # 点输入框(窗口底部中间)
computer_action(action="type", text="...")       # 输入内容
computer_action(action="key", keys=["enter"])    # 发送
computer_ocr(hwnd=<微信窗口>, match="刚发的内容")  # 确认消息已发出
```

要点:
- **一定用 `match` 参数**,不要自己从识别结果里逐行比对:OCR 认错字很常见(实测"廖钧涛"被认成
  "膠钧涛"),工具会按逐字重合度模糊匹配并返回候选 + 中心坐标,直接用中心坐标点击即可。
  匹配不到时把 `min_score` 放宽到 0.34,或把 `match` 换成更短的片段(如姓名后两个字)。
- OCR 会自动放大 2 倍再识别(小字更准);字特别小可以调 `scale=3`。
- 输入框这类"没有文字可识别"的位置,用相对坐标 `rx/ry`(如底部中间 `rx=0.5, ry=0.9`)。
- 点完联系人后窗口布局会变,重新 `computer_ocr` 再决定下一步。

## 不支持视觉的模型怎么办

**照样能用**,而且更准:

- `computer_ui` 返回的是**文字化的元素结构**(控件名/类型/位置/可用动作),不依赖看图;
- `computer_ocr` 返回的是**屏幕上的文字 + 坐标**,等于把屏幕"读"成文本;
- `computer_action` 的落点元素回报也是文字。

只有第 4 种兜底(纯坐标点击)才真正需要视觉。所以非视觉模型请走"元素 → 文字 → 相对坐标"这条路,
不要用 `computer_screenshot` 然后猜坐标。

## 坐标三种给法

| 给法 | 参数 | 说明 |
| --- | --- | --- |
| 窗口相对 | `rx`/`ry`(+ `hwnd`/`pid`/`title`) | 0~1,对窗口移动/缩放/多屏免疫,**推荐** |
| 屏幕物理 | `sx`/`sy` | `computer_ocr` 的"中心=(x,y)"与 `computer_ui` 的坐标就是这一套,直接填 |
| 图片像素 | `x`/`y` | 最近一次 `computer_screenshot` 的图片坐标,兜底用 |

拖拽同理:`to_rx`/`to_ry`、`to_sx`/`to_sy`、`to_x`/`to_y`。

## 失败与兜底

- **锁屏**:返回"会话处于锁屏状态"说明电脑锁屏了——屏幕帧冻结、键鼠输入也到不了任何应用。
  不要重试,用 `ask_user_question` 请用户解锁后再继续。
- `computer_ui` 元素很少/没有名字:说明是自绘应用,改用 `computer_ocr`,不要反复 dump 元素树。
- `ref 已失效`:界面变了,重新 `computer_ui` 拿新的 ref(旧 ref 只在最近一次结果里有效)。
- 点击没反应:先确认目标窗口是不是前台(`computer_windows` 看 `[前台]` 标记),不是就
  `computer_launch` 激活它;再看落点元素是否为目标。
- 连续两次同样操作无效:停下来重新看界面(元素树/OCR),不要重复同样的点击。
- 任何时候用户说"停"或你发现操作对象不对:立刻 `computer_control(action="stop")`。
