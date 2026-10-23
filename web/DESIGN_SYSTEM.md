# 实色界面 Solid UI —— 设计规范

> 本文档是本项目 UI 的**唯一视觉事实来源**(Single Source of Truth)。
> 任何新增页面、组件、弹窗必须遵循本文规范。
> 旧版「液态玻璃 Liquid Glass」规范已废弃并删除,毛玻璃 / 模糊 / 内高光 / 外发光全部不再使用。

---

## 一、设计理念

**Solid UI = 不透明实色表面 + 1px 发丝描边 + 极淡单一投影。**

- **材质**:界面元素是一块块**不透明实色**。层次靠「表面明度差 + 描边」表达,不靠模糊。
- **光线**:没有内高光、没有外发光、没有镜面反光。深度只由一层极淡的、由主题背景色派生的投影承担。
- **形体**:克制的圆角梯度(6 / 10 / 14 / 999),边界干净。
- **色彩**:全站只有**一个强调色**,只用在「可点击 / 可选中 / 焦点」上。

**禁止**:`backdrop-filter`(毛玻璃)、`--glass-hi/--glass-lo` 式内高光、`0 0 Npx` 外发光、
`text-shadow` 光晕、渐变实体表面、极光/光斑动画、纯黑投影。

---

## 二、6 色令牌体系(核心)

> **页面里出现的每一个颜色,都由用户自定义的 6 个颜色派生。**

`theme/themes.ts` 的 `deriveThemeVars()` 把这 6 色展开成 100+ 个 CSS 变量。
组件只消费变量,**禁止**出现任何硬编码色值(hex / rgb / rgba)。

| # | 字段 | 语义 | 作用范围 |
|---|---|---|---|
| 1 | `bg` | 背景基色 | 页面底色;**它的明暗决定整套主题是深色还是浅色** |
| 2 | `surface` | 表面色 | 顶栏 / 侧栏 / 底栏 / 面板 / 卡片 / 弹层 |
| 3 | `text` | 文字主色 | 文字,并派生全部次级文字与描边深浅 |
| 4 | `accent` | 强调色 | 主按钮 / 选中 / 链接 / 焦点环 / 进度 |
| 5 | `success` | 成功色 | 连接正常 / 通过 / diff 新增 |
| 6 | `danger` | 危险色 | 错误 / 删除 / diff 删除 |

### 2.1 派生规则

| 目标 | 派生方式 |
|---|---|
| 文字层级 `--text-2 / --muted / --text-faint / --placeholder` | `surface → text` 插值 |
| 抬升填充 `--glass-bg / --card-hover / --fill-1 / --fill-2` | `surface → text` 插值(`tint`),**方向 = 抬起** |
| 凹陷填充 `--glass-bg-inset / --surface-inset / --code-bg` | 深色往 `bg` 压(`sink`)、浅色往 `text` 压灰,**方向 = 凹下** |
| 描边 `--line-faint / --line-soft / --line / --line-strong` | `surface → text` 低比例插值 |
| 悬浮 / 按下 `--row-hover / --hover-bg / --hover-bg-strong / --hover-bg-hard` | `withAlpha(text, 9%–21%)`,**半透明叠加**,盖在任意父层上都成立 |
| 阴影 `--glass-shadow / --glass-shadow-lg` | 深色主题用 **bg 压暗**、浅色主题用 **text 压暗**(永不出现纯黑) |
| 语义色的**文字**形态 `--red / --green / --err-text` | 深色往 `text` 提亮、浅色往 `text` 压深(品牌原色在抬升面上过不了 AA) |
| 语义色的**品牌原色** `--red-raw / --green-raw` | 直接取 6 色原值(仅在确实要原色时用) |
| 主按钮 / 危险按钮文字 | 从主题自身「最亮端 / 最暗端」二选一,保证对比度 |
| 警告色 `--amber` | `hueShift(danger, +44°)`(红 → 琥珀);浅色主题再**压明度**到 0.31 —— 旋转会把明度抬得很高,白底上原色只有 2.39:1 |
| 次强调色 `--violet` | `hueShift(accent, +58°)`(与主色同族但不撞色) |
| diff 增删 | 新增走 `success`、删除走 `danger` |
| 滚动条 / 进度条 / 遮罩 | `text`(或 `bg`)加透明度派生 |

### 2.3 层级阶梯:原点是 `--surface`,不是「面板」

