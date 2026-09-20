#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""imgtool —— 面向 AI 的本地图片处理 CLI(单文件 / 零联网 / 纯 Pillow)。

设计约束:
  * 一条命令做完一件事,参数直白,默认输出 JSON(便于程序/AI 解析)。
  * 绝不隐式覆盖输入文件(除非显式 --inplace)。
  * 缺依赖时给出可执行的修复命令,而不是堆栈。
  * 不联网:Pillow 完成全部处理;rembg 仅在显式 --method rembg 时可选调用。

快速开始:
  python imgtool.py doctor                    # 环境自检
  python imgtool.py info -i a.png             # 看图
  python imgtool.py compress -i a.png --target-size 200KB
  python imgtool.py removebg -i photo.jpg -o photo.png
  python imgtool.py --help                    # 全部命令
"""

from __future__ import annotations

import argparse
import base64 as _b64
import glob as _glob
import io as _io
import json
import math
import os
import re
import sys
import time
import warnings as _warnings
from pathlib import Path

VERSION = "1.0.0"

try:
    from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps, ImageStat
except ImportError as _exc:  # 唯一硬依赖
    sys.stdout.write(json.dumps({
        "ok": False,
        "error": "缺少 Pillow(%s)。请先安装: pip install pillow" % _exc,
    }, ensure_ascii=False) + "\n")
    raise SystemExit(3)

try:
    import numpy as _np
except Exception:  # pragma: no cover - numpy 只是加速项
    _np = None

try:
    from scipy import ndimage as _ndi
except Exception:  # pragma: no cover - scipy 只用于精确连通域
    _ndi = None

try:
    from PIL import features as _features
except Exception:  # pragma: no cover
    _features = None


# ============================================================ 基础工具

IMAGE_EXTS = {
    ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".bmp", ".gif", ".tif", ".tiff",
    ".avif", ".ico", ".ppm", ".pgm", ".pnm", ".jp2", ".j2k", ".tga", ".dds", ".pcx",
}

FMT_ALIASES = {
    "jpg": "JPEG", "jpeg": "JPEG", "jpe": "JPEG", "jfif": "JPEG",
    "png": "PNG", "webp": "WEBP", "avif": "AVIF", "gif": "GIF", "bmp": "BMP",
    "tif": "TIFF", "tiff": "TIFF", "ico": "ICO", "pdf": "PDF", "jp2": "JPEG2000",
    "ppm": "PPM", "pgm": "PPM", "pnm": "PPM", "tga": "TGA", "pcx": "PCX", "dds": "DDS",
}

FMT_EXT = {
    "JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "AVIF": ".avif", "GIF": ".gif",
    "BMP": ".bmp", "TIFF": ".tiff", "ICO": ".ico", "PDF": ".pdf", "JPEG2000": ".jp2",
    "PPM": ".ppm", "TGA": ".tga", "PCX": ".pcx", "DDS": ".dds",
}

ALPHA_FORMATS = {"PNG", "WEBP", "AVIF", "GIF", "TIFF", "ICO"}

RESAMPLE = {
    "nearest": Image.Resampling.NEAREST, "box": Image.Resampling.BOX,
    "bilinear": Image.Resampling.BILINEAR, "hamming": Image.Resampling.HAMMING,
    "bicubic": Image.Resampling.BICUBIC, "lanczos": Image.Resampling.LANCZOS,
}

# 中文优先的字体候选(水位印/标签要能渲染中文)
FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/msyhl.ttc", "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc", "C:/Windows/Fonts/Deng.ttf",
    "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf",
    "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


class ToolError(Exception):
    """参数/环境类错误:只回一句人话,不抛堆栈。"""


def emit(payload, pretty=False):
    text = json.dumps(payload, ensure_ascii=False, indent=2 if pretty else None, default=str)
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


def human_bytes(n):
    n = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return ("%.0f%s" if unit == "B" else "%.1f%s") % (n, unit)
        n /= 1024.0


def parse_bytes(v):
    """'200KB' / '1.5MB' / '500000' / '30k' → 字节数。"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip().lower().replace(" ", "")
    m = re.fullmatch(r"([0-9]*\.?[0-9]+)\s*(b|kb|k|mb|m|gb|g|kib|mib)?", s)
    if not m:
        raise ToolError("无法解析体积: %s(示例: 200KB、1.5MB、500000)" % v)
    n = float(m.group(1))
    unit = m.group(2) or "b"
    mult = {"b": 1, "k": 1024, "kb": 1024, "kib": 1024,
            "m": 1024 ** 2, "mb": 1024 ** 2, "mib": 1024 ** 2,
            "g": 1024 ** 3, "gb": 1024 ** 3, "gib": 1024 ** 3}[unit]
    return int(n * mult)


def parse_size(v):
    """'800x600' / '800*600' / '800,600' / '800 600' → (w, h)。"""
    if v is None:
        return None
    if isinstance(v, (tuple, list)):
        return (int(v[0]), int(v[1]))
    nums = re.findall(r"\d+", str(v))
    if len(nums) < 2:
        raise ToolError("无法解析尺寸: %s(示例: 800x600)" % v)
    return (int(nums[0]), int(nums[1]))


def parse_color(v, default=None):
    """'#fff' / '#rrggbbaa' / '255,0,0' / 'rgb(1,2,3)' / 'white' / 'transparent' → RGBA。"""
    if v is None:
        return default
    if isinstance(v, (tuple, list)):
        t = tuple(int(x) for x in v)
        return t if len(t) == 4 else (t[0], t[1], t[2], 255)
    s = str(v).strip().lower()
    named = {
        "white": (255, 255, 255, 255), "black": (0, 0, 0, 255), "red": (255, 0, 0, 255),
        "green": (0, 128, 0, 255), "blue": (0, 0, 255, 255), "gray": (128, 128, 128, 255),
        "grey": (128, 128, 128, 255), "yellow": (255, 255, 0, 255), "orange": (255, 165, 0, 255),
        "purple": (128, 0, 128, 255), "pink": (255, 192, 203, 255), "cyan": (0, 255, 255, 255),
        "magenta": (255, 0, 255, 255), "transparent": (0, 0, 0, 0), "none": (0, 0, 0, 0),
    }
    if s in named:
        return named[s]
    if s.startswith("#"):
        h = s[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h) + "ff"
        elif len(h) == 4:
            h = "".join(c * 2 for c in h)
        elif len(h) == 6:
            h += "ff"
        if len(h) != 8 or not re.fullmatch(r"[0-9a-f]{8}", h):
            raise ToolError("无法解析颜色: %s" % v)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16))
    nums = re.findall(r"-?\d+", s)
    if len(nums) in (3, 4):
        vals = [max(0, min(255, int(n))) for n in nums]
        return tuple(vals + [255]) if len(vals) == 3 else tuple(vals)
    raise ToolError("无法解析颜色: %s(支持 #rgb/#rrggbb/#rrggbbaa、r,g,b[,a]、white/black/…、transparent)" % v)


POS_ALIASES = {
    "center": ("center", "center"), "centre": ("center", "center"), "c": ("center", "center"),
    "top": ("center", "top"), "t": ("center", "top"),
    "bottom": ("center", "bottom"), "b": ("center", "bottom"),
    "left": ("left", "center"), "l": ("left", "center"),
    "right": ("right", "center"), "r": ("right", "center"),
    "top-left": ("left", "top"), "tl": ("left", "top"), "left-top": ("left", "top"),
    "top-right": ("right", "top"), "tr": ("right", "top"), "right-top": ("right", "top"),
    "bottom-left": ("left", "bottom"), "bl": ("left", "bottom"), "left-bottom": ("left", "bottom"),
    "bottom-right": ("right", "bottom"), "br": ("right", "bottom"), "right-bottom": ("right", "bottom"),
}


def parse_pos(v, default="center"):
    """位置 → ('center','bottom') 之类的锚点,或 ('x=12','y=34') 形式的绝对偏移。"""
    if v is None:
        v = default
    s = str(v).strip().lower()
    if s in POS_ALIASES:
        return POS_ALIASES[s]
    nums = re.findall(r"-?\d+", s)
    if len(nums) >= 2:
        return ("x=%d" % int(nums[0]), "y=%d" % int(nums[1]))
    raise ToolError("无法解析位置: %s(支持 center/top-left/bottom-right/… 或 'x,y')" % v)


