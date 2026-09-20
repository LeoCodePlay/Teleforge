---
name: image-toolkit
description: 本地图片处理工具箱(纯 Pillow、离线、单文件 CLI)。凡是要对图片文件做加工——压缩体积、改尺寸、裁剪、抠图去背景、转格式(PNG/JPG/WebP/AVIF)、加水印、圆角头像、拼接对比图、九宫格切图、生成占位图、提取主色、读 EXIF、转 base64——都用这里的 imgtool.py 一条命令完成,不要临时写图像脚本或用 GUI 工具。支持目录批量。
---

# image-toolkit(图片处理,一条命令搞定)

处理任何图片文件时,先用本技能的 `imgtool.py`,而不是现写 Python/PIL 代码或调用画图软件。
一个命令做一件事,结果是一行 JSON,失败会给出可执行的修复建议。

## 先确定脚本路径

脚本位于本技能目录的 `scripts/imgtool.py`。技能 base dir 可能是 `builtin://image-toolkit`
这种伪路径,此时按顺序取第一个存在的真实路径:

1. `C:\Users\30653\.agents\skills\image-toolkit\scripts\imgtool.py` (本机用户级安装,固定)
2. `<仓库根>\server\skills\image-toolkit\scripts\imgtool.py` (源码运行时)
3. `<安装目录>\resources\server\skills\image-toolkit\scripts\imgtool.py` (打包版)

依赖自检(缺东西它会直接说要装什么):

```bash
python "C:\Users\30653\.agents\skills\image-toolkit\scripts\imgtool.py" doctor
```

要求 Python 3 + Pillow(本机已就绪,无需安装)。下文用 `imgtool` 代指上面这条完整调用。

## 命令速查

| 需求 | 命令 |
| --- | --- |
| 看图(尺寸/格式/透明/主色/EXIF) | `imgtool info -i a.png --colors 5` |
| 压缩到指定体积 | `imgtool compress -i a.png --target-size 200KB` |
| 压缩到指定质量 | `imgtool compress -i a.png --quality 70` |
| 缩放 | `imgtool resize -i a.png --max-side 1600` (或 `--width/--height/--size 800x600/--percent 50`) |
| 裁剪 | `imgtool crop -i a.png --aspect 1:1` (或 `--box 10,20,310,420` / `--size 200x200 --position top-left`) |
| 裁掉多余白边 | `imgtool trim -i a.png` |
| 旋转/翻转 | `imgtool rotate -i a.png --angle 90` / `imgtool flip -i a.png --direction h` |
| 扩边/纯色背景 | `imgtool pad -i a.png --pad 40 --background "#f5f5f5"` |
| 圆角/圆形头像 | `imgtool round -i a.png --circle` (或 `--radius-percent 12`) |
| 抠图去背景 | `imgtool removebg -i a.png -o cut.png` |
| 指定颜色变透明 | `imgtool transparent -i a.png --color "#ffffff"` |
| 转格式 | `imgtool convert -i a.png --format webp` |
| 缩略图 | `imgtool thumbnail -i a.png --max-side 320 --format webp` |
| 清 EXIF(隐私) | `imgtool strip -i a.jpg` |
| 生成 favicon | `imgtool favicon -i logo.png --png-dir icons/` |
| 调色 | `imgtool adjust -i a.png --brightness 1.1 --saturation 1.3 --auto-contrast` |
| 滤镜 | `imgtool filter -i a.png --preset grayscale` (sepia/blur/sharpen/emboss/edge/posterize…) |
| 打码/局部模糊 | `imgtool filter -i a.jpg --preset pixelate --pixel-size 14 --box 120,80,420,300` |
| 加文字水印 | `imgtool watermark -i a.jpg --text "© 2026 某某" ` |
| 平铺水印 | `imgtool watermark -i a.jpg --text DRAFT --tile --angle 30 --opacity 0.25` |
| 贴 logo | `imgtool watermark -i a.jpg --image logo.png --scale 0.15 --position top-left` |
| 多图拼接 | `imgtool collage -i a.png b.png c.png --layout h --gap 12` (`--layout grid --cols 2 --cell 400x300`) |
| 前后对比图 | `imgtool compare -i before.png after.png [--layout tb]` |
| 九宫格切图 | `imgtool grid -i a.png --rows 3 --cols 3` |
| 叠加两张图 | `imgtool overlay -i base.png logo.png --scale 0.2 --position bottom-right` |
| 生成占位图/渐变图 | `imgtool placeholder --size 800x600 --text "封面"` / `--gradient "#ff0066,#3300ff"` |
| 合成 GIF / 拆帧 | `imgtool gif -i f1.png f2.png -o a.gif --duration 300` / `imgtool frames -i a.gif` |
| 主色板 | `imgtool palette -i a.png --count 6` |
| 两图差异(是否一致) | `imgtool diff -i a.png b.png [--align]` |
| 图片编码 | `imgtool base64 -i a.png --preview` (默认输出完整 DataURI) |

