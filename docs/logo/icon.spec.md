# Teleforge 图标 / 标识系统规范(v0.1)

> 配套产物:`icon.manifest.json`(方案清单)、`icon.sprite.svg`(可复用 symbol)、
> `concepts/ tiles/ lockups/`(SVG 成品)、`canvas.icon.demo.js`(动效起步模板)。
> 改几何只改 `build-logos.mjs`,然后 `node docs/logo/build-logos.mjs` 全量重出。

## 1. 什么时候用 SVG,什么时候用 Canvas

| 场景 | 选择 | 理由 |
| --- | --- | --- |
| 界面图标、favicon、应用图标、导航/状态标识 | **SVG** | 可缩放、可换色(一个 `currentColor` 顶一套位图)、体积极小 |
| 品牌标识、字标组合、文档头图 | **SVG** | 任意倍率清晰,可无损转轮廓 |
| 加载态、关于页 hero、连接脉冲这类**每帧都在重绘**的图形 | **Canvas**(`canvas.icon.demo.js`) | 元素少但刷新率高时,Canvas 免去 DOM/样式重算 |
| 需要像素级处理(模糊、发光叠加、离屏合成) | **Canvas** | SVG 滤镜在这些场合更贵且跨浏览器不一致 |

判定口径:**静态形状用 SVG;同一形状每帧变化才考虑 Canvas**。两条链路用的是同一套几何常量
(64 网格 / 描边 6 / 全圆角端点 / 光学方框 46),所以 SVG 与 Canvas 混用时不会走形。

## 2. 网格与光学方框(最重要的一条)

- 画布:`viewBox="0 0 64 64"`,所有坐标写在这个网格里。
- **光学方框:任一方案含描边后的墨迹范围收敛到 46×46、居中于 (32,32)**(允许 44–47 的浮动)。
  已实测:双向 T 44×41、隧道门 45×46.5、密钥熔炉 26.5×45、远程节点 45×45、双环互通 45×30、锻造火花 31×45.5。
  并排展示、缩到 16px、放进圆角底板时视觉重量一致,不需要逐个手工补偿。
- 描边宽度只用 5 / 5.5 / 6 三档;`stroke-linecap: round`、`stroke-linejoin: round` 全局统一。
- 形状本身即最终外形:**标体不加渐变、不加投影、不加内发光**——与产品「实色界面」一致;
  渐变只允许出现在应用图标底板上(底板不算标的一部分)。
- 反白/单色用法:把 `--c-fg`(标体)与 `--c-accent`(主色)换成同一颜色即可;
  `green`(连接点)在单色场景直接取标体色。

## 3. 调色板(取值来自 `web/src/theme/themes.ts`)

| 语义 | 深色底 | 浅色底 | 用途 |
| --- | --- | --- | --- |
| 底 `bg` | `#0d0f13` | `#f6f8fa` | 页面底 |
| 面 `surface` | `#16191f` | `#ffffff` | 面板 / 应用图标外框 |
| 标体 `fg` | `#e7eaf0` | `#1f2328` | 中性结构(竖杆、提示符) |
| 主色 `accent` | `#5b8cff` | `#0969da` | 品牌主色(方向、路径) |
| 连接 `green` | `#3fb26f` | `#1a7f37` | 「已连接」的语义点,不滥用 |

四套预设主题对应关系:墨黑 `#5b8cff`、石墨 `#2cc4b8`、暮色 `#e3a343`、纸白 `#0969da`。
标识默认按**墨黑 / 纸白**出资源;嵌进别的主题界面时,用 `--tf-accent` 覆盖主色即可,
不要重新画一套形状。

## 4. 尺寸、留白与最小尺寸

| 用途 | 尺寸 | 留白(四周至少) | 备注 |
| --- | --- | --- | --- |
| favicon | 16 / 32 | 1px | 优先「锻造火花」或「双向 T」 |
| 侧栏 / 顶栏 | 20 / 24 | 2px | sprite `<use>` 内联,`width/height` 由 CSS 控制 |
| 应用图标(桌面端) | 512(导出到 1024) | 12/64(≈19%) | 圆角 `rx=14/64 ≈ 22%`,标体内缩到 40/64 |
| 启动页 / 关于页 | ≥ 96 | 8/64 | 可叠动效 |
| 横版组合 | 高 ≥ 28 | — | 标高 42/64,字标 38px |

- **最小尺寸**:双向 T、隧道门、远程节点、双环互通、锻造火花 ≥ 16px;密钥熔炉 ≥ 24px(齿纹在更小尺寸会并线)。
- 任何尺寸都保持**等比缩放**,禁止单独拉伸;不要给标体加描边来「加粗」。

## 5. 横版组合(标 + 字标)