所有抬升填充都由 `tint(k)` 从 `--surface` **向上**派生,所有凹陷填充由 `sink(k)` **向下**派生。
这套派生关系成立的前提是:**承载内容的普通面板本体停在 `--surface` 这一级**,
面板内的卡片/按钮/输入框才有正确的上下方向。

| 层(深色 ink 实测) | 值 | 用什么 | 用途 |
|---|---|---|---|
| L-1 | 13,15,19 | `--bg-deep` | 页面底 |
| L0 | 22,25,31 | `--surface` | 顶栏 / 侧栏 / 主区 |
| L1 | 18,21,26 | `--glass-bg-inset`、`--code-bg-solid` | 输入框 / 代码块 / 内嵌列表槽(凹) |
| L2 | 30,33,39 | `--glass-bg` | 卡片静止 |
| L3 | 38,41,47 | `--overlay-bg`、`--pop-bg` | **浮层本体**(弹窗 / 菜单) |
| L4 | 50,53,59 | 浮层作用域内的 `--glass-bg` | 浮层内卡片静止 |
| L5 | 57,60,66 | 浮层作用域内的 `--fill-2` | 浮层内按钮底(全场最高的静止填充) |
| L6 | 61,64,70 | `--card-hover` | 选中 / 悬浮(菜单项与卡片**同档**) |

**方向必须单调。** 同一屏里不能出现"某个区块比它所在的容器更暗、另一个区块更亮"这类反向层:
设置面板原来的左侧导航列用下沉底,比弹窗本体还暗一档,读起来像"漏到页面底下去了" ——
导航列的分层交给一条发丝分隔线就够了。

**弹窗本体允许甚至必须抬到浮层档(L3)。** 深色主题里投影几乎不可见,弹窗只能靠色阶拉开边界:
本体停在 L0 时与背后被压暗的页面**只差 Δ9**(看着不是浮起来的卡片,而是蒙层上挖的一个洞),
抬到 L3 后 **Δ25 以上**(实测 25~28)。(浅色主题相反:浅底上投影清晰可见,靠投影分层即可。)

#### 2.3.1 浮层作用域:本体一抬,内部阶梯必须整体跟着走

抬了本体就必须**连带把内部阶梯一起上移**,否则卡片、按钮反而比本体更暗,方向直接倒过来。
做法:在 `.modal, .settings` 作用域里用 `color-mix` 相对 `--overlay-bg` 把同一套派生关系
重新表达一遍(见 `styles.scss`),而不是把 JS 的算式在 CSS 里抄第二遍 —— 抄了就有两份真相。

```scss
.modal, .settings {
  --ovl: var(--overlay-bg);
  background: var(--ovl);
  --glass-bg: color-mix(in srgb, var(--text) 6%,  var(--ovl));  /* 卡片 */
  --fill-2:   color-mix(in srgb, var(--text) 10%, var(--ovl));  /* 按钮底 */
  --line:     color-mix(in srgb, var(--text) 13%, var(--ovl));  /* 描边:必须跟着本体走 */
  --pop-bg:   var(--pop-bg-2);                                  /* 嵌在弹窗里的下拉菜单再高一档 */
  --muted:    color-mix(in srgb, var(--text) 76%, var(--ovl));  /* 文字色族同样要一起重算 */
}
```

半透明 scrim(`--hover-bg*`、`--row-hover`、`--glass-bg-hover`)本身就是自适应的,**不需要**重定义 ——
这正是 4.1 把它们从实色改成叠加层带来的第二个好处。

三个踩过的坑:

1. **文字色族必须一起重算。** `--muted` / `--text-faint` 是按 `--surface` 调好的灰阶;
   本体一抬、卡片跟着变亮,同一批灰字直接从 4.98 掉到 **3.72**(低于 WCAG AA)。
2. **别在同一作用域里既定义 `--pop-bg: var(--pop-bg-2)`、又拿 `var(--pop-bg)` 当派生基准** ——
   会自引用。基准要另起一个不会被覆盖的名字(`--overlay-bg` → `--ovl`)。
3. **`--bg` 这个变量并不存在**(页面底叫 `--bg-deep`)。写错会让整条 `color-mix` 解析失败,
   在浏览器里表现为该档位变成纯黑。

**同屏档位越少越好。** 设置面板从改造前的 **10 档**灰收敛到 **4 档**(凹陷 30 / 卡片 50 / 按钮 57 / 选中 61),
且"选中菜单项"与"选中卡片"自动落到同一档 —— 用户不需要为同一个概念学两种深度。

##### 浅色主题:画布**不压灰**,分层交给描边 + 投影

