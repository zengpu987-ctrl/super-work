#!/usr/bin/env python3
"""生成 Super Work 的 macOS 应用图标（深底 + 渐变 S，无任何外部资源）。

只依赖 Pillow；生成物：
  resources/AppIcon.icns        —— 构建时直接复制进 .app
  resources/icon-preview.png    —— 1024×1024 预览图（便于检查）

用法：
  python3 resources/make-icon.py            # 写入 resources/
  python3 resources/make-icon.py <out.icns> # 自定义输出
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont

CANVAS = 1024
MARGIN = 60
RADIUS = 230

BRAND_VIOLET = (139, 92, 246)
BRAND_BLUE = (77, 107, 254)
BRAND_CYAN = (34, 211, 238)
BG_TOP = (22, 25, 42)
BG_BOTTOM = (10, 11, 16)

FONT_CANDIDATES = [
    ("/System/Library/Fonts/Helvetica.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
    ("/System/Library/Fonts/SFNS.ttf", 0),
]


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def diagonal_gradient(size: int, bounds: tuple[int, int, int, int] | None = None) -> Image.Image:
    """左上 → 右下 的三段品牌渐变；bounds 用于把渐变聚焦到字母包围盒。"""
    gradient = Image.new("RGB", (size, size))
    x0, y0, x1, y1 = bounds or (0, 0, size - 1, size - 1)
    span_x = max(1, x1 - x0)
    span_y = max(1, y1 - y0)
    span = span_x + span_y
    pixels = []
    stops = [(0.0, BRAND_VIOLET), (0.55, BRAND_BLUE), (1.0, BRAND_CYAN)]
    for y in range(size):
        for x in range(size):
            raw = ((x - x0) + (y - y0)) / span
            t = min(1.0, max(0.0, raw))
            for index in range(len(stops) - 1):
                left_t, left_color = stops[index]
                right_t, right_color = stops[index + 1]
                if left_t <= t <= right_t:
                    local = (t - left_t) / max(1e-6, right_t - left_t)
                    pixels.append(
                        (
                            lerp(left_color[0], right_color[0], local),
                            lerp(left_color[1], right_color[1], local),
                            lerp(left_color[2], right_color[2], local),
                        )
                    )
                    break
            else:
                pixels.append(stops[-1][1])
    gradient.putdata(pixels)
    return gradient


def rounded_mask() -> Image.Image:
    mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [MARGIN, MARGIN, CANVAS - MARGIN, CANVAS - MARGIN],
        radius=RADIUS,
        fill=255,
    )
    return mask


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path, index in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size, index=index)
        except OSError:
            continue
    return ImageFont.load_default()


def build_icon() -> Image.Image:
    icon = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    mask = rounded_mask()

    # 1. 深色底（纵向渐变）
    base = Image.new("RGBA", (CANVAS, CANVAS))
    draw = ImageDraw.Draw(base)
    for y in range(CANVAS):
        t = y / (CANVAS - 1)
        draw.line(
            [(0, y), (CANVAS, y)],
            fill=(
                lerp(BG_TOP[0], BG_BOTTOM[0], t),
                lerp(BG_TOP[1], BG_BOTTOM[1], t),
                lerp(BG_TOP[2], BG_BOTTOM[2], t),
                255,
            ),
        )
    icon.alpha_composite(Image.composite(base, Image.new("RGBA", (CANVAS, CANVAS)), mask))

    # 2. 顶部品牌色光晕
    glow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse([132, -230, 892, 530], fill=(*BRAND_VIOLET, 70))
    glow_draw.ellipse([520, 300, 1180, 960], fill=(*BRAND_CYAN, 26))
    glow = glow.filter(ImageFilter.GaussianBlur(130))
    glow.putalpha(Image.composite(glow.getchannel("A"), Image.new("L", (CANVAS, CANVAS), 0), mask))
    icon.alpha_composite(glow)

    # 3. 细轨道环（多模型协作的隐喻，克制）
    ring = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse(
        [178, 178, CANVAS - 178, CANVAS - 178],
        outline=(255, 255, 255, 26),
        width=4,
    )
    icon.alpha_composite(ring)

    # 4. 渐变字母 S（用遮罩把渐变填进字形）
    font = load_font(590)
    text_mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(text_mask).text(
        (CANVAS // 2, CANVAS // 2 - 6),
        "S",
        font=font,
        fill=255,
        anchor="mm",
    )

    gradient = diagonal_gradient(CANVAS, text_mask.getbbox())

    # 5. 字母外发光（让深底上更有层次）
    halo = text_mask.filter(ImageFilter.GaussianBlur(46))
    halo = halo.point(lambda value: int(value * 0.55))
    halo_layer = Image.new("RGBA", (CANVAS, CANVAS), (*BRAND_BLUE, 0))
    halo_layer.putalpha(halo)
    icon.alpha_composite(halo_layer)

    icon.paste(gradient, (0, 0), text_mask)

    # 6. 内侧高光边
    edge = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        [MARGIN + 2, MARGIN + 2, CANVAS - MARGIN - 2, CANVAS - MARGIN - 2],
        radius=RADIUS - 2,
        outline=(255, 255, 255, 20),
        width=3,
    )
    icon.alpha_composite(edge)
    return icon


def write_icns(icon: Image.Image, out_path: str) -> None:
    specs = [
        (16, 1, "icon_16x16"),
        (16, 2, "icon_16x16@2x"),
        (32, 1, "icon_32x32"),
        (32, 2, "icon_32x32@2x"),
        (128, 1, "icon_128x128"),
        (128, 2, "icon_128x128@2x"),
        (256, 1, "icon_256x256"),
        (256, 2, "icon_256x256@2x"),
        (512, 1, "icon_512x512"),
        (512, 2, "icon_512x512@2x"),
    ]
    with tempfile.TemporaryDirectory(prefix="superwork-icon-") as tmp:
        iconset = os.path.join(tmp, "AppIcon.iconset")
        os.makedirs(iconset, exist_ok=True)
        for size, scale, name in specs:
            pixels = size * scale
            icon.resize((pixels, pixels), Image.LANCZOS).save(os.path.join(iconset, f"{name}.png"))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out_path], check=True)


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    out_icns = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "AppIcon.icns")
    preview = os.path.join(here, "icon-preview.png")

    icon = build_icon()
    icon.save(preview)
    write_icns(icon, out_icns)
    print(f"[icon] {out_icns}")
    print(f"[icon] {preview}")


if __name__ == "__main__":
    main()