任何命令都能批量:把 `-i` 指向目录或通配符,例如 `imgtool compress -i ./images --target-size 300KB -o ./out`。

## 参数写法

- 尺寸:`800x600`;体积:`200KB` / `1.5MB` / `500000`;颜色:`#fff`、`#ffffff80`、`white`、`255,255,255`、`transparent`
- 位置:`center`、`top-left`、`bottom-right`、`top`、`left`… 或绝对坐标 `x,y`
- 区域(滤镜/打码):`左,上,右,下`
- 数值型强度:1.0 = 原样,`--brightness 1.2` 更亮,`--saturation 0` 变灰

## 输出与安全约定(很重要)

- 每条命令输出一行 JSON:`{"ok":true,"count":1,"output":"...","results":[{input,output,width,height,bytes,bytes_in,saved_pct,ms}]}`;
  失败时 `ok:false` + `errors[]`,退出码非 0。加 `--pretty` 缩进。
- **默认不覆盖输入**:不给 `-o` 时输出到原目录并加后缀(`a.png` → `a_compressed.png`)。
  确实要原地覆盖才用 `--inplace`(会改原文件,谨慎)。
- 多个输入时 `-o` 一律当目录(不存在会自动创建)。
- 抠图/圆角的产物默认 PNG(要透明通道);输出 jpg 会自动铺底色,可用 `--background "#438edb"` 换。

## 常见场景配方

```bash
# 网页配图瘦身(体积优先,自动选质量)
imgtool compress -i hero.png --format webp --target-size 150KB --max-side 1920

# 商品图/人像抠白底并裁掉空边
imgtool removebg -i product.jpg -o cut.png --trim

# 证件照换底色(先抠图,再铺蓝底转 jpg)
imgtool removebg -i id.jpg -o /tmp/id.png
imgtool convert -i /tmp/id.png --format jpg --background "#438edb" -o id_blue.jpg

# 头像:居中裁方 + 圆形 + 缩到 256
imgtool round -i face.jpg --circle -o avatar.png
imgtool thumbnail -i avatar.png --max-side 256

# 整目录截图批量转 WebP 并限制宽度
imgtool convert -i ./shots --format webp --quality 80 -o ./out
imgtool resize -i ./out --max-width 1440 --inplace

# 改版前后对比图(带 BEFORE/AFTER 标签)
imgtool compare -i old.png new.png --layout lr --labels "改前,改后"

# 给截图里的手机号打码
imgtool filter -i shot.png --preset pixelate --pixel-size 16 --box 520,300,760,340
```

## 注意

- 抠图默认 `--method flood`:只抠掉**与四边连通**的背景色,画面内部的同色块会保留(比全体色键准)。
  纯色/浅色背景直接可用;背景复杂时调 `--tolerance`(默认 30,越大抠得越狠)、指定 `--bg-color`,
  或用 `--method global`(整图该色都去掉)。要 AI 模型级效果用 `--method rembg`,但需另装
  `pip install rembg onnxruntime`(首次会下模型),默认不依赖它。
- 抠完若结果几乎全透明,JSON 里会出现 `warnings` 提示容差过大 —— 照提示调小。
- 动图(GIF/WebP)除 `gif`、`frames` 外只处理第 1 帧。
- 命令细节随时可查:`imgtool <命令> --help`。