深色主题里浮层本体比页面底亮、卡片再比本体亮 —— 一条链路**单调向上**。浅色主题**不要**照抄
这套"抬升 = 变亮"的关系:本体已经是纯白,卡片只能靠**更深**来抬,于是弹窗里越大块的面越灰
(卡片占满整屏)—— 用户要的是"白主题",不该在设置里看见一整片灰底。

浅色下改用 GitHub Primer 的口径:**画布与卡片同为纯白 (`#ffffff`)**,边界交给 1px 描边与投影;
灰色只留给**真正凹陷**的槽(输入框 / 代码块 / 徽标)与**选中 / 悬浮态**。做法是在
`:root[data-dark='0'] .modal, .settings` 里另开一套值(`--ovl: var(--overlay-bg)` 即纯白)。

凹陷方向仍是"往文字色压灰"(§2.1),**不能沿用深色块的"往 `--bg-deep` 压"** —— 浅色页面底
本身接近纯白,同样的比例混出来是 `rgb(252)`:输入框在白画布上等于消失,方向也反了。所以
`--glass-bg-inset` / `--code-bg*` 必须在浅色里按 `color-mix(text N%, 纯白)` 重定义。

深色主题不受影响(`:root[data-dark]` 开关)。浅色弹窗实测档位:画布与卡片 `#ffffff` /
凹陷槽与代码块 `#f6f6f6` / 次级按钮 `#f2f2f2` / 选中悬浮 `#ebebec` / 描边 `#d7d7d8`。

### 2.2 兼容层

为了让既有 60+ 个组件样式零改名换肤,派生表同时输出旧变量名
(`--glass-bg`、`--fill-*`、`--pop-*`、`--bar-tint-*`、`--line-*` …),
只是**值全部换成实色**:

- `--glass-hi` / `--glass-lo` / `--ins-hl` / `--btn-sheen` = `transparent`(内高光整体失效)
- `--blur-sm/md/lg` = `none`(残留的 `backdrop-filter: var(--blur-*)` 一律退化为 `none`)
- `--glare` = `transparent`(扫光动效失效)

---

## 三、预设主题(三深一浅)

| id | 名称 | bg | surface | text | accent | success | danger |
|---|---|---|---|---|---|---|---|
| `ink` | 墨黑 | `#0d0f13` | `#16191f` | `#e7eaf0` | `#5b8cff` | `#3fb26f` | `#ef5f5f` |
| `graphite` | 石墨 | `#0d1117` | `#171b22` | `#e6edf3` | `#2cc4b8` | `#3fb950` | `#f0564a` |
| `dusk` | 暮色 | `#141110` | `#1e1a17` | `#f0e9e1` | `#e3a343` | `#5cba7d` | `#e5624f` |
| `paper` | 纸白(浅) | `#f6f8fa` | `#ffffff` | `#1f2328` | `#0969da` | `#1a7f37` | `#cf222e` |

> 浅色预设 `paper` 的 6 色**直接取自 GitHub Primer Light 官方色彩令牌**,不是自创配色:
> `bgColor-muted #f6f8fa` / `bgColor-default #ffffff` / `fgColor-default #1f2328` /
> `fgColor-accent #0969da` / `fgColor-success #1a7f37` / `bgColor-danger-emphasis #cf222e`。
> 上一版 `bg` 用的是偏蓝冷灰 `#eef1f5`(亮度 240),页面底本身就"发灰",光靠调派生比例
> 永远亮不起来 —— 浅色主题的底色必须是**接近纯白的中性 canvas**。

自定义主题:主题面板提供 **6 个取色器 + 名称**,右侧实时预览一张迷你界面
(背景 / 表面 / 文字 / 主按钮 / 成功 / 危险同屏可见),保存即生效、localStorage 持久化。

---

## 四、形状 / 描边 / 投影 / 动效 / 悬浮反馈