- 标:按光学方框缩到 42(网格内),视觉中心对齐字标的大写高度中心(基线 `y=54` @ 38px)。
- 字标:`Teleforge`,字重 600,字距 `-0.9`,大小 `38px`(随组合等比缩放)。
  字体族与界面一致(`--font-ui`),**生产环境请把字标转成轮廓**再交付给外部,避免缺字体变形。
- 标与字标的间距:光学方框右边缘到字标左边缘 8 单位(64 网格);不要贴死,也不要空出一个字宽。
- 竖版组合未定义;需要时按同一规则(间距 = 0.3×字标大写高度)由横版推导。

## 6. 命名规范

- 文件:`logo-<作用>-<方案>-<变体>.svg`,全小写、连字符;本目录沿用 `concepts/<slug>.svg`、
  `concepts/<slug>-light.svg`、`tiles/<slug>-tile.svg`、`lockups/<slug>-lockup[-light].svg`。
- 方案 slug 固定为:`dual-arrow-t`、`portal-bracket`、`key-flame`、`node-orbit`、`bridged-rings`、`forge-spark`。
- sprite id:`logo-<slug>`;CSS 变量:`--tf-accent` / `--tf-green`。
- 语义尺寸名:`icon-16` / `icon-24` / `icon-32` / `tile-512`;不要出现 `logo-final-v2-new` 这类名字。

## 7. 无障碍与对比度

- 每个 SVG 带 `role="img"` 与 `aria-label="Teleforge <方案名>"`;纯装饰场景加 `aria-hidden="true"`。
- 主色对深底的对比度:`#5b8cff` on `#0d0f13` ≈ 6.1:1;对浅底 `#0969da` on `#ffffff` ≈ 5.2:1,均满足正文级 AA(≥4.5:1)。
- 标体 `#e7eaf0` / `#1f2328` 对各自底色 ≈ 15–16:1,远高于 AA。
- 不要只靠颜色传达状态(「已连接」除绿点外还要有文字/图标),色盲场景下绿点与主色需保持形状差异。

## 8. 动效规范(走 Canvas)

- 允许的动效只有三种:**连接脉冲**(沿竖杆或轨道走一个小圆)、**轨道旋转**(远程节点)、**火花明灭**(透明度 0.75↔1)。
- 时长:一次循环 1.6–2.4s;缓动 `cubic-bezier(.4,0,.2,1)`(与界面 `--ds-ease-in-out` 一致)。
- 只动**局部**:标体结构不动,动的是「数据」这一层;不要在 logo 上做翻转、挤压、彩虹渐变。
- 尊重 `prefers-reduced-motion`:偏好减少动效时停在静态帧(模板里已处理)。
- 实现见 `canvas.icon.demo.js`;需要 CSS 场景时用 SVG + `stroke-dasharray` 走同一条曲线,时长/缓动取上面数值。

## 9. 导出与落地流程

1. 选定方案 → 改 `build-logos.mjs` 里的 `recommendation.primary`(可选),重跑生成。
2. 位图导出:`npx sharp-cli -i docs/logo/tiles/<slug>-tile.svg -o /tmp/tile-1024.png resize 1024 1024`,
   或任意 SVG→PNG 工具;favicon 直接导出 16/32/48。
3. 桌面端:`npm run desktop:icon`(`tauri icon`,读 `web/public/logo.png`)生成 `src-tauri/icons/` 全套平台尺寸。
4. 网页:`web/public/logo-{32,64,256}.png` 与 `web/index.html` 的 favicon 引用一起替换。
5. 页面内联图标优先用 `icon.sprite.svg` 的 symbol,不要贴重复的整份 SVG。

### 使用 sprite 的示例

```html
<!-- 先把 sprite 内联进页面(离线也可用),再用 <use> 引用 -->
<svg width="0" height="0" aria-hidden="true"><use href="#logo-dual-arrow-t" /></svg>
```

```html
<svg class="brand" width="24" height="24" aria-label="Teleforge">
  <use href="docs/logo/icon.sprite.svg#logo-dual-arrow-t" />
</svg>
```

## 10. Do / Don't

| Do | Don't |
| --- | --- |
| 用 5/6 描边与全圆角端点,和界面控件同一套手感 | 给标体加渐变、外发光、投影、玻璃质感 |
| 深色底用亮标体、浅色底换 `#1f2328`,一套几何 | 为浅色底重画一套形状 |
| 按 46 光学方框对齐、等比缩放 | 逐个方案手工调大小、非等比拉伸 |
| 在需要的尺寸导出 PNG(16/32/48) | 用 512 的位图缩到 16 当 favicon |
| 单色场景整体降为两色 | 单色时把绿色连接点单独留成彩色 |
