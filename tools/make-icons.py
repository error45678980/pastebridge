#!/usr/bin/env python3
"""生成扩展图标（零依赖，纯标准库）。

用法：python tools/make-icons.py
输出：icons/16.png 32.png 48.png 128.png

设计：圆角方块蓝紫渐变底 + 白色「向下插入」箭头 + 底部托盘。
每个尺寸独立按 5x5 超采样渲染，保证 16px 下也清晰。
"""

import os
import struct
import zlib

SIZES = [16, 32, 48, 128]
SS = 5  # 每个像素的超采样倍数（SS x SS）

BG_TOP = (37, 99, 235)     # #2563eb
BG_BOTTOM = (109, 40, 217)  # #6d28d9
FG = (255, 255, 255)

# 归一化坐标（0..1）
BG_RADIUS = 0.225
STEM = (0.455, 0.225, 0.545, 0.565, 0.015)      # x0, y0, x1, y1, r
HEAD = ((0.315, 0.515), (0.685, 0.515), (0.5, 0.715))
TRAY = (0.295, 0.765, 0.705, 0.825, 0.03)


def in_rrect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def in_triangle(x, y, pts):
    (x1, y1), (x2, y2), (x3, y3) = pts
    d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2)
    d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3)
    d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def in_glyph(x, y):
    if in_rrect(x, y, *STEM):
        return True
    if in_triangle(x, y, HEAD):
        return True
    if in_rrect(x, y, *TRAY):
        return True
    return False


def lerp(a, b, t):
    return int(round(a + (b - a) * t))


def render(size):
    buf = bytearray(size * size * 4)
    step = 1.0 / (size * SS)
    total = SS * SS
    for py in range(size):
        for px in range(size):
            ar = ag = ab = aa = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px * SS + sx + 0.5) * step
                    y = (py * SS + sy + 0.5) * step
                    if not in_rrect(x, y, 0.0, 0.0, 1.0, 1.0, BG_RADIUS):
                        continue
                    aa += 1
                    if in_glyph(x, y):
                        ar += FG[0]
                        ag += FG[1]
                        ab += FG[2]
                    else:
                        ar += lerp(BG_TOP[0], BG_BOTTOM[0], y)
                        ag += lerp(BG_TOP[1], BG_BOTTOM[1], y)
                        ab += lerp(BG_TOP[2], BG_BOTTOM[2], y)
            i = (py * size + px) * 4
            if aa == 0:
                buf[i:i + 4] = b"\x00\x00\x00\x00"
            else:
                # 颜色按覆盖到的采样点平均，alpha 按全部采样点平均
                buf[i] = ar // aa
                buf[i + 1] = ag // aa
                buf[i + 2] = ab // aa
                buf[i + 3] = (aa * 255) // total
    return buf


def write_png(path, size, pixels):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += pixels[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    out = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(out)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in SIZES:
        path = os.path.join(out_dir, "%d.png" % size)
        write_png(path, size, render(size))
        print("wrote %s (%d bytes)" % (path, os.path.getsize(path)))


if __name__ == "__main__":
    main()