| 项 | 规范 |
|---|---|
| 圆角梯度 | `--r-sm: 6px`(小控件、按钮)/ `--r-md: 10px`(面板、卡片)/ `--r-lg: 14px`(弹窗)/ `--r-pill: 999px`(仅非按钮的 chip/badge、开关) |
| 微圆角例外 | 1–5px 仅允许用于行内 code、keycap、进度条、选区、≤24px 的图标盒;常规按钮、面板、卡片、输入框不得使用 |
| 描边 | 一律 1px;分隔用 `--line-faint/soft`,组件边界用 `--line`,悬浮用 `--line-strong` |
| 投影 | 只有浮层(弹窗 / 菜单 / 下拉 / Toast)有;按钮、卡片、输入框 **零投影** |
| 焦点环 | `box-shadow: 0 0 0 2px var(--accent-soft)` + 描边 `--accent-border` |
| 悬浮 | **叠加层模型**:底色不动,在上面叠一层以文字色为底的半透明 scrim(见下) |
| 按下 | 叠更厚一档的 scrim |
| 弹层进入 | `pop-in`:淡入 + `scale(.98)` + `translateY(3px)`,140–180ms |
| 动效频率 | 只保留「真实状态」的呼吸(后端断线、AI 操控中、等待回答),其余静止 |

### 4.1 悬浮/按下必须是「叠加层」,不能是固定实色

悬浮色一律用 `withAlpha(text, α)` 的半透明 scrim,而不是某个固定的实色:

| 令牌 | 深色 | 浅色 | 用途 |
|---|---|---|---|
| `--row-hover` | α .07 | α .06 | 表格行、列表行 |
| `--hover-bg` | α .10 | α .09 | 菜单项、下拉项、列表选项(按钮类) |
| `--hover-bg-strong` | α .14 | α .13 | 按下态 |
| `--hover-bg-hard` | α .20 | α .17 | 强反馈(工具条图标、拖拽落点) |
| `--glass-bg-hover` | α .12 | α .11 | 行/卡片/图标按钮的常规悬浮 |

**为什么必须是半透明**:列表行可能盖在 `--surface` / `--pop-bg` / 卡片 等不同层上。
固定实色无法同时保证「比每一层都更亮」(深色)或「更暗」(浅色)——
旧实现就出现过「菜单项悬浮色比它所在的 pop 面板还暗,色差只有个位数」的情况,
悬浮等于没有。半透明 scrim 无论盖在哪一层上,都稳定给出可辨的亮/暗变化。

实现上分两种写法(二选一,不要混用):

```css
/* ① 半透明元素(菜单项、列表行、幽灵按钮):直接给底色 */
.menu-item:hover { background: var(--hover-bg); }

/* ② 自带不透明底色的控件(普通按钮):底色不动,悬浮叠一层 */
button { background-color: var(--fill-2); background-image: none; }
button:hover:not(:disabled) {
  background-image: linear-gradient(var(--hover-bg), var(--hover-bg));
}
```

**验收标准**:任意可交互元素,悬浮态与静止态的底色差值 **ΔRGB ≥ 12**(当前实测最小 Δ20)。

### 4.2 渐变使用边界

Solid UI 的**表面一律实色**:卡片、面板、按钮、输入框、选中行、进度填充不得把
可见的多段 `linear-gradient` 当底色。需要层次时用 `--fill-*` / `--glass-bg*` /
`--pop-bg*` 的色阶差 + 1px 描边,不要靠渐变伪造光影。

只允许以下**机能性渐变**:

1. `mask-image` / `-webkit-mask-image` 的 alpha 渐隐(标签文字、滚动边缘、路径省略);
2. 单色叠加层:`linear-gradient(同色, 同色)` 或 `transparent` 两层,视觉上仍是实色
   (用于 hover scrim / 覆盖 code 背景);
3. 1px 状态线或分隔线的两端淡出(如 QueuePanel 的琥珀线、dockkit 分隔线);
4. 加载 / 扫描 / 文字 shimmer 的动画扫光;
5. 品牌字标 `.brand` 的文字渐变(内容标识,不是界面表面)。

除此之外新增 `linear-gradient` 视为违规;能用实色 token 就用实色。

### 4.3 字号 / 间距 / 层级

字号统一走 7 档(`styles.scss` 的 `:root`)。现有的半像素值按**最接近的一档**收敛:
`10.5 → 10` / `11.5 → 11` / `12.5 → 12` / `13.5 → 13`。

| token | 值 | 用途 |
|---|---|---|
| `--fs-2xs` | 10px | 极小标签 / 角标 |
| `--fs-xs` | 11px | 辅助说明 / 元信息 |
| `--fs-sm` | 12px | 紧凑正文 / 表单 / 菜单 |
| `--fs-md` | 13px | 按钮 / 正文 |
| `--fs-lg` | 14px | 页面正文 |
| `--fs-xl` | 16px | 区块标题 |
| `--fs-2xl` | 24px | 页面大标题 |

间距用 2px 基准的固定梯度,新增布局不要再写裸数字:

