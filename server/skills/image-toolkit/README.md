# image-toolkit

给 AI(和人)用的本地图片处理工具:**一个 Python 文件、零联网、一条命令做一件事**。

```bash
python imgtool.py compress -i hero.png --target-size 150KB   # 压到 150KB 以内
python imgtool.py removebg -i product.jpg -o cut.png         # 抠图去背景
python imgtool.py compare  -i old.png new.png                # 前后对比图
```

`imgtool.py` 只依赖 Pillow(本机已装),不需要 Node/浏览器/外部服务;`numpy`/`scipy` 是可选加速项,
缺失时抠图自动退化为全图色键并给出提示;`rembg` 仅在显式 `--method rembg` 时才会用到。

## 安装位置

| 位置 | 路径 | 作用 |
| --- | --- | --- |
| 内置技能库(权威源码) | `<仓库>/server/skills/image-toolkit/` | 随项目走,构建时打包进桌面版 `resources/server/skills/` |
| 本机用户级副本 | `C:\Users\30653\.agents\skills\image-toolkit\` | 跨项目/跨工作区可用,`baseDir` 是真实路径,优先级高于内置 |

技能由 harness 自动扫描(见 `server/agent/tools.ts` 的六来源技能发现),模型在技能目录里看到
`image-toolkit` 后即可按 `SKILL.md` 的指引调用脚本 —— 不需要用户手动指定。

改完源码后同步到用户级副本:

```cmd
xcopy /Y /E "server\skills\image-toolkit" "C:\Users\30653\.agents\skills\image-toolkit\"
```

## 文件

| 文件 | 说明 |
| --- | --- |
| `SKILL.md` | 技能说明(模型读这个决定怎么调用) |
| `scripts/imgtool.py` | 全部实现,单文件 |
| `scripts/selftest.py` | 回归自测:自造素材跑通全部命令 + 像素级断言 |

## 命令

```
环境    doctor
分析    info  exif  palette  diff  base64
几何    resize  crop  trim  rotate  flip  pad  round
体积    compress  convert  thumbnail  strip  favicon
调色    adjust  filter
抠图    removebg  transparent
合成    watermark  collage  compare  grid  overlay
生成    placeholder  gif  frames
```

每个命令的完整参数:`python imgtool.py <命令> --help`。

### 三条硬约定

1. **默认不覆盖输入**。不给 `-o` 时输出到原目录并加后缀(`a.png` → `a_compressed.png`);
   要原地覆盖必须显式 `--inplace`(工具会拒绝"输出路径等于输入路径"的隐式覆盖)。
2. **任何命令都支持批量**。`-i` 接收多个文件、目录或通配符;多输入时 `-o` 一律当目录(自动创建)。
3. **输出即契约**。每条命令输出一行 JSON:`{ok, count, results:[{input,output,width,height,bytes,bytes_in,saved_pct,ms}], warnings?, errors?}`,
   失败时退出码非 0、`error` 里是人话(不抛堆栈),`hint` 指向 `--help`。

### 抠图说明

`removebg` 的默认算法是「边界连通泛洪」:从四边向内泛洪,只把**与图像边界连通**的背景色抠掉,
因此画面内部与背景同色的色块不会被误伤(优于全图色键)。参数:

- `--tolerance 30` — 颜色容差,越大抠得越狠
- `--bg-color auto` — 默认取四边条带的中位色,可显式指定
- `--method flood|global|rembg` — 边界连通 / 全图色键 / AI 模型(需 `pip install rembg onnxruntime`)
- `--feather 1.5` — 边缘羽化半径,配合软边阈值产生抗锯齿的 alpha;`--hard-edge` 则输出纯二值 alpha
- `--trim` — 抠完自动裁掉透明边

`scipy` 可用时用 `ndimage.label` 做精确连通域;不可用时退化为积分图倍增膨胀(矩形结构元近 8 邻接),
结果会写明 `method` 与 `removed_pct`,抠得过头(>99% 被移除)时返回 `warnings` 提示调参。

## 自测

```bash
python scripts/selftest.py            # 63 项断言,含像素级校验(四角透明、区域外未改动、体积达标…)
python scripts/selftest.py --keep     # 保留产物,便于肉眼检查
```

自测不依赖任何外部图片,素材由 `placeholder` 自造,可在任意机器/CI 上跑。