def anchor_offset(canvas, box, anchor):
    """把 box 尺寸按锚点放进 canvas 尺寸,返回左上角坐标。"""
    cw, ch = canvas
    bw, bh = box
    h, v = anchor
    if h.startswith("x="):
        x = int(h[2:])
    else:
        x = 0 if h == "left" else (cw - bw if h == "right" else (cw - bw) // 2)
    if v.startswith("y="):
        y = int(v[2:])
    else:
        y = 0 if v == "top" else (ch - bh if v == "bottom" else (ch - bh) // 2)
    return int(x), int(y)


_FONT_CACHE = {}


def load_font(size, font_path=None):
    size = max(6, int(size))
    key = (size, font_path)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    cands = [font_path] if font_path else FONT_CANDIDATES
    for c in cands:
        try:
            if c and Path(c).exists():
                f = ImageFont.truetype(c, size)
                _FONT_CACHE[key] = f
                return f
        except Exception:
            continue
    try:
        f = ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        f = ImageFont.load_default()
    _FONT_CACHE[key] = f
    return f


# ============================================================ 图像读写

def normalize_format(v):
    if not v:
        return None
    s = str(v).strip().lstrip(".").lower()
    if s in FMT_ALIASES:
        return FMT_ALIASES[s]
    up = s.upper()
    if up in FMT_EXT or up in ("JPEG", "PNG", "WEBP", "AVIF", "GIF", "BMP", "TIFF", "ICO", "PDF"):
        return "JPEG" if up == "JPG" else up
    raise ToolError("不支持的格式: %s(可选 %s)" % (v, "/".join(sorted(set(FMT_ALIASES)))))


def open_image(path, auto_orient=True):
    p = Path(path)
    if not p.is_file():
        raise ToolError("文件不存在: %s" % p)
    try:
        im = Image.open(p)
        im.load()
    except Exception as exc:
        raise ToolError("无法打开图片 %s: %s" % (p.name, exc))
    if auto_orient:
        try:
            im = ImageOps.exif_transpose(im) or im
        except Exception:
            pass
    return im


def flatten(im, bg=(255, 255, 255, 255)):
    """把带透明的图压到不透明底色上(JPEG/PDF 等不支持 alpha 的格式用)。"""
    bg = parse_color(bg, (255, 255, 255, 255))
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        base = Image.new("RGBA", rgba.size, bg)
        base.alpha_composite(rgba)
        return base.convert("RGB")
    if im.mode in ("RGB", "L"):
        return im
    return im.convert("RGB")


def ensure_alpha(im):
    if im.mode == "RGBA":
        return im
    if im.mode == "P":
        return im.convert("RGBA")
    if im.mode in ("LA", "PA"):
        return im.convert("RGBA")
    return im.convert("RGBA")


def _apply_format(im, fmt, *, quality=None, background=None, optimize=True, colors=256,
                  dpi=None, method=6, compress_level=None, subsampling=None, lossless=False):
    """把图像调整成目标格式可接受的样子,并给出 save kwargs。"""
    kw = {}
    if fmt == "JPEG":
        im = flatten(im, background or (255, 255, 255, 255))
        kw["quality"] = int(quality if quality is not None else 85)
        kw["optimize"] = bool(optimize)
        kw["progressive"] = True
        if subsampling is not None:
            kw["subsampling"] = subsampling if subsampling in (0, 1, 2) else 2
    elif fmt == "PNG":
        if im.mode == "P":
            im = im.convert("RGBA" if "transparency" in im.info else "RGB")
        kw["optimize"] = bool(optimize)
        kw["compress_level"] = int(compress_level if compress_level is not None else 9)
    elif fmt == "WEBP":
        im = im if im.mode in ("RGB", "RGBA", "L", "LA") else ensure_alpha(im)
        kw["quality"] = int(quality if quality is not None else 82)
        kw["method"] = int(method)
        kw["lossless"] = bool(lossless)
    elif fmt == "AVIF":
        im = ensure_alpha(im)
        kw["quality"] = int(quality if quality is not None else 62)
        kw["speed"] = 6
    elif fmt == "GIF":
        kw["optimize"] = bool(optimize)
        im = im.convert("P", palette=Image.ADAPTIVE, colors=max(2, min(256, int(colors))))
    elif fmt == "BMP":
        im = ensure_alpha(im) if im.mode in ("RGBA", "LA", "P") else im
    elif fmt in ("TIFF",):
        kw["compression"] = "tiff_deflate"
    elif fmt == "ICO":
        kw["sizes"] = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    elif fmt == "PDF":
        im = flatten(im, background or (255, 255, 255, 255))
        kw["resolution"] = float(dpi or 150)
    elif fmt in ("JPEG2000",):
        kw["quality_mode"] = "rates"
        kw["quality_layers"] = [int(quality or 20)]

    if dpi and fmt in ("JPEG", "PNG", "TIFF"):
        kw["dpi"] = (float(dpi), float(dpi))
    return im, kw


def encode_image(im, format=None, *, fmt=None, keep_exif=False, keep_icc=True, quality=None,
                 background=None, lossless=False, optimize=True, colors=256, dpi=None,
                 method=6, compress_level=None, subsampling=None):
    """按格式编码到内存,返回 (bytes, warnings)。format 与 fmt 等价(两种写法都接受)。"""
    target = normalize_format(format) or normalize_format(fmt) or "PNG"
    exif = im.info.get("exif")
    icc = im.info.get("icc_profile")
    out, kw = _apply_format(im, target, quality=quality, background=background, optimize=optimize,
                            colors=colors, dpi=dpi, method=method, lossless=lossless,
                            compress_level=compress_level, subsampling=subsampling)
    if keep_exif and exif and target in ("JPEG", "WEBP", "TIFF", "PNG", "AVIF"):
        kw["exif"] = exif
    if keep_icc and icc and target in ("JPEG", "WEBP", "PNG", "AVIF", "TIFF"):
        kw["icc_profile"] = icc
    warns = []
    buf = _io.BytesIO()
    try:
        out.save(buf, format=target, **kw)
    except Exception as exc:
        buf = _io.BytesIO()
        try:
            out.save(buf, format=target)
        except Exception as exc2:
            raise ToolError("编码 %s 失败: %s" % (target, exc2))
        warns.append("部分参数不被该编码器支持,已用最简参数写入(%s)" % exc)
    return buf.getvalue(), warns


def save_image(im, path, *, format=None, fmt=None, keep_exif=False, keep_icc=True, **kw):
    """按扩展名/指定格式落盘,返回 (字节数, 警告列表)。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    target = normalize_format(format) or normalize_format(fmt) or normalize_format(path.suffix) or "PNG"
    data, warns = encode_image(im, target, keep_exif=keep_exif, keep_icc=keep_icc, **kw)
    try:
        path.write_bytes(data)
    except Exception as exc:
        raise ToolError("写入失败 %s: %s" % (path.name, exc))
    return len(data), warns


# ============================================================ 输入/输出规划

def collect_inputs(patterns):
    """展开输入:显式文件按书写顺序保留(允许同一张图引用两次),目录/通配符结果去重。"""
    out, seen = [], set()
    for pat in patterns or []:
        p = Path(str(pat))
        if p.is_file():
            out.append(p)
            continue
        files = []
        if p.is_dir():
            files = [f for f in sorted(p.rglob("*")) if f.is_file() and f.suffix.lower() in IMAGE_EXTS]
        elif any(ch in str(pat) for ch in "*?["):
            for m in sorted(_glob.glob(str(pat), recursive=True)):
                mp = Path(m)
                if mp.is_file() and mp.suffix.lower() in IMAGE_EXTS:
                    files.append(mp)
        else:
            raise ToolError("输入不存在: %s" % pat)
        for f in files:
            r = str(f.resolve())
            if r not in seen:
                seen.add(r)
                out.append(f)
    if not out:
        raise ToolError("没有匹配到任何图片文件(支持目录/通配符,扩展名: %s)" % "/".join(sorted(e.lstrip('.') for e in IMAGE_EXTS)))
    return out


def plan_outputs(inputs, args, suffix, ext=None):
    """决定每个输入的输出路径。规则:不覆盖输入;多输入时 -o 必须是目录。"""
    n = len(inputs)
    out = args.output
    inplace = bool(getattr(args, "inplace", False))
    if inplace and out:
        raise ToolError("--inplace 与 -o 不能同时使用")
    if inplace:
        return [(s, s) for s in inputs]

    out_dir = None
    out_file = None
    if out:
        op = Path(out)
        trailing = str(out).endswith(("/", "\\"))
        # 多个输入不可能写进同一个文件,此时 -o 一律当目录(不存在就创建)
        if op.is_dir() or trailing or n > 1:
            out_dir = op
        else:
            out_file = op
    pairs = []
    for src in inputs:
        if out_file is not None:
            dst = out_file
        else:
            e = ext if ext is not None else src.suffix
            if not e:
                e = ".png"
            name = "%s%s%s" % (src.stem, suffix or "", e)
            dst = (out_dir if out_dir is not None else src.parent) / name
        if dst.resolve() == src.resolve() and not inplace:
            raise ToolError("输出会覆盖输入文件: %s(如确实要覆盖请加 --inplace,或换个 -o)" % dst)
        if dst.exists() and getattr(args, "no_overwrite", False):
            i = 2
            while True:
                cand = dst.with_name("%s-%d%s" % (dst.stem, i, dst.suffix))
                if not cand.exists():
                    dst = cand
                    break
                i += 1
        pairs.append((src, dst))
    return pairs


def foreach(args, *, suffix, ext=None, fn, save_opts=None):
    """对每个输入跑 fn(im, ctx) → Image,统一保存与结果收集。"""
    inputs = collect_inputs(args.input)
    pairs = plan_outputs(inputs, args, suffix, ext)
    results = []
    for (src, dst) in pairs:
        t0 = time.time()
        try:
            im = open_image(src, auto_orient=not getattr(args, "no_auto_orient", False))
            ctx = {"src": src, "dst": dst, "args": args, "image": im}
            out_im = fn(im, ctx)
            if out_im is None:
                out_im = im
            prebuilt = ctx.get("_prebuilt")
            if prebuilt is not None:  # 命令已自行完成编码(如压缩到目标体积)
                data, warns = prebuilt
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(data)
                nbytes = len(data)
            else:
                opts = dict(save_opts or {})
                if callable(opts):
                    opts = opts(ctx)
                opts.setdefault("keep_exif", bool(getattr(args, "keep_exif", False)))
                if "quality" not in opts and getattr(args, "quality", None) is not None:
                    opts["quality"] = args.quality
                if getattr(args, "background", None) is not None and "background" not in opts:
                    opts["background"] = args.background
                nbytes, warns = save_image(out_im, dst, **opts)
            bin_ = src.stat().st_size if src.exists() else 0
            item = {
                "input": str(src), "output": str(dst),
                "width": out_im.width, "height": out_im.height, "mode": out_im.mode,
                "bytes": nbytes, "bytes_in": bin_,
                "saved_pct": (round((1 - nbytes / bin_) * 100) if bin_ else None),
                "ms": round((time.time() - t0) * 1000),
            }
            if ctx.get("_chosen"):
                item["chosen"] = ctx["_chosen"]
            if ctx.get("_extra_warnings"):
                warns = list(warns) + list(ctx["_extra_warnings"])
            if warns:
                item["warnings"] = warns
            results.append(item)
        except Exception as exc:
            results.append({"input": str(src), "error": "%s: %s" % (type(exc).__name__, exc)})
    return results


def summarize(results, extra=None):
    """统一结果封装:返回 (payload, 退出码)。部分失败也算失败(退出码 1)。"""
    ok = [r for r in results if not r.get("error")]
    bad = [r for r in results if r.get("error")]
    payload = {"ok": not bad, "count": len(ok), "failed": len(bad), "results": results}
    if extra:
        payload.update(extra)
    if len(ok) == 1:
        payload["output"] = ok[0].get("output")
    if bad:
        payload["errors"] = [{"input": b["input"], "error": b["error"]} for b in bad]
    return payload, (1 if bad else 0)


def dominant_colors(im, count=5):
    small = im.convert("RGB")
    if max(small.size) > 256:
        small = small.copy()
        small.thumbnail((256, 256))
    q = small.quantize(colors=max(2, min(256, count)))
    pal = q.getpalette() or []
    out = []
    total = small.width * small.height
    for cnt, idx in sorted(q.getcolors() or [], reverse=True)[:count]:
        rgb = tuple(pal[idx * 3:idx * 3 + 3]) or (0, 0, 0)
        out.append({"hex": "#%02x%02x%02x" % rgb, "rgb": list(rgb), "share": round(cnt / total, 4)})
    return out


def exif_dict(im):
    data = {}
    try:
        raw = im.getexif()
        for k, v in raw.items():
            try:
                data[str(Image.ExifTags.TAGS.get(k, k))] = v if isinstance(v, (int, float, str)) else str(v)
            except Exception:
                continue
    except Exception:
        pass
    return data


# ============================================================ 命令: 环境与信息

def cmd_doctor(args):
    feats = {}
    with _warnings.catch_warnings():
        _warnings.simplefilter("ignore")  # 未知 feature 名只会发 UserWarning,不该污染 JSON 输出
        for name in ("jpg", "jpg_2000", "zlib", "webp", "avif", "libtiff", "raqm", "freetype2", "lcms"):
            try:
                feats[name] = bool(_features.check(name)) if _features else None
            except Exception:
                feats[name] = None
    try:
        save_formats = sorted(set(Image.registered_extensions().values()))
    except Exception:
        save_formats = []
    fonts = [c for c in FONT_CANDIDATES if Path(c).exists()]
    rembg = False
    try:
        import rembg  # noqa: F401
        rembg = True
    except Exception:
        rembg = False
    payload = {
        "ok": True, "version": VERSION,
        "python": sys.version.split()[0],
        "pillow": Image.__version__,
        "numpy": getattr(_np, "__version__", None),
        "scipy": bool(_ndi),
        "rembg": rembg,
        "features": feats,
        "save_formats": save_formats,
        "usable_formats": sorted(FMT_ALIASES),
        "fonts": fonts[:4],
        "cwd": os.getcwd(),
        "note": "numpy/scipy 缺失不影响使用(抠图精度略降);rembg 仅在 --method rembg 时需要",
    }
    emit(payload, args.pretty)
    return 0


def cmd_info(args):
    inputs = collect_inputs(args.input)
    results = []
    for src in inputs:
        try:
            im = open_image(src, auto_orient=not args.no_auto_orient)
            item = {
                "input": str(src), "format": im.format or src.suffix.lstrip(".").upper(),
                "width": im.width, "height": im.height, "mode": im.mode,
                "bytes": src.stat().st_size, "size_human": human_bytes(src.stat().st_size),
                "has_alpha": im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info),
                "animated": bool(getattr(im, "n_frames", 1) > 1),
                "frames": int(getattr(im, "n_frames", 1)),
                "dpi": list(im.info.get("dpi") or []) or None,
                "aspect": round(im.width / im.height, 4) if im.height else None,
                "icc": bool(im.info.get("icc_profile")),
            }
            if args.colors:
                item["dominant_colors"] = dominant_colors(im, args.colors)
            ex = exif_dict(im)
            if ex:
                item["exif"] = ex
            if item["has_alpha"] and args.alpha_check:
                a = ensure_alpha(im).getchannel("A")
                item["has_transparent_pixels"] = bool(a.getextrema()[0] < 255)
            results.append(item)
        except Exception as exc:
            results.append({"input": str(src), "error": "%s: %s" % (type(exc).__name__, exc)})
    payload, rc = summarize(results)
    payload["cmd"] = "info"
    emit(payload, args.pretty)
    return rc


def cmd_exif(args):
    inputs = collect_inputs(args.input)
    results = []
    for src in inputs:
        try:
            im = open_image(src, auto_orient=False)
            results.append({"input": str(src), "exif": exif_dict(im) or {}})
        except Exception as exc:
            results.append({"input": str(src), "error": str(exc)})
    payload, rc = summarize(results)
    payload["cmd"] = "exif"
    emit(payload, args.pretty)
    return rc


def cmd_palette(args):
    inputs = collect_inputs(args.input)
    results = []
    for src in inputs:
        try:
            im = open_image(src)
            results.append({"input": str(src), "colors": dominant_colors(im, args.count)})
        except Exception as exc:
            results.append({"input": str(src), "error": str(exc)})
    payload, rc = summarize(results)
    payload["cmd"] = "palette"
    emit(payload, args.pretty)
    return rc


def cmd_diff(args):
    inputs = collect_inputs(args.input)
    if len(inputs) != 2:
        raise ToolError("diff 需要正好 2 张图: -i a.png b.png")
    a = open_image(inputs[0]).convert("RGBA")
    b = open_image(inputs[1]).convert("RGBA")
    note = None
    if a.size != b.size:
        if args.align:
            b = b.resize(a.size, Image.Resampling.LANCZOS)
            note = "尺寸不同,已把 B 缩放到 A 的尺寸后比较"
        else:
            emit({"ok": True, "cmd": "diff", "identical": False, "size_a": list(a.size),
                  "size_b": list(b.size), "note": "尺寸不同(加 --align 可先对齐再比较)"}, args.pretty)
            return 0
    diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    bbox = diff.getbbox()
    stat = ImageStat.Stat(diff)
    mean = sum(stat.mean) / 3.0
    ratio = None
    if _np is not None:
        arr = _np.asarray(diff.convert("L"), dtype=_np.uint8)
        ratio = float((arr > int(args.threshold)).mean())
    payload = {
        "ok": True, "cmd": "diff", "identical": bbox is None,
        "size": list(a.size), "mean_abs_diff": round(mean, 4),
        "changed_ratio": (round(ratio, 6) if ratio is not None else None),
        "threshold": args.threshold, "diff_bbox": list(bbox) if bbox else None,
    }
    if note:
        payload["note"] = note
    if args.output:
        vis = ImageOps.autocontrast(diff.convert("L"))
        if args.heatmap:
            vis = ImageOps.colorize(vis, black="#000000", white="#ff0000")
        nbytes, _ = save_image(vis, args.output)
        payload["output"] = str(args.output)
        payload["bytes"] = nbytes
    emit(payload, args.pretty)
    return 0


def cmd_base64(args):
    if args.decode:
        if not args.input:
            raise ToolError("--decode 需要 -i <文本文件(.txt/.b64)>")
        src = Path(str(args.input[0]))
        if not src.is_file():
            raise ToolError("文件不存在: %s" % src)
        raw = src.read_text(encoding="utf-8", errors="ignore").strip()
        m = re.search(r"base64,([A-Za-z0-9+/=\s]+)", raw)
        if m:
            raw = m.group(1)
        raw = re.sub(r"\s+", "", raw)
        if not raw or not re.fullmatch(r"[A-Za-z0-9+/=]+", raw):
            raise ToolError("文件内容不是有效的 base64/DataURI: %s" % src)
        try:
            data = _b64.b64decode(raw + "=" * (-len(raw) % 4))
        except Exception as exc:
            raise ToolError("base64 解码失败: %s" % exc)
        ext = args.ext or ".png"
        dst = Path(args.output) if args.output else src.with_suffix(ext)
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
        info = {"ok": True, "cmd": "base64", "decode": True, "output": str(dst), "bytes": len(data)}
        try:
            with Image.open(_io.BytesIO(data)) as im:
                info.update({"width": im.width, "height": im.height, "format": im.format})
        except Exception:
            info["warning"] = "已写出文件,但内容不是可识别的图片"
        emit(info, args.pretty)
        return 0
    if not args.input:
        raise ToolError("需要 -i <图片>(或用 --decode 解码文本)")
    inputs = collect_inputs(args.input)
    results = []
    for src in inputs:
        im = open_image(src)
        mime = Image.MIME.get(im.format or "PNG", "image/png")
        if args.format:
            fmt = normalize_format(args.format)
            data, _ = encode_image(im, fmt, quality=args.quality)
            mime = Image.MIME.get(fmt, "image/png")
        else:
            data = src.read_bytes()
        b64 = _b64.b64encode(data).decode("ascii")
        item = {"input": str(src), "mime": mime, "bytes": len(data), "base64_len": len(b64),
                "data_uri": "data:%s;base64,%s" % (mime, b64)}
        if args.output:
            dst = Path(args.output)
            if len(inputs) > 1 or dst.is_dir():
                dst = dst / (src.stem + (".b64.txt" if args.data_uri else ".txt"))
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(item["data_uri"] if args.data_uri else b64, encoding="utf-8")
            item["output"] = str(dst)
        if args.preview:
            item.pop("data_uri", None)
            item["preview"] = b64[:64] + ("…" if len(b64) > 64 else "")
        results.append(item)
    return results


# ============================================================ 命令: 几何

def cmd_resize(args):
    fit = args.fit or ("fill" if args.size else "inside")
    resample = RESAMPLE[args.resample]

    def fn(im, ctx):
        W, H = im.size
        tw = th = None
        if args.size:
            tw, th = parse_size(args.size)
        elif args.width:
            tw = int(args.width)
        elif args.height:
            th = int(args.height)
        elif args.percent:
            tw = max(1, round(W * args.percent / 100.0))
            th = max(1, round(H * args.percent / 100.0))
        elif args.max_side or args.max_width or args.max_height:
            s = 1.0
            if args.max_side:
                s = min(s, args.max_side / max(W, H))
            if args.max_width:
                s = min(s, args.max_width / W)
            if args.max_height:
                s = min(s, args.max_height / H)
            tw, th = max(1, round(W * s)), max(1, round(H * s))
        else:
            raise ToolError("resize 需要 --size/--width/--height/--percent/--max-side/--max-width/--max-height 之一")
        if tw is None:
            tw = max(1, round(W * th / H))
        if th is None:
            th = max(1, round(H * tw / W))
        if args.no_upscale and (tw > W or th > H):
            return im.copy()
        if fit == "cover":
            return ImageOps.fit(im, (tw, th), method=resample)
        if fit == "contain":
            inner = ImageOps.contain(im, (tw, th), method=resample)
            bg = parse_color(args.background, (0, 0, 0, 0))
            canvas = Image.new("RGBA", (tw, th), bg)
            canvas.alpha_composite(ensure_alpha(inner), ((tw - inner.width) // 2, (th - inner.height) // 2))
            return canvas if bg[3] < 255 else canvas.convert("RGB")
        return im.resize((tw, th), resample)

    results = foreach(args, suffix="_resized", fn=fn)
    return results


def cmd_crop(args):
    if not (args.box or args.size or args.aspect):
        raise ToolError("crop 需要 --box、--size 或 --aspect 之一")
    anchor = parse_pos(args.position, "center")

    def fn(im, ctx):
        W, H = im.size
        if args.box:
            nums = [int(x) for x in re.findall(r"-?\d+", args.box)]
            if len(nums) != 4:
                raise ToolError("--box 需要 4 个数字: 左,上,右,下")
            l, t, r, b = nums
            if r <= l:
                r = W + r
            if b <= t:
                b = H + b
            l, t = max(0, l), max(0, t)
            r, b = min(W, r), min(H, b)
            if r <= l or b <= t:
                raise ToolError("裁剪区域无效: %s(图 %dx%d)" % (args.box, W, H))
            return im.crop((l, t, r, b))
        if args.aspect:
            aw, ah = parse_size(args.aspect)
            ratio = aw / float(ah)
            if W / float(H) > ratio:
                nw, nh = max(1, round(H * ratio)), H
            else:
                nw, nh = W, max(1, round(W / ratio))
            x, y = anchor_offset((W, H), (nw, nh), anchor)
            out = im.crop((x, y, x + nw, y + nh))
        else:
            out = im
        if args.size:
            w, h = parse_size(args.size)
            cw, ch = out.size
            if (w, h) == (cw, ch):
                return out
            x, y = anchor_offset((cw, ch), (min(w, cw), min(h, ch)), anchor)
            out = out.crop((x, y, min(x + w, cw), min(y + h, ch)))
        return out

    return foreach(args, suffix="_cropped", fn=fn)


def _trim_bbox(im, tolerance=0):
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        alpha = ensure_alpha(im).getchannel("A")
        return alpha.point(lambda p: 255 if p > tolerance else 0).getbbox()
    rgb = im.convert("RGB")
    bg = rgb.getpixel((0, 0))
    diff = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg)).convert("L")
    return diff.point(lambda p: 255 if p > tolerance else 0).getbbox()


def cmd_trim(args):
    def fn(im, ctx):
        W, H = im.size
        bbox = _trim_bbox(im, args.tolerance)
        if bbox is None:
            if args.strict:
                raise ToolError("整张图都是单色/透明,没有可保留的内容(去掉 --strict 可原样输出)")
            return im.copy()
        l, t, r, b = bbox
        p = max(0, args.padding)
        l, t = max(0, l - p), max(0, t - p)
        r, b = min(W, r + p), min(H, b + p)
        return im.crop((l, t, r, b))

    return foreach(args, suffix="_trimmed", fn=fn)


def cmd_rotate(args):
    resample = RESAMPLE[args.resample]

    def fn(im, ctx):
        angle = float(args.angle)
        if abs(angle) < 1e-9:
            return im.copy()
        bg = parse_color(args.background, None)
        if bg is None:
            bg = (0, 0, 0, 0) if im.mode in ("RGBA", "LA", "P") else (255, 255, 255, 255)
        fill = bg if im.mode == "RGBA" else bg[:3] if im.mode == "RGB" else bg[0]
        exact = abs(angle % 90) < 1e-9
        expand = args.expand if args.expand is not None else (not exact)
        return im.rotate(-angle, resample=resample, expand=bool(expand), fillcolor=fill)

    return foreach(args, suffix="_rotated", fn=fn)


def cmd_flip(args):
    d = str(args.direction).lower()

    def fn(im, ctx):
        if d in ("h", "horizontal", "x"):
            return im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if d in ("v", "vertical", "y"):
            return im.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        if d in ("both", "hv", "180"):
            return im.transpose(Image.Transpose.ROTATE_180)
        raise ToolError("--direction 只支持 h / v / both")

    return foreach(args, suffix="_flipped", fn=fn)


def cmd_pad(args):
    def fn(im, ctx):
        W, H = im.size
        bg = parse_color(args.background, (0, 0, 0, 0))
        if args.size:
            tw, th = parse_size(args.size)
            if tw < W or th < H:
                raise ToolError("--size %dx%d 小于原图 %dx%d(扩边不能缩小,请用 resize)" % (tw, th, W, H))
            x, y = anchor_offset((tw, th), (W, H), parse_pos(args.position, "center"))
        else:
            l = args.pad_left if args.pad_left is not None else args.pad
            t = args.pad_top if args.pad_top is not None else args.pad
            r = args.pad_right if args.pad_right is not None else args.pad
            b = args.pad_bottom if args.pad_bottom is not None else args.pad
            l, t, r, b = int(l), int(t), int(r), int(b)
            tw, th = W + l + r, H + t + b
            x, y = l, t
        base = Image.new("RGBA", (tw, th), bg)
        base.alpha_composite(ensure_alpha(im), (x, y))
        return base if bg[3] < 255 else base.convert("RGB")

    return foreach(args, suffix="_padded", fn=fn)


def cmd_round(args):
    def fn(im, ctx):
        W, H = im.size
        fmt = normalize_format(ctx["dst"].suffix) or "PNG"
        bg = parse_color(args.background, None)
        if bg is None and fmt not in ALPHA_FORMATS:
            bg = (255, 255, 255, 255)
        bg = bg or (0, 0, 0, 0)
        src = im
        if args.circle and W != H:
            s = min(W, H)
            x, y = (W - s) // 2, (H - s) // 2
            src = im.crop((x, y, x + s, y + s))
            W = H = s
        radius = float(min(W, H) / 2.0) if args.circle else args.radius
        if args.radius_percent is not None:
            radius = min(W, H) * args.radius_percent / 100.0
        radius = max(0.0, min(radius, min(W, H) / 2.0))
        ss = 4  # 4x 超采样保证边缘平滑
        mask = Image.new("L", (W * ss, H * ss), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, W * ss - 1, H * ss - 1], radius=radius * ss, fill=255)
        mask = mask.resize((W, H), Image.Resampling.LANCZOS)
        out = Image.new("RGBA", (W, H), bg)
        out.paste(src.convert("RGBA"), (0, 0), mask)
        if args.border:
            d = ImageDraw.Draw(out)
            d.rounded_rectangle([0, 0, W - 1, H - 1], radius=radius, outline=parse_color(args.border_color, (255, 255, 255, 255)),
                                width=int(args.border))
        return out if bg[3] < 255 else out.convert("RGB")

    return foreach(args, suffix="_rounded", fn=fn)


# ============================================================ 命令: 编码与体积

def cmd_compress(args):
    target = parse_bytes(args.target_size)
    if args.quality is not None and target:
        raise ToolError("--quality 与 --target-size 只能二选一(目标是体积就让工具去挑质量)")
    qualityless = ("PNG", "BMP", "TIFF", "GIF")

    def fn(im, ctx):
        fmt = normalize_format(args.format) or normalize_format(ctx["dst"].suffix) or normalize_format(im.format) or "JPEG"
        work = im
        if args.max_side and max(im.size) > args.max_side:
            s = args.max_side / float(max(im.size))
            work = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.Resampling.LANCZOS)
        bg = parse_color(args.background, (255, 255, 255, 255))
        if target:
            (data, q, scale), warns = _fit_to_target(
                work, fmt, target, min_q=args.min_quality, max_q=args.max_quality,
                background=bg, lossless=bool(args.lossless), qualityless=qualityless)
            ctx["_prebuilt"] = (data, warns)
            ctx["_chosen"] = {"quality": q, "scale": round(scale, 4), "format": fmt}
            return _scaled(work, scale)
        return work

    results = foreach(args, suffix="_compressed", fn=fn, save_opts=None)
    return results


def _scaled(im, scale):
    if scale >= 0.999:
        return im
    return im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.Resampling.LANCZOS)


def _fit_to_target(im, fmt, target, *, min_q, max_q, background, lossless=False,
                   qualityless=("PNG", "BMP", "TIFF", "GIF")):
    """在不超过 target 字节的前提下取尽量高的质量;必要时逐步缩小尺寸。返回 ((data,q,scale), warns)。"""
    warns = []
    scale = 1.0
    best = None
    if fmt in qualityless:
        warns.append("格式 %s 没有质量参数,压体积只能靠缩小尺寸(如可换格式建议 --format webp)" % fmt)
    for _ in range(8):
        work = _scaled(im, scale)
        if fmt in qualityless:
            data, _w = encode_image(work, fmt, background=background, optimize=True, compress_level=9)
            best = (data, None, scale)
            if len(data) <= target:
                return best, warns
        else:
            lo, hi = int(min_q), int(max_q)
            found = None
            while lo <= hi:
                mid = (lo + hi) // 2
                data, _w = encode_image(work, fmt, quality=mid, background=background, lossless=lossless)
                if len(data) <= target:
                    found = (data, mid, scale)
                    lo = mid + 1
                else:
                    hi = mid - 1
            if found:
                return found, warns
            data, _w = encode_image(work, fmt, quality=int(min_q), background=background, lossless=lossless)
            best = (data, int(min_q), scale)
        scale *= 0.82
    warns.append("即使压到最低质量并缩小到 %.0f%% 仍未达到目标体积,已输出最小结果" % (best[2] * 100))
    return best, warns


def cmd_convert(args):
    fmt = normalize_format(args.format)
    ext = FMT_EXT.get(fmt, "." + args.format.lower().lstrip("."))
    opts = {"format": fmt}
    if args.quality is not None:
        opts["quality"] = args.quality
    if args.lossless:
        opts["lossless"] = True
    if args.background is not None:
        opts["background"] = parse_color(args.background)
    if args.colors:
        opts["colors"] = args.colors
    if args.dpi:
        opts["dpi"] = args.dpi
    return foreach(args, suffix="", ext=ext, fn=lambda im, ctx: im, save_opts=opts)


def cmd_thumbnail(args):
    long_side = args.max_side
    opts = {}
    if args.quality is not None:
        opts["quality"] = args.quality
    if args.format:
        opts["format"] = normalize_format(args.format)

    def fn(im, ctx):
        w, h = im.size
        s = long_side / float(max(w, h))
        if s < 1:
            im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.Resampling.LANCZOS)
        return im

    ext = ("." + args.format.lower().lstrip(".")) if args.format else None
    return foreach(args, suffix="_thumb", ext=ext, fn=fn, save_opts=opts)


def cmd_strip(args):
    return foreach(args, suffix="_clean", fn=lambda im, ctx: im.copy(),
                   save_opts={"keep_exif": False, "keep_icc": False})


def cmd_favicon(args):
    src = collect_inputs(args.input)[0]
    im = open_image(src)
    if args.square and im.width != im.height:
        s = min(im.size)
        im = im.crop(((im.width - s) // 2, (im.height - s) // 2, (im.width + s) // 2, (im.height + s) // 2))
    sizes = [int(x) for x in re.findall(r"\d+", args.sizes)] or [16, 32, 48, 64, 128, 256]
    sizes = sorted({max(8, min(1024, s)) for s in sizes})
    big = max(sizes)
    base = im.convert("RGBA").resize((big, big), Image.Resampling.LANCZOS)
    outputs = []
    ico_path = Path(args.output) if args.output else src.with_name("favicon.ico")
    ico_path.parent.mkdir(parents=True, exist_ok=True)
    ico_kw = dict(format="ICO", sizes=[(s, s) for s in sizes])
    try:
        base.save(ico_path, **ico_kw)
    except Exception as exc:
        raise ToolError("写 ICO 失败: %s" % exc)
    outputs.append({"output": str(ico_path), "bytes": ico_path.stat().st_size, "sizes": sizes})
    if args.png_dir:
        d = Path(args.png_dir)
        d.mkdir(parents=True, exist_ok=True)
        for s in sizes:
            p = d / ("icon-%d.png" % s)
            save_image(base.resize((s, s), Image.Resampling.LANCZOS), p, fmt="PNG")
            outputs.append({"output": str(p), "bytes": p.stat().st_size, "size": [s, s]})
    emit({"ok": True, "cmd": "favicon", "input": str(src), "count": len(outputs),
          "output": str(ico_path), "results": outputs}, args.pretty)
    return 0


# ============================================================ 命令: 调色与滤镜

def _apply_temperature(im, value):
    """value>0 偏暖(加红减蓝),<0 偏冷。"""
    v = max(-100, min(100, float(value))) / 100.0
    r, g, b = im.convert("RGB").split()
    r = r.point(lambda p: max(0, min(255, int(p * (1 + 0.25 * v)))))
    b = b.point(lambda p: max(0, min(255, int(p * (1 - 0.25 * v)))))
    out = Image.merge("RGB", (r, g, b))
    if im.mode == "RGBA":
        out = out.convert("RGBA")
        out.putalpha(im.getchannel("A"))
    return out


def _pixelate(im, block):
    block = max(2, int(block))
    w, h = im.size
    small = im.resize((max(1, w // block), max(1, h // block)), Image.Resampling.BILINEAR)
    return small.resize((w, h), Image.Resampling.NEAREST)


def _sepia(im):
    g = im.convert("L")
    return Image.merge("RGB", (
        g.point(lambda p: min(255, int(p * 1.07 + 24))),
        g.point(lambda p: min(255, int(p * 0.94 + 6))),
        g.point(lambda p: min(255, int(p * 0.72))),
    ))


FILTER_PRESETS = ("grayscale", "sepia", "invert", "blur", "smooth", "sharpen", "detail",
                  "emboss", "contour", "edge", "autocontrast", "equalize", "posterize",
                  "solarize", "pixelate", "denoise", "find-edges", "min", "max")


def _apply_preset(im, args):
    p = args.preset
    if p == "grayscale":
        if im.mode == "RGBA":
            out = im.convert("L").convert("RGBA")
            out.putalpha(im.getchannel("A"))
            return out
        return im.convert("L")
    if p == "sepia":
        out = _sepia(im)
        if im.mode == "RGBA":
            out = out.convert("RGBA")
            out.putalpha(im.getchannel("A"))
        return out
    if p == "invert":
        if im.mode == "RGBA":
            r, g, b, a = im.split()
            return Image.merge("RGBA", (ImageOps.invert(r), ImageOps.invert(g), ImageOps.invert(b), a))
        return ImageOps.invert(im.convert("RGB")) if im.mode not in ("RGB", "L") else ImageOps.invert(im)
    if p == "blur":
        return im.filter(ImageFilter.GaussianBlur(radius=args.radius if args.radius else 2.0))
    if p == "smooth":
        return im.filter(ImageFilter.MedianFilter(size=int(args.radius) if args.radius and args.radius >= 3 else 5))
    if p == "denoise":
        return im.filter(ImageFilter.MedianFilter(size=3))
    if p == "sharpen":
        return im.filter(ImageFilter.UnsharpMask(radius=2, percent=int(150 * (args.amount or 1.0)), threshold=3))
    if p == "detail":
        return im.filter(ImageFilter.DETAIL)
    if p == "emboss":
        return im.filter(ImageFilter.EMBOSS)
    if p == "contour":
        return im.filter(ImageFilter.CONTOUR)
    if p in ("edge", "find-edges"):
        return im.filter(ImageFilter.FIND_EDGES)
    if p == "autocontrast":
        return ImageOps.autocontrast(im.convert("RGB"))
    if p == "equalize":
        return ImageOps.equalize(im.convert("RGB"))
    if p == "posterize":
        return ImageOps.posterize(im.convert("RGB"), bits=int(args.bits))
    if p == "solarize":
        return ImageOps.solarize(im.convert("RGB"), threshold=int(args.threshold))
    if p == "pixelate":
        return _pixelate(im, args.pixel_size)
    if p == "min":
        return im.filter(ImageFilter.MinFilter(size=3))
    if p == "max":
        return im.filter(ImageFilter.MaxFilter(size=3))
    raise ToolError("未知滤镜: %s(可选 %s)" % (p, "/".join(FILTER_PRESETS)))


def cmd_filter(args):
    def fn(im, ctx):
        if args.box:
            nums = [int(x) for x in re.findall(r"-?\d+", args.box)]
            if len(nums) != 4:
                raise ToolError("--box 需要 4 个数字: 左,上,右,下")
            box = tuple(nums)
            region = im.crop(box)
            fixed = _apply_preset(region, args)
            out = im.copy()
            out.paste(fixed, box[:2], fixed if fixed.mode == "RGBA" else None)
            return out
        return _apply_preset(im, args)

    return foreach(args, suffix="_filtered", fn=fn)


def cmd_adjust(args):
    def fn(im, ctx):
        out = im
        if args.brightness != 1.0:
            out = ImageEnhance.Brightness(out).enhance(args.brightness)
        if args.contrast != 1.0:
            out = ImageEnhance.Contrast(out).enhance(args.contrast)
        if args.saturation != 1.0:
            out = ImageEnhance.Color(out).enhance(args.saturation)
        if args.sharpness != 1.0:
            out = ImageEnhance.Sharpness(out).enhance(args.sharpness)
        if args.blur:
            out = out.filter(ImageFilter.GaussianBlur(radius=args.blur))
        if args.gamma and abs(args.gamma - 1.0) > 1e-6:
            g = 1.0 / float(args.gamma)
            lut = [max(0, min(255, int(255.0 * ((i / 255.0) ** g)))) for i in range(256)]
            bands = out.split()
            bands = [b.point(lut) if b.mode == "L" else b for b in bands]
            out = Image.merge(out.mode, bands)
        if args.temperature:
            out = _apply_temperature(out, args.temperature)
        if args.auto_contrast:
            a = out.getchannel("A") if out.mode == "RGBA" else None
            out = ImageOps.autocontrast(out.convert("RGB"), cutoff=args.cutoff)
            if a is not None:
                out = out.convert("RGBA")
                out.putalpha(a)
        if args.equalize:
            a = out.getchannel("A") if out.mode == "RGBA" else None
            out = ImageOps.equalize(out.convert("RGB"))
            if a is not None:
                out = out.convert("RGBA")
                out.putalpha(a)
        return out

    return foreach(args, suffix="_adjusted", fn=fn)


# ============================================================ 命令: 抠图去背景

def _edge_bg_color(arr, band=4):
    """从四边条带取中位数作为背景色(比只看四角稳)。"""
    h, w = arr.shape[:2]
    b = max(1, min(band, min(h, w) // 4))
    edge = _np.concatenate([arr[:b].reshape(-1, 3), arr[-b:].reshape(-1, 3),
                            arr[:, :b].reshape(-1, 3), arr[:, -b:].reshape(-1, 3)])
    return _np.median(edge, axis=0)


def _window_any(mask, r):
    """膨胀:半径 r 的方形结构元内是否存在 True(积分图实现,O(N))。"""
    h, w = mask.shape
    S = _np.zeros((h + 1, w + 1), dtype=_np.int64)
    S[1:, 1:] = mask.astype(_np.int64).cumsum(0).cumsum(1)
    i0 = _np.maximum(_np.arange(h) - r, 0)[:, None]
    i1 = _np.minimum(_np.arange(h) + r + 1, h)[:, None]
    j0 = _np.maximum(_np.arange(w) - r, 0)[None, :]
    j1 = _np.minimum(_np.arange(w) + r + 1, w)[None, :]
    return (S[i1, j1] - S[i0, j1] - S[i1, j0] + S[i0, j0]) > 0


def _border_connected(similar):
    """与图像边界连通的 similar 区域(内部同色块不会被误抠)。"""
    if _ndi is not None:
        lab, n = _ndi.label(similar, structure=_np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]]))
        if n == 0:
            return _np.zeros_like(similar)
        border = set(_np.unique(_np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]])))
        border.discard(0)
        if not border:
            return _np.zeros_like(similar)
        return _np.isin(lab, list(border))
    h, w = similar.shape
    band = max(1, min(h, w) // 100)
    reach = _np.zeros_like(similar)
    reach[:band, :] = similar[:band, :]
    reach[-band:, :] = similar[-band:, :]
    reach[:, :band] = similar[:, :band]
    reach[:, -band:] = similar[:, -band:]
    rmax = max(h, w)
    r = 1
    for _ in range(64):
        grown = _window_any(reach, r) & similar
        if _np.array_equal(grown, reach):
            if r >= rmax:
                break
            r = rmax  # 用最大半径再确认一次,确保不漏连通区
            continue
        reach = grown
        r = min(r * 2, rmax)
    return reach


def _remove_bg_np(im, bg, tol, method, feather, soft):
    rgba = ensure_alpha(im)
    arr = _np.asarray(rgba.convert("RGB"), dtype=_np.int16)
    if bg is None:
        bg_arr = _edge_bg_color(arr)
    else:
        bg_arr = _np.array(bg[:3], dtype=_np.float64)
    diff = _np.abs(arr - bg_arr.reshape(1, 1, 3)).max(axis=2).astype(_np.float32)
    similar = diff <= float(tol)
    if method == "global":
        mask = similar
    else:
        mask = _border_connected(similar)
    if soft:
        lo = float(tol) * 0.72
        hi = float(tol) * 1.35 + 1.0
        edge_alpha = _np.clip((diff - lo) / max(hi - lo, 1.0), 0.0, 1.0) * 255.0
        alpha = _np.where(mask, edge_alpha, 255.0)
    else:
        alpha = _np.where(mask, 0.0, 255.0)
    a_img = Image.fromarray(alpha.astype(_np.uint8), "L")
    if feather and feather > 0:
        a_img = a_img.filter(ImageFilter.GaussianBlur(float(feather)))
        # 抹掉远场残留:模糊会把 alpha 抬起 1-3,归零后背景才是真透明(视觉无损,PNG 也更小)
        a_img = a_img.point(lambda p: 0 if p < 4 else p)
    out = rgba.copy()
    out.putalpha(a_img)
    info = {"bg_color": "#%02x%02x%02x" % tuple(int(max(0, min(255, v))) for v in bg_arr[:3]),
            "removed_px": int(mask.sum()), "removed_pct": round(float(mask.mean()) * 100, 2),
            "method": method + ("+soft" if soft else ""),
            "tolerance": tol}
    return out, info


def _remove_bg(im, bg, tol, method, feather=1.5, soft=True):
    if method == "rembg":
        try:
            from rembg import remove as _rmbg  # type: ignore
        except Exception:
            raise ToolError("未安装 rembg(可选重量级依赖): pip install rembg onnxruntime;"
                            "或改用本地算法 --method flood")
        out = _rmbg(ensure_alpha(im))
        return out, {"method": "rembg", "note": "AI 模型抠图"}
    if _np is None:
        rgba = ensure_alpha(im)
        rgb = rgba.convert("RGB")
        ref = Image.new("RGB", rgba.size, tuple(int(v) for v in (bg or (255, 255, 255))[:3]))
        diff = ImageChops.difference(rgb, ref).convert("L")
        a = diff.point(lambda p: 0 if p <= tol else 255)
        out = rgba.copy()
        out.putalpha(a)
        return out, {"method": "global(pillow-fallback)", "note": "未装 numpy,只做全图色键"}
    return _remove_bg_np(im, bg, tol, method, feather, soft)


def cmd_removebg(args):
    bg = None if (args.bg_color in (None, "auto")) else parse_color(args.bg_color)
    method = args.method
    if method == "auto":
        method = "flood"

    def fn(im, ctx):
        out, info = _remove_bg(im, bg, args.tolerance, method,
                               feather=0 if args.no_feather else args.feather, soft=not args.hard_edge)
        if info.get("removed_pct", 0) > 99.0:
            ctx.setdefault("_extra_warnings", []).append(
                "几乎整张图都被当作背景抠掉了(主体可能被误伤):请降低 --tolerance(当前 %s)、"
                "指定 --bg-color,或改用 --method global" % args.tolerance)
        if args.trim:
            bbox = _trim_bbox(out, max(1, args.tolerance // 2))
            if bbox:
                p = args.trim_padding
                out = out.crop((max(0, bbox[0] - p), max(0, bbox[1] - p),
                                min(out.width, bbox[2] + p), min(out.height, bbox[3] + p)))
        ctx["_chosen"] = info
        return out

    return foreach(args, suffix="_nobg", ext=".png", fn=fn,
                   save_opts={"format": "PNG", "background": (0, 0, 0, 0)})


def cmd_transparent(args):
    color = args.color
    if color in (None, "auto"):
        bg = None
    else:
        bg = parse_color(color)
    method = "global" if args.global_scope else "flood"

    def fn(im, ctx):
        out, info = _remove_bg(im, bg, args.tolerance, method,
                               feather=0 if args.no_feather else args.feather, soft=not args.hard_edge)
        ctx["_chosen"] = info
        return out

    return foreach(args, suffix="_alpha", ext=".png", fn=fn,
                   save_opts={"format": "PNG", "background": (0, 0, 0, 0)})


# ============================================================ 命令: 水印与合成

def _text_layer(lines, font, color, stroke_width, stroke_fill, spacing, pad):
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    boxes = [probe.textbbox((0, 0), ln, font=font, stroke_width=stroke_width) for ln in lines]
    widths = [b[2] - b[0] for b in boxes]
    heights = [b[3] - b[1] for b in boxes]
    tw = max(widths) + pad * 2
    th = sum(heights) + spacing * (len(lines) - 1) + pad * 2
    layer = Image.new("RGBA", (max(1, tw), max(1, th)), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    y = pad
    for ln, bb, hh in zip(lines, boxes, heights):
        d.text((pad - bb[0], y - bb[1]), ln, font=font, fill=color,
               stroke_width=stroke_width, stroke_fill=stroke_fill)
        y += hh + spacing
    return layer


def cmd_watermark(args):
    if not args.text and not args.image:
        raise ToolError("watermark 需要 --text '文字' 或 --image logo.png")

    def fn(im, ctx):
        base = ensure_alpha(im).copy()
        W, H = base.size
        anchor = parse_pos(args.position, "bottom-right")
        margin = int(args.margin)
        opacity = args.opacity if args.opacity is not None else (0.55 if args.text else 0.9)

        if args.text:
            font_size = int(args.font_size or max(10, min(W, H) * 0.045))
            font = load_font(font_size, args.font)
            lines = args.text.replace("\\n", "\n").split("\n")
            layer = _text_layer(lines, font, parse_color(args.color, (255, 255, 255, 255)),
                                int(args.stroke_width), parse_color(args.stroke_color, (0, 0, 0, 200)),
                                int(args.line_spacing), int(args.text_padding))
        else:
            wm = open_image(args.image)
            scale = args.scale if args.scale else 0.18
            tw = max(1, int(W * scale))
            th = max(1, int(wm.height * tw / wm.width))
            layer = ensure_alpha(wm).resize((tw, th), Image.Resampling.LANCZOS)

        if opacity < 1.0:
            a = layer.getchannel("A").point(lambda p: int(p * max(0.0, min(1.0, opacity))))
            layer.putalpha(a)
        if args.angle:
            layer = layer.rotate(float(args.angle), expand=True, resample=Image.Resampling.BICUBIC)

        if args.tile:
            step_x = layer.width + int(args.tile_gap)
            step_y = layer.height + int(args.tile_gap)
            for y in range(-layer.height, H + step_y, step_y):
                for x in range(-layer.width, W + step_x, step_x):
                    base.alpha_composite(layer, (x, y))
        else:
            x, y = anchor_offset((W, H), layer.size, anchor)
            if anchor[0] == "left":
                x += margin
            elif anchor[0] == "right":
                x -= margin
            if anchor[1] == "top":
                y += margin
            elif anchor[1] == "bottom":
                y -= margin
            base.alpha_composite(layer, (x, y))
        return base if (im.mode in ("RGBA", "LA", "P") or args.keep_alpha) else base.convert("RGB")

    return foreach(args, suffix="_wm", fn=fn)


def _fit_cell(im, cell, bg, fit="contain"):
    cw, ch = cell
    if fit == "cover":
        return ImageOps.fit(ensure_alpha(im), (cw, ch), method=Image.Resampling.LANCZOS)
    inner = ImageOps.contain(ensure_alpha(im), (cw, ch), method=Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (cw, ch), bg)
    canvas.alpha_composite(inner, ((cw - inner.width) // 2, (ch - inner.height) // 2))
    return canvas


def _label_strip(text, width, font, color, bg, align="center"):
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bb = probe.textbbox((0, 0), text, font=font)
    th = (bb[3] - bb[1]) + 12
    strip = Image.new("RGBA", (width, th), bg)
    d = ImageDraw.Draw(strip)
    tw = bb[2] - bb[0]
    x = 8 if align == "left" else (width - tw) // 2 if align == "center" else width - tw - 8
    d.text((x - bb[0], 6 - bb[1]), text, font=font, fill=color)
    return strip


def _compose(images, *, layout="h", gap=0, bg=(0, 0, 0, 0), cell=None, labels=None,
             label_size=28, label_fg=(255, 255, 255, 255), label_bg=(0, 0, 0, 180), fit="contain"):
    n = len(images)
    if n == 0:
        raise ToolError("没有可拼接的图片")
    labels = labels or []
    font = load_font(label_size) if labels else None
    if layout == "h":
        cell_h = cell[1] if cell else max(im.height for im in images)
        tiles = [ImageOps.contain(ensure_alpha(im), (10 ** 6, cell_h), method=Image.Resampling.LANCZOS) for im in images]
    elif layout == "v":
        cell_w = cell[0] if cell else max(im.width for im in images)
        tiles = [ImageOps.contain(ensure_alpha(im), (cell_w, 10 ** 6), method=Image.Resampling.LANCZOS) for im in images]
    else:  # grid
        cols = int(cell[2]) if cell and len(cell) > 2 else max(1, int(n ** 0.5 + 0.999))
        cw = cell[0] if cell else max(im.width for im in images)
        ch = cell[1] if cell else max(im.height for im in images)
        tiles = [_fit_cell(im, (cw, ch), bg, fit) for im in images]
    if labels:
        labeled = []
        for i, t in enumerate(tiles):
            txt = labels[i] if i < len(labels) else ""
            if not txt:
                labeled.append(t)
                continue
            strip = _label_strip(txt, t.width, font, label_fg, label_bg)
            merged = Image.new("RGBA", (t.width, t.height + strip.height), bg)
            merged.alpha_composite(strip, (0, 0))
            merged.alpha_composite(t, (0, strip.height))
            labeled.append(merged)
        tiles = labeled
    if layout == "grid":
        cols = int(cell[2]) if cell and len(cell) > 2 else max(1, int(n ** 0.5 + 0.999))
        rows = (n + cols - 1) // cols
        cw = max(t.width for t in tiles)
        ch = max(t.height for t in tiles)
        W = cols * cw + gap * (cols - 1)
        H = rows * ch + gap * (rows - 1)
        canvas = Image.new("RGBA", (W, H), bg)
        for i, t in enumerate(tiles):
            r, c = divmod(i, cols)
            canvas.alpha_composite(t, (c * (cw + gap), r * (ch + gap)))
        return canvas
    if layout == "h":
        W = sum(t.width for t in tiles) + gap * (n - 1)
        H = max(t.height for t in tiles)
        canvas = Image.new("RGBA", (W, H), bg)
        x = 0
        for t in tiles:
            canvas.alpha_composite(t, (x, (H - t.height) // 2))
            x += t.width + gap
        return canvas
    W = max(t.width for t in tiles)
    H = sum(t.height for t in tiles) + gap * (n - 1)
    canvas = Image.new("RGBA", (W, H), bg)
    y = 0
    for t in tiles:
        canvas.alpha_composite(t, ((W - t.width) // 2, y))
        y += t.height + gap
    return canvas


def _split_labels(v):
    if not v:
        return []
    return [s.strip() for s in str(v).split(",")]


def cmd_collage(args):
    inputs = collect_inputs(args.input)
    images = [open_image(p) for p in inputs]
    cell = None
    if args.cell:
        c = parse_size(args.cell)
        cell = (c[0], c[1], args.cols) if args.layout == "grid" else (c[0], c[1])
    bg = parse_color(args.background, (255, 255, 255, 255))
    out = _compose(images, layout=args.layout, gap=args.gap, bg=bg, cell=cell,
                   labels=_split_labels(args.labels), label_size=args.label_size, fit=args.fit)
    if bg[3] >= 255:
        out = out.convert("RGB")
    dst = Path(args.output) if args.output else inputs[0].with_name(inputs[0].stem + "_collage" + (args.ext or ".png"))
    if dst.is_dir():
        dst = dst / (inputs[0].stem + "_collage" + (args.ext or ".png"))
    nbytes, warns = save_image(out, dst, format=normalize_format(args.ext) if args.ext else None, quality=args.quality)
    emit({"ok": True, "cmd": "collage", "output": str(dst), "width": out.width, "height": out.height,
          "bytes": nbytes, "inputs": [str(p) for p in inputs],
          "warnings": warns or None}, args.pretty)
    return 0


def cmd_compare(args):
    inputs = collect_inputs(args.input)
    if len(inputs) != 2:
        raise ToolError("compare 需要正好 2 张图: -i before.png after.png")
    labels = _split_labels(args.labels) or ["BEFORE", "AFTER"]
    gap = args.gap if args.gap else 24
    bg = parse_color(args.background, (255, 255, 255, 255))
    images = [open_image(p) for p in inputs]
    if args.layout == "tb":
        images = [ImageOps.contain(ensure_alpha(im), (args.width or 10 ** 6, 10 ** 6), Image.Resampling.LANCZOS)
                  if args.width else im for im in images]
    out = _compose(images, layout=("h" if args.layout == "lr" else "v"), gap=gap, bg=bg,
                   labels=labels, label_size=args.label_size, fit="contain")
    if bg[3] >= 255:
        out = out.convert("RGB")
    dst = Path(args.output) if args.output else inputs[0].with_name(inputs[0].stem + "_compare.png")
    if dst.is_dir():
        dst = dst / (inputs[0].stem + "_compare.png")
    nbytes, warns = save_image(out, dst, format=normalize_format(args.ext) if args.ext else None, quality=args.quality)
    emit({"ok": True, "cmd": "compare", "output": str(dst), "width": out.width, "height": out.height,
          "bytes": nbytes, "inputs": [str(p) for p in inputs], "layout": args.layout,
          "warnings": warns or None}, args.pretty)
    return 0


def cmd_grid(args):
    inputs = collect_inputs(args.input)
    src = inputs[0]
    im = open_image(src)
    rows, cols = args.rows, args.cols
    if args.count:
        cols = max(1, int(args.count ** 0.5 + 0.999))
        rows = (args.count + cols - 1) // cols
    outdir = Path(args.output) if args.output else src.parent / (src.stem + "_tiles")
    if outdir.suffix and not outdir.is_dir():
        outdir = outdir.with_suffix("")
    outdir.mkdir(parents=True, exist_ok=True)
    tw, th = im.width // cols, im.height // rows
    outs = []
    for r in range(rows):
        for c in range(cols):
            box = (c * tw, r * th, (c + 1) * tw, (r + 1) * th)
            tile = im.crop(box)
            p = outdir / ("%s_r%dc%d%s" % (src.stem, r + 1, c + 1, args.ext or src.suffix or ".png"))
            nbytes, _ = save_image(tile, p, quality=args.quality)
            outs.append({"output": str(p), "box": list(box), "bytes": nbytes})
    emit({"ok": True, "cmd": "grid", "input": str(src), "rows": rows, "cols": cols,
          "tile_size": [tw, th], "count": len(outs), "dir": str(outdir), "results": outs}, args.pretty)
    return 0


def cmd_overlay(args):
    inputs = collect_inputs(args.input)
    if len(inputs) != 2:
        raise ToolError("overlay 需要正好 2 张图: -i base.png logo.png(-o 输出的第一张为主图)")
    base = open_image(inputs[0])
    top = open_image(inputs[1])
    W, H = base.size
    if args.scale:
        tw = max(1, int(W * args.scale))
        top = top.resize((tw, max(1, int(top.height * tw / top.width))), Image.Resampling.LANCZOS)
    elif args.size:
        top = top.resize(parse_size(args.size), Image.Resampling.LANCZOS)
    layer = ensure_alpha(top)
    if args.opacity < 1.0:
        layer.putalpha(layer.getchannel("A").point(lambda p: int(p * args.opacity)))
    out = ensure_alpha(base).copy()
    x, y = anchor_offset((W, H), layer.size, parse_pos(args.position, "center"))
    x += args.offset_x
    y += args.offset_y
    out.alpha_composite(layer, (x, y))
    dst = Path(args.output) if args.output else inputs[0].with_name(inputs[0].stem + "_overlay.png")
    if dst.is_dir():
        dst = dst / (inputs[0].stem + "_overlay.png")
    nbytes, _ = save_image(out, dst, quality=args.quality)
    emit({"ok": True, "cmd": "overlay", "output": str(dst), "width": out.width, "height": out.height,
          "bytes": nbytes, "position": [x, y]}, args.pretty)
    return 0


# ============================================================ 命令: 生成与动图

def _gradient_image(size, c1, c2, angle=0):
    w, h = size
    if _np is not None:
        ys = _np.linspace(0.0, 1.0, max(2, h))[:, None]
        xs = _np.linspace(0.0, 1.0, max(2, w))[None, :]
        a = math.radians(angle % 360)
        t = (xs * abs(math.cos(a)) + ys * abs(math.sin(a)))
        t = t / (t.max() or 1.0)
        arr = _np.zeros((max(2, h), max(2, w), 3), dtype=_np.uint8)
        for i in range(3):
            arr[:, :, i] = (c1[i] + (c2[i] - c1[i]) * t).astype(_np.uint8)
        return Image.fromarray(arr, "RGB").resize((w, h))
    img = Image.new("RGB", (w, h), tuple(c1[:3]))
    d = ImageDraw.Draw(img)
    steps = max(w, h)
    for i in range(steps):
        t = i / max(1, steps - 1)
        col = tuple(int(c1[k] + (c2[k] - c1[k]) * t) for k in range(3))
        if angle % 360 < 180:
            d.line([(i, 0), (i, h)], fill=col)
        else:
            d.line([(0, i), (w, i)], fill=col)
    return img


def cmd_placeholder(args):
    if not args.size:
        raise ToolError("placeholder 需要 --size 800x600")
    w, h = parse_size(args.size)
    if args.gradient:
        parts = [p.strip() for p in re.split(r"[,;]", args.gradient) if p.strip()]
        c1 = parse_color(parts[0], (60, 90, 200, 255))
        c2 = parse_color(parts[1] if len(parts) > 1 else "#000000", (20, 20, 40, 255))
        img = _gradient_image((w, h), c1, c2, args.gradient_angle)
        img = ensure_alpha(img)
        img.putalpha(Image.new("L", (w, h), 255))
        ref_rgb = tuple((c1[i] + c2[i]) // 2 for i in range(3))
    else:
        bg = parse_color(args.background, (240, 240, 245, 255))
        img = Image.new("RGBA" if bg[3] < 255 else "RGB", (w, h), bg)
        ref_rgb = bg[:3]
    text = args.text if args.text is not None else "%d x %d" % (w, h)
    if text:
        lum = 0.299 * ref_rgb[0] + 0.587 * ref_rgb[1] + 0.114 * ref_rgb[2]
        text_color = parse_color(args.color) if args.color else ((26, 26, 26, 255) if lum > 140 else (255, 255, 255, 255))
        stroke_color = parse_color(args.stroke_color) if args.stroke_color else ((255, 255, 255, 170) if lum <= 140 else (0, 0, 0, 150))
        font = load_font(int(args.font_size or max(10, min(w, h) * 0.13)), args.font)
        layer = _text_layer(text.replace("\\n", "\n").split("\n"), font, text_color,
                            int(args.stroke_width), stroke_color, 6, 4)
        base = ensure_alpha(img).copy()
        base.alpha_composite(layer, ((w - layer.width) // 2, (h - layer.height) // 2))
        img = base
    dst = Path(args.output) if args.output else Path("placeholder_%dx%d%s" % (w, h, args.ext or ".png"))
    if dst.is_dir():
        dst = dst / ("placeholder_%dx%d%s" % (w, h, args.ext or ".png"))
    nbytes, _ = save_image(img, dst, format=normalize_format(args.ext) if args.ext else None, quality=args.quality)
    emit({"ok": True, "cmd": "placeholder", "output": str(dst), "width": w, "height": h,
          "bytes": nbytes}, args.pretty)
    return 0


def cmd_gif(args):
    inputs = collect_inputs(args.input)
    if len(inputs) < 2 and not args.from_dir:
        raise ToolError("gif 至少需要 2 帧: -i f1.png f2.png …(或用 -i 目录)")
    frames = []
    size = parse_size(args.size) if args.size else None
    bg = parse_color(args.background, (255, 255, 255, 255))
    for p in inputs:
        im = open_image(p, auto_orient=False)
        if size:
            im = ImageOps.fit(im, size, method=Image.Resampling.LANCZOS)
        frames.append(flatten(im, bg).convert("P", palette=Image.ADAPTIVE))
    if size is None:
        size = frames[0].size
        frames = [f if f.size == size else ImageOps.fit(f, size, method=Image.Resampling.LANCZOS) for f in frames]
    dst = Path(args.output) if args.output else inputs[0].with_name(inputs[0].stem + "_anim.gif")
    if dst.is_dir():
        dst = dst / (inputs[0].stem + "_anim.gif")
    dst.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(dst, format="GIF", save_all=True, append_images=frames[1:],
                   duration=int(args.duration), loop=int(args.loop), optimize=True, disposal=2)
    written = int(getattr(Image.open(dst), "n_frames", 1))
    payload = {"ok": True, "cmd": "gif", "output": str(dst), "frames": len(frames),
               "frames_written": written, "size": list(size), "bytes": dst.stat().st_size,
               "duration_ms": int(args.duration), "loop": int(args.loop)}
    if written < len(frames):
        payload["warnings"] = ["GIF 编码器合并了 %d 个与前一帧像素完全相同的帧(已写入 %d 帧);"
                               "若需要该停顿,请在重复帧之间插入一张差异帧" % (len(frames) - written, written)]
    emit(payload, args.pretty)
    return 0


def cmd_frames(args):
    inputs = collect_inputs(args.input)
    src = inputs[0]
    im = Image.open(src)
    n = int(getattr(im, "n_frames", 1))
    outdir = Path(args.output) if args.output else src.parent / (src.stem + "_frames")
    if outdir.suffix and not outdir.is_dir():
        outdir = outdir.with_suffix("")
    outdir.mkdir(parents=True, exist_ok=True)
    outs = []
    for i in range(n):
        im.seek(i)
        frame = im.convert("RGBA")
        p = outdir / ("%s_%03d.png" % (src.stem, i))
        nbytes, _ = save_image(frame, p, fmt="PNG")
        outs.append({"output": str(p), "bytes": nbytes, "duration_ms": im.info.get("duration")})
    emit({"ok": True, "cmd": "frames", "input": str(src), "frames": n, "dir": str(outdir),
          "results": outs}, args.pretty)
    return 0


# ============================================================ 命令行入口

EXAMPLES = """\
常用示例:
  imgtool doctor                                      环境自检(先跑这个)
  imgtool info -i photo.jpg                           看尺寸/格式/主色/EXIF
  imgtool compress -i photo.jpg --target-size 200KB   压到 200KB 以内
  imgtool resize -i photo.jpg --max-side 1600 -o out/ 长边限制到 1600
  imgtool crop -i photo.jpg --aspect 1:1              居中裁成正方形
  imgtool removebg -i photo.jpg -o cut.png            抠掉背景(输出透明 PNG)
  imgtool convert -i photo.png --format webp          转 WebP
  imgtool watermark -i photo.jpg --text "© 2026"      加文字水印
  imgtool compare -i before.png after.png             before/after 对比图
  imgtool round -i logo.png --circle                  圆形头像
  imgtool placeholder --size 800x600 -o cover.png     生成占位图
  imgtool compress -i ./images --target-size 300KB    整目录批量压缩

约定:
  * 默认输出 JSON(加 --pretty 缩进),失败时退出码非 0;
  * 绝不覆盖输入文件(要覆盖请显式加 --inplace);
  * -i 可传多个文件、目录或通配符,天然支持批量;
  * 体积参数支持 200KB / 1.5MB,尺寸支持 800x600 / 50%%,颜色支持 #fff / white / 255,255,255。
"""


def parent(with_input=True):
    p = argparse.ArgumentParser(add_help=False)
    if with_input:
        p.add_argument("-i", "--input", nargs="+", required=True,
                       help="输入图片:文件/目录/通配符,可多个")
    p.add_argument("-o", "--output", default=None, help="输出文件或目录(缺省:原目录加后缀)")
    p.add_argument("--inplace", action="store_true", help="就地覆盖原文件")
    p.add_argument("--no-overwrite", action="store_true", help="输出已存在时自动改名 -2/-3")
    p.add_argument("--keep-exif", action="store_true", help="保留 EXIF(默认清除)")
    p.add_argument("--no-auto-orient", action="store_true", help="不按 EXIF 方向自动摆正")
    p.add_argument("-q", "--quality", type=int, default=None, help="编码质量 1-100")
    p.add_argument("--background", default=None, help="背景/底色,如 white、#00000000")
    p.add_argument("--pretty", action="store_true", help="JSON 缩进输出")
    return p


def build_parser():
    parser = argparse.ArgumentParser(
        prog="imgtool", description="imgtool —— 本地图片处理工具(压缩/裁剪/抠图/水印/转换…),输出 JSON",
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog=EXAMPLES)
    parser.add_argument("--version", action="version", version="imgtool %s" % VERSION)
    sub = parser.add_subparsers(dest="_cmd", metavar="<命令>")

    def add(name, aliases=(), help="", with_input=True):
        p = sub.add_parser(name, aliases=list(aliases), help=help, description=help,
                           parents=[parent(with_input=with_input)],
                           formatter_class=argparse.RawDescriptionHelpFormatter)
        p.set_defaults(cmd=name)
        return p

    # —— 环境与分析
    p = add("doctor", help="环境自检:Pillow/numpy/字体/可用格式", with_input=False)
    p.set_defaults(func=cmd_doctor)

    p = add("info", help="图片信息:尺寸/格式/模式/透明度/主色/EXIF")
    p.add_argument("--colors", type=int, default=0, help="同时提取 N 个主色(0=不提取)")
    p.add_argument("--alpha-check", action=argparse.BooleanOptionalAction, default=True,
                   help="检测是否真的存在透明像素(默认开)")
    p.set_defaults(func=cmd_info)

    p = add("exif", help="只读 EXIF 元数据")
    p.set_defaults(func=cmd_exif)

    p = add("palette", aliases=["colors"], help="提取主色调色板")
    p.add_argument("--count", type=int, default=6, help="颜色数量(默认 6)")
    p.set_defaults(func=cmd_palette)

    p = add("diff", help="比较两张图的差异(是否一致/差异比例/可视化)")
    p.add_argument("--threshold", type=int, default=12, help="判定为差异的像素阈值(默认 12)")
    p.add_argument("--align", action="store_true", help="尺寸不同时先把 B 对齐到 A")
    p.add_argument("--heatmap", action="store_true", help="输出红白热力差异图")
    p.set_defaults(func=cmd_diff)

    p = add("base64", aliases=["b64"], help="图片 ⇄ base64/DataURI", with_input=False)
    p.add_argument("-i", "--input", nargs="+", help="输入(解码时是 .txt/.b64 文本文件)")
    p.add_argument("--decode", action="store_true", help="base64 文本 → 图片")
    p.add_argument("--ext", default=None, help="解码时的输出扩展名(默认 .png)")
    p.add_argument("--format", default=None, help="编码前先转成该格式(如 webp)")
    p.add_argument("--preview", action="store_true", help="只给前 64 字符预览(默认输出完整 base64)")
    p.add_argument("--data-uri", action="store_true", help="写文件时写成 data:image/... 形式")
    p.set_defaults(func=cmd_base64)

    # —— 几何
    p = add("resize", aliases=["scale"], help="缩放:按尺寸/宽/高/百分比/长边限制")
    p.add_argument("--size", help="精确尺寸,如 800x600(默认拉伸)")
    p.add_argument("--width", type=int, help="目标宽度(高度等比)")
    p.add_argument("--height", type=int, help="目标高度(宽度等比)")
    p.add_argument("--percent", type=float, help="缩放百分比,如 50")
    p.add_argument("--max-side", type=int, help="限制长边(等比缩小)")
    p.add_argument("--max-width", type=int, help="限制宽度")
    p.add_argument("--max-height", type=int, help="限制高度")
    p.add_argument("--fit", choices=["fill", "contain", "cover", "inside"], default=None,
                   help="fill=拉伸(默认配合 --size),contain=留边,cover=裁剪填满,inside=等比不超框")
    p.add_argument("--no-upscale", action="store_true", help="比原图大时不放大")
    p.add_argument("--resample", choices=list(RESAMPLE), default="lanczos", help="重采样算法")
    p.set_defaults(func=cmd_resize)

    p = add("crop", help="裁剪:坐标框/尺寸+锚点/宽高比")
    p.add_argument("--box", help="裁剪框 左,上,右,下")
    p.add_argument("--size", help="裁剪尺寸 WxH")
    p.add_argument("--aspect", help="目标宽高比,如 16:9、1:1")
    p.add_argument("--position", default="center", help="锚点 center/top-left/… 或 x,y")
    p.set_defaults(func=cmd_crop)

    p = add("trim", aliases=["autocrop"], help="自动裁掉四周纯色/透明边")
    p.add_argument("--tolerance", type=int, default=0, help="与背景色的容差(默认 0)")
    p.add_argument("--padding", type=int, default=0, help="保留边距像素")
    p.add_argument("--strict", action="store_true", help="整图纯色时报错而不是原样输出")
    p.set_defaults(func=cmd_trim)

    p = add("rotate", help="旋转(正数=顺时针)")
    p.add_argument("--angle", type=float, required=True, help="角度,如 90、-15")
    p.add_argument("--expand", action=argparse.BooleanOptionalAction, default=None,
                   help="是否扩大画布(90 的倍数默认否,其他默认是)")
    p.add_argument("--resample", choices=list(RESAMPLE), default="bicubic", help="重采样算法")
    p.set_defaults(func=cmd_rotate)

    p = add("flip", help="水平/垂直翻转")
    p.add_argument("--direction", default="h", choices=["h", "v", "both"], help="h 水平 / v 垂直 / both 旋转180")
    p.set_defaults(func=cmd_flip)

    p = add("pad", aliases=["border", "expand"], help="扩边/加边框/留白")
    p.add_argument("--pad", type=int, default=0, help="四边各扩多少像素")
    p.add_argument("--pad-left", type=int, default=None)
    p.add_argument("--pad-top", type=int, default=None)
    p.add_argument("--pad-right", type=int, default=None)
    p.add_argument("--pad-bottom", type=int, default=None)
    p.add_argument("--size", help="目标画布尺寸 WxH(居中/按 --position)")
    p.add_argument("--position", default="center", help="原图在画布中的位置")
    p.set_defaults(func=cmd_pad)

    p = add("round", aliases=["rounded", "circle"], help="圆角/圆形(头像、App 图标)")
    p.add_argument("--radius", type=float, default=0, help="圆角半径(像素)")
    p.add_argument("--radius-percent", type=float, default=None, help="圆角半径占短边百分比")
    p.add_argument("--circle", action="store_true", help="裁成圆形(自动先裁正方形)")
    p.add_argument("--border", type=int, default=0, help="描边宽度")
    p.add_argument("--border-color", default="#ffffff", help="描边颜色")
    p.set_defaults(func=cmd_round)

    # —— 体积与格式
    p = add("compress", aliases=["optimize"], help="压缩:指定质量或目标体积")
    p.add_argument("--target-size", help="目标体积,如 200KB、1.5MB(自动挑质量/尺寸)")
    p.add_argument("--max-side", type=int, help="同时限制长边")
    p.add_argument("--format", default=None, help="输出格式(默认保持原格式;webp 通常更小)")
    p.add_argument("--lossless", action="store_true", help="WebP 无损模式")
    p.add_argument("--min-quality", type=int, default=25, help="目标体积模式下的质量下限(默认 25)")
    p.add_argument("--max-quality", type=int, default=92, help="目标体积模式下的质量上限(默认 92)")
    p.set_defaults(func=cmd_compress)

    p = add("convert", aliases=["format"], help="格式转换 png/jpg/webp/avif/gif/bmp/tiff/ico/pdf")
    p.add_argument("--format", required=True, help="目标格式")
    p.add_argument("--lossless", action="store_true", help="WebP 无损")
    p.add_argument("--colors", type=int, default=256, help="GIF 调色板颜色数")
    p.add_argument("--dpi", type=float, default=None, help="PDF/JPEG 写入的 DPI")
    p.set_defaults(func=cmd_convert)

    p = add("thumbnail", aliases=["thumb"], help="快速生成缩略图(缩放+压缩)")
    p.add_argument("--max-side", type=int, default=512, help="长边上限(默认 512)")
    p.add_argument("--format", default=None, help="输出格式(如 webp)")
    p.set_defaults(func=cmd_thumbnail)

    p = add("strip", aliases=["clean"], help="清除 EXIF/ICC 等元数据(隐私安全)")
    p.set_defaults(func=cmd_strip)

    p = add("favicon", help="生成 favicon.ico(多尺寸)及可选 PNG 图标集")
    p.add_argument("--sizes", default="16,32,48,64,128,256", help="包含的尺寸列表")
    p.add_argument("--png-dir", default=None, help="同时输出各尺寸 PNG 到该目录")
    p.add_argument("--square", action=argparse.BooleanOptionalAction, default=True, help="先裁成正方形(默认是)")
    p.set_defaults(func=cmd_favicon)

    # —— 调色与滤镜
    p = add("adjust", help="亮度/对比度/饱和度/锐度/模糊/伽马/色温")
    p.add_argument("--brightness", type=float, default=1.0, help="1.0 不变,>1 更亮")
    p.add_argument("--contrast", type=float, default=1.0)
    p.add_argument("--saturation", type=float, default=1.0, help="0=灰度")
    p.add_argument("--sharpness", type=float, default=1.0)
    p.add_argument("--blur", type=float, default=0.0, help="高斯模糊半径")
    p.add_argument("--gamma", type=float, default=1.0)
    p.add_argument("--temperature", type=float, default=0.0, help="色温 -100(冷)~100(暖)")
    p.add_argument("--auto-contrast", action="store_true", help="自动对比度")
    p.add_argument("--equalize", action="store_true", help="直方图均衡")
    p.add_argument("--cutoff", type=int, default=0, help="自动对比度忽略的极端像素百分比")
    p.set_defaults(func=cmd_adjust)

    p = add("filter", aliases=["effect"], help="预设滤镜:" + "/".join(FILTER_PRESETS))
    p.add_argument("--preset", required=True, choices=FILTER_PRESETS, help="滤镜名")
    p.add_argument("--box", default=None, help="只对该区域生效:左,上,右,下(打码/局部模糊)")
    p.add_argument("--radius", type=float, default=None, help="模糊半径/中值滤波尺寸")
    p.add_argument("--amount", type=float, default=1.0, help="锐化强度系数")
    p.add_argument("--bits", type=int, default=3, help="posterize 保留位数(1-8)")
    p.add_argument("--threshold", type=int, default=128, help="solarize 阈值")
    p.add_argument("--pixel-size", type=int, default=12, help="pixelate 马赛克块大小")
    p.set_defaults(func=cmd_filter)

    # —— 抠图
    p = add("removebg", aliases=["rmbg", "cutout"], help="抠图去背景(本地算法,输出透明 PNG)")
    p.add_argument("--method", choices=["auto", "flood", "global", "rembg"], default="auto",
                   help="flood=抠与边界连通的背景(默认),global=全图该色都去掉,rembg=AI 模型(需另装)")
    p.add_argument("--bg-color", default="auto", help="背景色,默认从四边自动采样")
    p.add_argument("--tolerance", type=int, default=30, help="背景色容差 0-255(默认 30,越大抠得越狠)")
    p.add_argument("--feather", type=float, default=1.5, help="边缘羽化半径(默认 1.5,0=硬边)")
    p.add_argument("--no-feather", action="store_true", help="不羽化")
    p.add_argument("--hard-edge", action="store_true", help="不生成半透明过渡(纯二值 alpha)")
    p.add_argument("--trim", action="store_true", help="抠完自动裁掉四周透明边")
    p.add_argument("--trim-padding", type=int, default=0, help="裁边时保留的边距")
    p.set_defaults(func=cmd_removebg)

    p = add("transparent", aliases=["colorkey"], help="把指定颜色变透明(色键抠图)")
    p.add_argument("--color", default="auto", help="要去掉的颜色,如 #ffffff;auto=从四边采样")
    p.add_argument("--tolerance", type=int, default=30, help="颜色容差")
    p.add_argument("--global", dest="global_scope", action="store_true", help="全图该颜色都去掉(默认只去与边界连通的)")
    p.add_argument("--feather", type=float, default=1.0, help="边缘羽化半径")
    p.add_argument("--no-feather", action="store_true")
    p.add_argument("--hard-edge", action="store_true")
    p.set_defaults(func=cmd_transparent)

    # —— 合成
    p = add("watermark", help="加水印/贴 logo(支持平铺、旋转、描边)")
    p.add_argument("--text", default=None, help="水印文字(支持 \\n 换行)")
    p.add_argument("--image", default=None, help="水印图片路径(logo)")
    p.add_argument("--position", default="bottom-right", help="位置 center/top-left/… 或 x,y")
    p.add_argument("--margin", type=int, default=24, help="距边缘留白(默认 24)")
    p.add_argument("--opacity", type=float, default=None, help="不透明度 0-1")
    p.add_argument("--angle", type=float, default=0, help="水印旋转角度")
    p.add_argument("--scale", type=float, default=None, help="图片水印宽度占比(默认 0.18)")
    p.add_argument("--font-size", type=int, default=None, help="文字大小(默认按图短边 4.5%%)")
    p.add_argument("--font", default=None, help="字体文件路径")
    p.add_argument("--color", default="#ffffff", help="文字颜色")
    p.add_argument("--stroke-width", type=int, default=2, help="文字描边宽度(0=不描边)")
    p.add_argument("--stroke-color", default="#000000", help="文字描边颜色")
    p.add_argument("--line-spacing", type=int, default=6, help="多行间距")
    p.add_argument("--text-padding", type=int, default=2, help="文字周围留白")
    p.add_argument("--tile", action="store_true", help="平铺水印")
    p.add_argument("--tile-gap", type=int, default=80, help="平铺间距")
    p.add_argument("--keep-alpha", action="store_true", help="输出保留透明通道")
    p.set_defaults(func=cmd_watermark)

    p = add("collage", aliases=["montage", "join"], help="多图拼接(横排/竖排/网格)")
    p.add_argument("--layout", choices=["h", "v", "grid"], default="h", help="排列方式")
    p.add_argument("--cols", type=int, default=0, help="grid 模式的列数")
    p.add_argument("--gap", type=int, default=0, help="间距像素")
    p.add_argument("--cell", help="每格尺寸 WxH(grid 模式配合 --cols)")
    p.add_argument("--labels", default=None, help="每格标签,逗号分隔")
    p.add_argument("--label-size", type=int, default=28, help="标签字号")
    p.add_argument("--fit", choices=["contain", "cover"], default="contain", help="grid 填充方式")
    p.add_argument("--ext", default=None, help="输出扩展名(默认 .png)")
    p.set_defaults(func=cmd_collage)

    p = add("compare", aliases=["before-after"], help="生成 before/after 对比图")
    p.add_argument("--layout", choices=["lr", "tb"], default="lr", help="lr 左右 / tb 上下")
    p.add_argument("--gap", type=int, default=24, help="两图间距")
    p.add_argument("--labels", default=None, help="两个标签,逗号分隔(默认 BEFORE,AFTER)")
    p.add_argument("--label-size", type=int, default=28, help="标签字号")
    p.add_argument("--width", type=int, default=None, help="每张图的最大宽度")
    p.add_argument("--ext", default=None, help="输出扩展名(默认 .png)")
    p.set_defaults(func=cmd_compare)

    p = add("grid", aliases=["slice", "split"], help="九宫格/切图:一张图切成多张")
    p.add_argument("--rows", type=int, default=3, help="行数(默认 3)")
    p.add_argument("--cols", type=int, default=3, help="列数(默认 3)")
    p.add_argument("--count", type=int, default=0, help="切 N 份(自动算行列,覆盖 --rows/--cols)")
    p.add_argument("--ext", default=None, help="输出扩展名(默认同输入)")
    p.set_defaults(func=cmd_grid)

    p = add("overlay", help="把第二张图叠加到第一张上(贴图/合成)")
    p.add_argument("--scale", type=float, default=None, help="叠加图宽度占比")
    p.add_argument("--size", default=None, help="叠加图尺寸 WxH")
    p.add_argument("--position", default="center", help="叠加位置")
    p.add_argument("--opacity", type=float, default=1.0, help="不透明度")
    p.add_argument("--offset-x", type=int, default=0, help="位置微调 X")
    p.add_argument("--offset-y", type=int, default=0, help="位置微调 Y")
    p.set_defaults(func=cmd_overlay)

    # —— 生成与动图
    p = add("placeholder", help="生成占位图/纯色图/渐变图", with_input=False)
    p.add_argument("--size", required=True, help="尺寸 WxH,如 800x600")
    p.add_argument("--text", default=None, help="图上文字(默认显示尺寸)")
    p.add_argument("--gradient", default=None, help="渐变两端颜色,如 '#ff0066,#3300ff'")
    p.add_argument("--gradient-angle", type=float, default=45, help="渐变角度")
    p.add_argument("--color", default=None, help="文字颜色(默认按背景亮度自动选黑/白)")
    p.add_argument("--font-size", type=int, default=None, help="文字大小")
    p.add_argument("--font", default=None, help="字体文件路径")
    p.add_argument("--stroke-width", type=int, default=0, help="文字描边宽度")
    p.add_argument("--stroke-color", default=None, help="文字描边颜色(默认按背景自动选)")
    p.add_argument("--ext", default=".png", help="输出扩展名(默认 .png)")
    p.set_defaults(func=cmd_placeholder)

    p = add("gif", help="把多张图合成 GIF 动图")
    p.add_argument("--duration", type=int, default=200, help="每帧毫秒(默认 200)")
    p.add_argument("--loop", type=int, default=0, help="循环次数,0=无限")
    p.add_argument("--size", default=None, help="统一尺寸 WxH(默认取第一帧)")
    p.add_argument("--from-dir", action="store_true", help="允许输入目录作为帧序列")
    p.set_defaults(func=cmd_gif)

    p = add("frames", aliases=["unpack"], help="GIF/动图拆帧为 PNG")
    p.set_defaults(func=cmd_frames)

    return parser


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "cmd", None):
        parser.print_help()
        return 0
    t0 = time.time()
    try:
        res = args.func(args)
    except ToolError as exc:
        emit({"ok": False, "cmd": args.cmd, "error": str(exc),
              "hint": "imgtool %s --help 查看该命令参数" % args.cmd}, getattr(args, "pretty", False))
        return 2
    except KeyboardInterrupt:
        emit({"ok": False, "cmd": args.cmd, "error": "已中断"})
        return 130
    except Exception as exc:
        emit({"ok": False, "cmd": args.cmd, "error": "%s: %s" % (type(exc).__name__, exc),
              "hint": "这是非预期错误,可加 --pretty 复现后排查"})
        return 1
    if isinstance(res, int):
        return res
    payload, rc = summarize(res)
    payload["cmd"] = args.cmd
    payload["elapsed_ms"] = round((time.time() - t0) * 1000)
    emit(payload, getattr(args, "pretty", False))
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