| token | 值 |
|---|---|
| `--space-1` | 2px |
| `--space-2` | 4px |
| `--space-3` | 6px |
| `--space-4` | 8px |
| `--space-5` | 10px |
| `--space-6` | 12px |
| `--space-7` | 14px |
| `--space-8` | 16px |
| `--space-10` | 20px |
| `--space-12` | 24px |
| `--space-16` | 32px |

层级只收口**全局层**;组件内部为了局部叠放使用的 1–20 仍可保留裸值:

| token | 值 | 用途 |
|---|---|---|
| `--z-behind` | -1 | 页面底光 / 背后层 |
| `--z-topbar` | 20 | 顶栏 |
| `--z-panel` | 30 | 悬浮入口 / 底部栏 |
| `--z-scrollbar` | 45 | 覆盖式滚动条 |
| `--z-mask` | 50 | 弹窗遮罩 |
| `--z-popover` | 60 | 轻浮层(菜单 / 建议 / 统计) |
| `--z-context-menu` | 200 | 右键菜单 |
| `--z-tooltip` | 500 | 常规 tooltip |
| `--z-modal` | 1000 | 模态浮层 |
| `--z-tooltip-portal` | 1100 | portal 到 body 的 tooltip |
| `--z-toast` | 1100 | Toast / 全局提示 |

迁移状态:**全量完成**。全局基元、App 壳层与 `web/src` 下全部 SCSS / CSS 已按精确值
完成字号与 `gap / margin / padding` 的 token 替换(360 处字号、1268 处间距)。
剩余未 token 化的只有非刻度的 1–5px 微间距、7/9/11/13px 局部微调、负 margin
(光学对齐)和 BottomBar 的 20px 图标字号,它们属于组件微调,不参与字号 / 间距梯度。
新增代码必须先查这三张表。

---

## 五、组件规范

### 5.1 按钮(全站只有一套形状)

按钮的形状由 `styles.scss` 的**形状统一锁**强制收口,组件只允许改语义色,
不允许再引入第二种形状:

| 项 | 规范 |
|---|---|
| 圆角 | `--r-sm`(6px),**所有按钮**;全站禁止胶囊(999px)/ 圆形(50%)按钮 |
| 描边 | 静止态一律 `1px solid var(--line)`;hover 提亮到 `--line-strong` |
| 底色 | 普通 `--fill-2` / 幽灵 `transparent` / 主按钮 `--accent` / 危险 `--fill-2`(与普通按钮同一个底) |
| 语义 | 只靠**底色 + 文字色**表达(选中/危险/警告),不再出现绿框、红框、蓝框按钮 |
| 投影 | 零投影 |
| padding / 字号 | `7px 13px` / `13px`;小号 `button.sm` = `4px 11px` / `12px` |

**危险(删除)按钮统一口径** —— 全站只有一个危险红 `--red`,分两种形态:

| 形态 | 类 | 静止 | 悬浮 |
|---|---|---|---|
| 文字按钮 | `button.danger` | 底 `--fill-2` + 描边 `--line` + 文字 `--red` | 叠 `--danger-soft-strong` scrim + 描边 `--line-strong` |
| 图标按钮 | `.action-icon.danger` | 透明底 + 图标 `--red` | 底 `--danger-soft`、图标 `--red` |
| 菜单项 | `.ctxmenu button.danger` / `.term-menu-item.danger` | 透明底 + 文字 `--red` | 底 `--danger-soft`、文字 `--red` |

两条硬规则,历史上都踩过坑:

1. **所有独立删除按钮必须挂 `danger` 类**。漏挂就继承默认 `color: var(--text)`,
   深色主题里直接变成「白字删除」;菜单项还需显式给 `color: var(--red)`,
   否则被 `.ctxmenu button` 的 `--text` / `.term-menu-item` 的 `--text` 盖掉。
2. **不要再用 `--err-text` 给按钮/图标上色**。`--err-text` 是给错误**文案条**(`.error`)
   用的,它比 `--red` 多掺一档 `text`、更灰;混用会让文字删除按钮「偏淡」、
   图标删除按钮「偏鲜艳」,同屏出现两种红。危险按钮/图标一律 `--red`。

结构件例外(共 3 处,已在 `styles.scss` 内联注明):

1. 文件管理器的页签 `.fm-tab` → 保留上圆角 `--r-sm --r-sm 0 0`;
2. 附件缩略图按钮 `.msg-att-img` / `.att-thumb` → 跟随图片容器 `--r-lg`;
3. 开关滑块轨道 `.mc-switch` / `.plugin-switch` → 形状本身即「开关」语义,保留 `--r-pill`。

