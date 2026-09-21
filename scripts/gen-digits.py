#!/usr/bin/env python3
"""从系统字体里抠出 0-9 的轮廓，生成 src/digits.ts。

汉字来自 hanzi-writer-data，但那个库里**没有阿拉伯数字**，所以数字得自己造。
造出来的坐标系严格对齐汉字那一套（1024 见方、y 轴向上、字身盒子 (0,-124)→(1024,900)），
于是 pathTransform / renderSvg / renderPdf 一行都不用改 —— 数字就是「只有一笔的字」。

    python3 scripts/gen-digits.py > src/digits.ts

换字体就改下面的 FONT。字体只在生成时用到，产物是纯路径，
**不嵌字体、也不依赖运行环境装了什么** —— 跟汉字走的是同一个理由。
"""
import sys

from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont

# Futura Medium：几何造型、笔画粗细均匀，描红时灰色形状看得清；
# 「1」带起笔的小撇（不是光秃秃一竖），「7」不带横杠 —— 跟中文课本一致。
FONT = ("/System/Library/Fonts/Supplemental/Futura.ttc", 0, "Futura Medium")

BOX = 1024
TOP, BOTTOM = 900, -124
HEIGHT = 0.92  # 数字高度占字身盒子的比例，留一点上下余地
DIGITS = "0123456789"


def outline(font, ch):
    pen = RecordingPen()
    font.getGlyphSet()[font.getBestCmap()[ord(ch)]].draw(pen)
    return pen.value


def bbox(rec):
    pts = [p for _, args in rec for p in args if p is not None]
    return (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))


def quads(pts):
    """TrueType 的 qCurveTo 可以连着好几个控制点，中间的在线点取相邻控制点的中点。"""
    if pts[-1] is None:  # 整条轮廓都是离线点，补一个首尾中点当起点
        pts = list(pts[:-1])
        pts.append(((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2))
    for i in range(len(pts) - 1):
        c, nxt = pts[i], pts[i + 1]
        yield c, (nxt if i == len(pts) - 2 else ((c[0] + nxt[0]) / 2, (c[1] + nxt[1]) / 2))


def to_path(rec, xf):
    """→ 只含绝对 M L Q C Z 的 SVG path，这是 transformPath 认的那一套。"""
    f = lambda p: "{:g} {:g}".format(*(round(v, 1) for v in xf(p)))
    out = []
    for op, args in rec:
        if op == "moveTo":
            out.append(f"M {f(args[0])}")
        elif op == "lineTo":
            out.append(f"L {f(args[0])}")
        elif op == "curveTo":
            out.append("C " + " ".join(f(p) for p in args))
        elif op == "qCurveTo":
            out += [f"Q {f(c)} {f(on)}" for c, on in quads(list(args))]
        elif op in ("closePath", "endPath"):
            out.append("Z")
    return " ".join(out)


def main():
    path, index, label = FONT
    font = TTFont(path, fontNumber=index)
    recs = {ch: outline(font, ch) for ch in DIGITS}
    boxes = {ch: bbox(r) for ch, r in recs.items()}

    # 竖向：十个数字**共用**一个缩放，按 0-9 合起来的 bbox 算。
    # 各自归一化的话，6 8 9 0 的圆形出头会被削掉，平顶的 1 4 5 7 反而显得更大。
    lo = min(b[1] for b in boxes.values())
    hi = max(b[3] for b in boxes.values())
    s = BOX * HEIGHT / (hi - lo)
    ty = (TOP + BOTTOM) / 2 - (lo + hi) / 2 * s

    print("// 这个文件是生成的，别手改 —— 改 scripts/gen-digits.py 再重新生成：")
    print("//   python3 scripts/gen-digits.py > src/digits.ts")
    print(f"// 字形来自 {label}，已归一化到 hanzi-writer-data 的坐标系。")
    print()
    print("/** 0-9 的轮廓，坐标系同汉字：1024 见方、y 轴向上、字身盒子 (0,-124)→(1024,900)。 */")
    print("export const DIGIT_PATHS: Record<string, string> = {")
    for ch in DIGITS:
        x0, _, x1, _ = boxes[ch]
        tx = BOX / 2 - (x0 + x1) / 2 * s  # 横向各自居中：数字宽窄不一，居中才像字帖
        print(f"  '{ch}': '{to_path(recs[ch], lambda p: (p[0] * s + tx, p[1] * s + ty))}',")
    print("}")


if __name__ == "__main__":
    sys.exit(main())
