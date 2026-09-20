#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""imgtool 自测:自造素材跑通全部命令,并对产物做像素级断言。

不依赖任何外部图片,可随时运行(改完 imgtool.py 后跑一遍即可):
    python selftest.py            # 在系统临时目录里测,结束后清理
    python selftest.py --keep     # 保留产物以便肉眼检查
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

TOOL = Path(__file__).resolve().with_name("imgtool.py")
PASS, FAIL = [], []


def cli(*argv):
    p = subprocess.run([sys.executable, str(TOOL), *[str(a) for a in argv]],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (p.stdout or "").strip()
    try:
        data = json.loads(out.splitlines()[-1]) if out else {}
    except Exception:
        return {"ok": False, "error": "无法解析输出: %s | %s" % (out[:200], (p.stderr or "")[:200])}
    # 契约校验:退出码必须与 ok 一致。否则"先打印结果、随后崩溃"这类隐性故障会被漏掉
    if data.get("ok") and p.returncode != 0:
        data["ok"] = False
        data["error"] = "退出码 %d 与 ok:true 不一致 | stderr: %s" % (p.returncode, (p.stderr or "").strip()[-200:])
    if not data.get("ok") and p.returncode == 0:
        data["ok"] = False
        data["error"] = "报告失败但退出码为 0: %s" % (data.get("error") or data.get("errors"))
    return data


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print("%s %-30s %s" % ("PASS" if cond else "FAIL", name, extra if not cond else ""))


def run(name, argv, cond=None):
    data = cli(*argv)
    ok = bool(data.get("ok"))
    if ok and cond:
        try:
            ok = bool(cond(data))
        except Exception as exc:
            ok, data = False, {"error": "断言异常 %s" % exc}
    check(name, ok, str(data.get("error") or data.get("errors") or "")[:150])
    return data


def px(path):
    return Image.open(path).convert("RGBA")


def near(a, b, tol=6):
    """JPEG/WebP 有损,颜色断言留容差。"""
    return all(abs(int(x) - int(y)) <= tol for x, y in zip(a, b))


def alpha_share(path):
    a = px(path).getchannel("A")
    hist = a.histogram()
    return sum(hist[:128]) / float(sum(hist))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default=None, help="工作目录(默认系统临时目录)")
    ap.add_argument("--keep", action="store_true", help="保留产物")
    a = ap.parse_args()
    work = Path(a.work) if a.work else Path(tempfile.mkdtemp(prefix="imgtool-selftest-"))
    work.mkdir(parents=True, exist_ok=True)
    o = lambda n: str(work / n)  # noqa: E731

    print("工作目录:", work)
    check("doctor", cli("doctor").get("ok") is True)

    # ---- 素材(白底黑字,便于验证抠图) ----
    run("placeholder-素材", ["placeholder", "--size", "600x400", "--text", "HELLO",
                          "--color", "#000000", "-o", o("src.png")])
    run("placeholder-渐变", ["placeholder", "--size", "600x400", "--gradient", "#ff0066,#3300ff", "-o", o("grad.png")])
    run("placeholder-透明", ["placeholder", "--size", "300x300", "--background", "transparent", "-o", o("trans.png")])
    src = px(o("src.png"))
    check("placeholder-尺寸", src.size == (600, 400), str(src.size))

    # ---- 几何 ----
    run("resize-精确", ["resize", "-i", o("src.png"), "--size", "400x300", "-o", o("r1.png")],
        lambda d: (d["results"][0]["width"], d["results"][0]["height"]) == (400, 300))
    run("resize-长边", ["resize", "-i", o("src.png"), "--max-side", "320", "-o", o("r2.png")],
        lambda d: max(Image.open(o("r2.png")).size) == 320)
    run("resize-contain", ["resize", "-i", o("src.png"), "--size", "200x200", "--fit", "contain",
                           "--background", "#ffffff", "-o", o("r3.png")],
        lambda d: Image.open(o("r3.png")).size == (200, 200))
    run("crop-比例", ["crop", "-i", o("src.png"), "--aspect", "1:1", "-o", o("c1.png")],
        lambda d: abs(Image.open(o("c1.png")).width - Image.open(o("c1.png")).height) <= 1)
    run("crop-坐标", ["crop", "-i", o("src.png"), "--box", "10,20,210,220", "-o", o("c2.png")],
        lambda d: Image.open(o("c2.png")).size == (200, 200))
    run("rotate-90", ["rotate", "-i", o("src.png"), "--angle", "90", "-o", o("rot.png")])
    run("rotate-30", ["rotate", "-i", o("src.png"), "--angle", "30", "-o", o("rot30.png")],
        lambda d: Image.open(o("rot30.png")).width > 600)
    run("flip-水平", ["flip", "-i", o("src.png"), "--direction", "h", "-o", o("flip.png")],
        lambda d: px(o("flip.png")).getpixel((0, 10)) == src.getpixel((599, 10)))
    run("pad-像素", ["pad", "-i", o("src.png"), "--pad", "20", "--background", "#ff0000", "-o", o("pad.png")],
        lambda d: Image.open(o("pad.png")).size == (640, 440) and px(o("pad.png")).getpixel((2, 2))[:3] == (255, 0, 0))
    run("trim-裁边", ["trim", "-i", o("pad.png"), "-o", o("trimmed.png")],
        lambda d: Image.open(o("trimmed.png")).size == (600, 400))
    run("round-圆形", ["round", "-i", o("src.png"), "--circle", "-o", o("circle.png")])
    cir = px(o("circle.png"))
    check("round-四角透明", cir.getpixel((0, 0))[3] == 0 and cir.getpixel((399, 399))[3] == 0)
    check("round-中心不透明", cir.getpixel((200, 200))[3] == 255)
    run("round-圆角", ["round", "-i", o("src.png"), "--radius-percent", "15", "-o", o("rounded.png")],
        lambda d: px(o("rounded.png")).getpixel((300, 0))[3] == 255)

    # ---- 体积与格式 ----
    run("compress-目标体积", ["compress", "-i", o("src.png"), "--target-size", "30KB", "-o", o("small.jpg")],
        lambda d: (work / "small.jpg").stat().st_size <= 30 * 1024)
    run("compress-质量", ["compress", "-i", o("src.png"), "--quality", "60", "-o", o("q60.jpg")])
    run("convert-webp", ["convert", "-i", o("src.png"), "--format", "webp", "-o", o("c.webp")],
        lambda d: Image.open(o("c.webp")).format == "WEBP")
    run("convert-jpg白底", ["convert", "-i", o("trans.png"), "--format", "jpg", "--background", "#438edb",
                            "-o", o("blue.jpg")],
        lambda d: near(Image.open(o("blue.jpg")).convert("RGB").getpixel((2, 2)), (67, 142, 219)))
    run("thumbnail", ["thumbnail", "-i", o("src.png"), "--max-side", "200", "--format", "webp", "-o", o("th.webp")],
        lambda d: max(Image.open(o("th.webp")).size) == 200)
    run("strip", ["strip", "-i", o("src.png"), "-o", o("clean.png")])
    run("favicon", ["favicon", "-i", o("src.png"), "-o", o("fav.ico"), "--png-dir", o("icons")],
        lambda d: (work / "fav.ico").exists() and len(list((work / "icons").glob("*.png"))) == 6)

    # ---- 调色/滤镜 ----
    run("adjust", ["adjust", "-i", o("src.png"), "--brightness", "1.3", "--saturation", "1.5", "-o", o("adj.png")])
    run("filter-灰度", ["filter", "-i", o("grad.png"), "--preset", "grayscale", "-o", o("gray.png")])
    grad = px(o("grad.png"))
    run("filter-局部打码", ["filter", "-i", o("grad.png"), "--preset", "pixelate", "--pixel-size", "16",
                          "--box", "0,0,200,200", "-o", o("mosaic.png")],
        lambda d: px(o("mosaic.png")).crop((0, 0, 100, 100)).tobytes() != grad.crop((0, 0, 100, 100)).tobytes()
        and px(o("mosaic.png")).crop((300, 300, 400, 400)).tobytes() == grad.crop((300, 300, 400, 400)).tobytes())

    # ---- 抠图(核心) ----
    run("removebg-白底", ["removebg", "-i", o("src.png"), "-o", o("cut.png")],
        lambda d: d["results"][0].get("chosen", {}).get("removed_pct", 0) > 60)
    cut = px(o("cut.png"))
    check("removebg-四角透明", all(cut.getpixel(p)[3] == 0 for p in ((0, 0), (599, 0), (0, 399), (599, 399))))
    mid = cut.getchannel("A").histogram()
    check("removebg-主体保留", sum(mid[200:]) > 500, "不透明像素=%d" % sum(mid[200:]))
    check("removebg-有羽化边", sum(mid[20:235]) > 50, "半透明=%d" % sum(mid[20:235]))
    run("removebg-裁边", ["removebg", "-i", o("src.png"), "-o", o("cut_trim.png"), "--trim"],
        lambda d: Image.open(o("cut_trim.png")).width < 600)
    run("removebg-hard", ["removebg", "-i", o("src.png"), "-o", o("cut_hard.png"), "--hard-edge", "--no-feather"],
        lambda d: sum(px(o("cut_hard.png")).getchannel("A").histogram()[20:235]) == 0)
    run("transparent-色键", ["transparent", "-i", o("src.png"), "--color", "#000000", "--global",
                           "-o", o("noblack.png")],
        lambda d: alpha_share(o("noblack.png")) > 0.005
        and px(o("noblack.png")).getpixel((0, 0))[3] == 255)

    # ---- 合成 ----
    run("watermark-文字", ["watermark", "-i", o("grad.png"), "--text", "测试水印 ©", "-o", o("wm.png")],
        lambda d: px(o("wm.png")).crop((300, 300, 600, 400)).tobytes()
        != grad.crop((300, 300, 600, 400)).tobytes())
    check("watermark-未破坏左上", px(o("wm.png")).crop((0, 0, 100, 100)).tobytes()
          == grad.crop((0, 0, 100, 100)).tobytes())
    run("watermark-平铺", ["watermark", "-i", o("grad.png"), "--text", "DRAFT", "--tile", "--angle", "30",
                         "--opacity", "0.3", "-o", o("wm_tile.png")])
    run("watermark-贴图", ["watermark", "-i", o("grad.png"), "--image", o("circle.png"), "--scale", "0.2",
                         "--position", "top-left", "-o", o("wm_img.png")])
    run("overlay", ["overlay", "-i", o("grad.png"), o("circle.png"), "--scale", "0.3", "--position", "bottom-right",
                    "-o", o("ov.png")])
    run("collage-横排", ["collage", "-i", o("src.png"), o("circle.png"), "--gap", "10", "--background", "white",
                       "-o", o("col.png")],
        lambda d: Image.open(o("col.png")).width > 600)
    run("collage-网格", ["collage", "-i", o("src.png"), o("circle.png"), o("rounded.png"), o("th.webp"),
                       "--layout", "grid", "--cols", "2", "--cell", "200x200", "--gap", "8", "-o", o("grid2.png")],
        lambda d: Image.open(o("grid2.png")).size == (408, 408))
    run("compare", ["compare", "-i", o("src.png"), o("adj.png"), "--labels", "改前,改后", "-o", o("cmp.png")],
        lambda d: Image.open(o("cmp.png")).width > 600)
    run("grid-切图", ["grid", "-i", o("src.png"), "--rows", "3", "--cols", "2", "-o", o("tiles")],
        lambda d: len(list((work / "tiles").glob("*.png"))) == 6)
    check("grid-每块尺寸", Image.open(sorted((work / "tiles").glob("*.png"))[0]).size == (300, 133))

    # ---- 动图/分析/编码 ----
    run("placeholder-帧1", ["placeholder", "--size", "400x400", "--background", "#ff2222", "--text", "1",
                          "-o", o("f1.png")])
    run("placeholder-帧2", ["placeholder", "--size", "400x400", "--background", "#22ff22", "--text", "2",
                          "-o", o("f2.png")])
    run("placeholder-帧3", ["placeholder", "--size", "400x400", "--background", "#2222ff", "--text", "3",
                          "-o", o("f3.png")])
    run("gif-合成", ["gif", "-i", o("f1.png"), o("f2.png"), o("f3.png"), "-o", o("anim.gif")],
        lambda d: Image.open(o("anim.gif")).n_frames == 3)
    run("frames-拆帧", ["frames", "-i", o("anim.gif"), "-o", o("frames")],
        lambda d: len(list((work / "frames").glob("*.png"))) == 3)
    run("info", ["info", "-i", o("src.png"), "--colors", "4"],
        lambda d: len(d["results"][0]["dominant_colors"]) == 4)
    run("palette", ["palette", "-i", o("grad.png"), "--count", "5"],
        lambda d: len(d["results"][0]["colors"]) == 5)
    run("exif", ["exif", "-i", o("src.png")])
    run("diff-同图", ["diff", "-i", o("src.png"), o("src.png")], lambda d: d["identical"] is True)
    run("diff-异图", ["diff", "-i", o("src.png"), o("adj.png")], lambda d: d["identical"] is False)
    run("base64-编码", ["base64", "-i", o("circle.png")],
        lambda d: d["results"][0]["data_uri"].startswith("data:image/png;base64,"))
    run("base64-预览", ["base64", "-i", o("circle.png"), "--preview"],
        lambda d: "preview" in d["results"][0] and "data_uri" not in d["results"][0])
    run("base64-写文件", ["base64", "-i", o("circle.png"), "-o", o("c.b64.txt"), "--data-uri", "--preview"],
        lambda d: (work / "c.b64.txt").exists())
    run("base64-解码", ["base64", "--decode", "-i", o("c.b64.txt"), "-o", o("back.png")],
        lambda d: (work / "back.png").stat().st_size > 100)

    # ---- 错误路径:必须失败且说人话 ----
    check("错误-文件不存在", cli("info", "-i", o("nope.png")).get("ok") is False)
    check("错误-覆盖输入", cli("resize", "-i", o("src.png"), "--max-side", "50", "-o", o("src.png")).get("ok") is False)
    check("错误-坏参数", cli("compress", "-i", o("src.png"), "--quality", "50", "--target-size", "10KB").get("ok") is False)

    print("\n==== 自测 %d 项,通过 %d,失败 %d ====" % (len(PASS) + len(FAIL), len(PASS), len(FAIL)))
    for n in FAIL:
        print("  FAIL", n)
    if a.keep or FAIL:
        print("产物保留在:", work)
    else:
        shutil.rmtree(work, ignore_errors=True)
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