顶部主标签条与右栏标签条已统一为 28px 圆角 chip(见 5.5),`.btab` / `.tabstrip-add`
不再走上圆角例外。

实现方式:`button { border-radius: var(--r-sm) !important; }` —— 历史上 20+ 个组件
各自把按钮写成胶囊/圆形/8~12px 圆角,`!important` 保证不再有漏网的第二种形状。

### 5.2 列表行 / 行内次要操作(一行 = 一个可点单元)

一行里同时有「主操作」和「次要操作」(删除 / 对比 / 侧栏 / 打开)时,
**不能让两个按钮各自为政** —— 那是高度不一致、悬停像两个无关控件的根源。

规则:

| 项 | 规范 |
|---|---|
| 谁负责悬停底色 | **行容器**(`.ws-pick-item` / `.fcc-item` / `li`) |
| 行内控件 | 一律 `background: transparent` + `border: 0`,不给自己第二块底色 |
| 盒模型 | 行内所有控件 `min-height` 与内边距**完全一致**,`align-items: stretch`,上下沿严格对齐 |
| 次要操作 | 只用**文字色**表达状态(静止 `--text-faint`/`--muted`,悬停 `--red`/`--accent-2`/`--text`),不套彩色边框 |
| 出现时机 | 默认 `opacity: 0`,与整行悬停**同时**出现(不做独立淡入) |
| 圆角 | 与行容器同一档 `--r-sm` |

反例(禁止):把次要按钮做成 `height: 19px` + `border-radius: pill` + 自己的边框和背景。
结果就是「行的左半边亮、右边按钮那截不亮」,以及一行里出现两个不同高度的控件。

```scss
/* ✅ 正确:底色的唯一归属是行容器 */
.row { display: flex; align-items: stretch; border-radius: var(--r-sm); }
.row:hover { background: var(--hover-bg); }
.row-main, .row-action {
  display: inline-flex; align-items: center;
  min-height: 30px; padding: 0 11px;
  background: transparent; border: 0; border-radius: var(--r-sm);
}
.row-action { color: var(--text-faint); }
.row:hover .row-action, .row-action:hover { color: var(--red); }  /* 只换色,不加底色 */
```

### 5.3 其它组件

| 组件 | 规范 |
|---|---|
| 顶栏 / 侧栏 / 底栏 | `--surface` 实色 + 1px `--line` 分隔 |
| 标签页 `.btab.active` | `--accent-fill` 实色填充,无描边(圆角 chip,见 5.5) |
| 输入框 / 文本域 / 下拉 | `--glass-bg-inset` 内嵌实色槽 + `--line` 描边,焦点环 2px `--accent-soft` |
| 弹窗 / 菜单 / 下拉 | `--pop-bg` 实色 + `--line` 描边 + `--glass-shadow` |
| chip / badge(非按钮) | 允许胶囊形状 + 实色小标签 + 描边 |
| 卡片 | `--glass-bg` 实色 + `--line` 描边;选中 = `--accent-fill` |
| 终端 xterm | **例外**:底取主题最深端(`--xterm-bg`),保证内容对比度 |

移动端:`<768` 弹窗全屏化;断点与 `App.scss` / `useMediaQuery.ts` 保持一致
(`<768 phone` / `768–1279 tablet` / `≥1280 desktop`)。

### 5.4 滚动条(全站一套)

规格只有一处:`web/src/styles.scss` 的「滚动条:全站唯一规格」。
色值仍来自 6 色派生(`--scroll-thumb` / `--scroll-thumb-hover` / `--scroll-thumb-x`,见 2.1)。

| 项 | 值 |
|---|---|
| 视觉拇指 | `--scroll-size` = 4px,`--r-pill` 胶囊圆角,轨道透明 |
| 覆盖式拇指间距 | `--scroll-gap` = 2px(引擎 `scrollbar-ui.ts` 悬浮拇指离容器内边缘) |
| 原生例外条宽 | `--scroll-bar` = 6px(4px 拇指 + 左右各 1px 透明边) |
| 内容侧留白 | `--scroll-gutter` = 6px(内容会被悬浮拇指压住的容器加 `padding-right`) |
| 原生例外 | 只有 xterm / `textarea` / `.md table` / `.fviewer .cm-scroller`;必须写 `scrollbar-width: auto`,写成 `thin` 会切回平台滚动条(实测 10px),就又变成第二套 |
| 故意隐藏原生条 | 标签条、附件轨道、触摸横滑区等横向手势容器(各有交互理由,见各处注释) |
| 横向滚轮 | 标签条等横向容器溢出时,鼠标滚轮直接横移;主标签条与右栏标签条使用同一行为 |

新增滚动容器时默认什么都不用写(原生条已全局隐藏、拇指由引擎按同一规格绘制);
只有「内容贴右边缘、且右端有圆角/描边/悬停底色」的列表,才需要
`padding-right: var(--scroll-gutter)`,否则滚动时拇指会压在内容上。

### 5.5 标签条(Tabs)

顶部主标签条 `.tabstrip` 与右栏 dockkit `.tabStrip` **共用同一套规格**,
改一处必须同步另一处,不允许再出现第二套标签形状:

| 项 | 规格 |
|---|---|
| 行高 | 40px = 6px 上留白 + 28px 标签 + 6px 下留白 |
| 内边距 | `6px 10px`(上下 6、左右 10,四周对称;右栏可用 `--dsh-dockkit-strip-inline-start` 单独加起始位) |
| 标签 chip | 高 28px;主标签条 `min-width: 80px / max-width: 170px`,右栏按内容收缩;`padding: 0 10px`;圆角 `--r-sm`;字号 13px / 行高 1 |
| 静止 / 悬浮 | 透明底 + `--text-2`;悬浮 `--hover-bg-hard` |
| 选中 | `--text` + `--accent-fill` 实心填充;**不再加 `--accent-border` 描边** |
| 分隔槽 | 标签间距 4px;每标签左侧 -5.25px 处 0.5px × 14px `--line-strong` 发丝线;首标签、激活标签两侧、固定段/滚动段交界按现有规则隐去 |
| 关闭钮 | 20×20,绝对定位 `top/right: 4px`;仅悬停 / 键盘聚焦 / 激活 / dirty 时出现(移动端与触屏常显);标签文字用 mask 在右侧淡出 |
| 固定段 / 滚动段 | 固定页永远显示且不可拖/不可关;文件 / 浏览器标签在滚动段内拖拽排序、可关闭;原生滚动条隐藏,溢出时滚轮横移 |
| 右栏 | 新增 / 分屏 / 关闭栏等 chrome 控件同为 28px;浮动面板头部复用同一行 |

**禁止**:回到「上圆角 `--r-sm --r-sm 0 0` + 下边框」的旧页签形状;禁止给标签加投影;
禁止让主标签条与右栏标签条出现两套行高/内边距。

### 5.6 Tooltip

全站只有一套 tooltip 皮肤:项目组件用 `data-tip`,由 `components/Tooltip/Tooltip.tsx`
的 `TooltipHost` 渲染 `.tip-host`;dsh 基础组件用 `Tooltip` 组件,但视觉必须映射到
同一组 token 与几何,不允许另起一套「dsh 风格」气泡。

| 项 | 规格 |
|---|---|
| 背景 / 文字 | `--pop-bg-strong` / `--text` |
| 描边 / 圆角 | `1px solid var(--line)` / `--r-sm` |
| 投影 | `--glass-shadow` |
| 内边距 / 字号 | `6px 10px` / `12px`,`line-height: 1.5` |
| 最大宽度 | `min(320px, 80vw)` |
| 层级 | 常规 500;portal 到 body 的浮层提示 1100 |
| 动效 | 140ms 淡入;不弹跳、不缩放 |

### 5.7 桌面壳右键菜单

桌面端(WebView2)默认自带一套原生右键菜单,会和前端自绘的 `.ctxmenu` 叠成两层。
Tauri 启动时必须关闭 WebView2 默认菜单(见 `src-tauri/src/lib.rs` 的
`SetAreDefaultContextMenusEnabled(false)`),全站只保留 `.ctxmenu` / dsh `Menu` 这一套自绘菜单。
新增窗口或 webview 时也要应用同一设置;禁止再引入第二套原生菜单。

---

## 六、例外(唯一)

以下两类颜色**不参与 6 色派生**,因为它们是「内容着色」而非界面着色,
强行收敛会让代码 / 终端无法阅读:

1. **终端 ANSI 色板**:`ConsolePanel.tsx` / `AiTermPanel.tsx` / `dsh/ui-sidebar-terminal` 的
   xterm `theme` 与 `--dsw-static-blue-*`。
2. **代码语法高亮**:`dsh-shiki.scss` 的 `--shiki-token-*` 色板。

除此之外,`--dsw-static-neutral-00` / `--dsw-static-neutral-bluish-300`
(文件类型图标的字形与图标色)同属内容标识,保留固定值;
`--dsw-static-*` 中**当表面/文字使用**的条目已全部改走主题 token。

> 说明:`mask-image` 里的 `#000` 只作为 alpha 遮罩,不是界面颜色;
> `ModelMenu` 的提供商色点 `hsl(var(--h) ...)` 是模型身份色,属于内容标识。
> 这两类不参与 6 色派生,也不算硬编码 UI 色。

---

## 七、性能红线

1. 禁止 `backdrop-filter`(全站已清零,`--blur-*` 统一为 `none`)。
2. 页面背景只有一层**静态**强调色顶光,不做动画。
3. 动画只用 `transform` / `opacity` / `background-color`;禁止 animate `width` / `top` / `left`。
4. 全部动效遵守 `prefers-reduced-motion`。

---

## 八、验收清单(新组件合并前自查)

> 先跑 `npm run check:design`。它会机械校验未定义 token、`backdrop-filter`、`text-shadow`、
> 外发光、纯黑遮罩和裸圆角;剩下的对比度 / 层级 / 视觉判断仍按下面清单人工过一遍。

- [ ] 没有任何硬编码色值,颜色全部来自 CSS 变量
- [ ] 没有未定义 token(`--bg` / `--bg-elev` 等);`var()` 的变量都在 `styles.scss` 或 `themes.ts` 有定义
- [ ] 按钮形状统一:6px 圆角 + `--line` 描边(标签 chip 按 5.5,另有 3 处结构件例外)
- [ ] 悬浮/按下用半透明 scrim,且与静止态底色差值 ΔRGB ≥ 12(不能"悬浮等于没有")
- [ ] 列表行的悬停底色挂在**行容器**上;行内主区与次要操作 `background: transparent` 且盒模型一致(同高、同为 6px 圆角)
- [ ] 对话框 / 设置面板本体抬到浮层档,且内部阶梯已**整体跟着上移**(不能只改本体底色)
- [ ] 弹窗与背后被压暗的页面差值 ΔRGB ≥ 20(深色主题实测 25;低于这个数看着像"蒙层上挖了个洞")
- [ ] 同一屏的中性底色档位收敛(设置面板目标 ≤ 5 档),"选中菜单项"与"选中卡片"同档
- [ ] 浮层作用域内的文字色族(尤其 `--muted` / `--text-faint`)跟着本体重算过,没有掉到 4.5:1 以下
- [ ] 面板内**没有**比容器更暗的整块区域(反向下沉的区块 / 列)
- [ ] 同一排操作按钮里,普通按钮与危险按钮**同底色**,语义只靠文字色
- [ ] 强调色只出现一次:同一元素不同时叠「accent 填充 + accent 文字 + accent 描边」
- [ ] 语义色当文字用时取 `--red / --green`(已按方向校准),不是品牌原色 `-raw`
- [ ] 没有 `backdrop-filter` / 内高光(`--glass-hi`) / 外发光(`0 0 Npx`)/ `text-shadow` 光晕
- [ ] 表面底色没有可见的多段渐变;gradient 仅用于 mask / 单色叠加 / 1px 状态线 / 加载扫光 / 品牌字标
- [ ] 圆角取自 `--r-sm / --r-md / --r-lg / --r-pill`;除 1–5px 微圆角(行内 code / keycap / 进度条 / 选区 / ≤24px 图标盒)、50% 圆点 / 头像、非按钮 chip 999px 外没有裸数值
- [ ] 字号 / 间距优先取 `--fs-*` / `--space-*`;全局层 z-index 取 `--z-*`,组件内部局部层才允许 1–20 裸值
- [ ] 标签条主 / 右栏一致:40px 行高、`6px 10px` 内边距、28px chip、溢出时滚轮可横移
- [ ] tooltip 只有 `.tip-host` 一套皮肤,dsh Tooltip 与项目 tooltip 的 token / 几何一致
- [ ] 桌面端右键只有自绘 `.ctxmenu`,WebView2 默认菜单已关闭
- [ ] 投影只出现在浮层,且用 `--glass-shadow*`
- [ ] hover / active / focus 三态齐全
- [ ] 文字对比度 ≥ 4.5:1(终端与代码区除外)
- [ ] 深色与浅色两套预设下都检查过(至少 `ink` 与 `paper`)
- [ ] 移动端 `<768` 的折叠规则已显式写出
