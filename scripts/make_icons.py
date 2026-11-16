"""Regenerate the PNG app icons in public/. Run: python3 scripts/make_icons.py"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public"
BG, AMBER, BLUE = (11, 13, 16), (255, 213, 74), (76, 201, 240)


def icon(size: int, pad: float, rounded: bool) -> Image.Image:
    ss = 4  # supersample for smooth edges
    n = size * ss
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=BG)
    else:
        d.rectangle([0, 0, n, n], fill=BG)

    def P(x, y):  # 512-unit design space, shrunk by pad for maskable safe zone
        s = n / 512 * (1 - 2 * pad)
        return (n * pad + x * s, n * pad + y * s)

    w = int(n / 512 * 30 * (1 - 2 * pad))

    def line(a, b, col, width):
        d.line([P(*a), P(*b)], fill=col, width=width)
        for p in (a, b):
            x, y = P(*p)
            d.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=col)

    line((116, 150), (396, 196), AMBER, w)
    line((116, 362), (396, 316), AMBER, w)
    pts = [(240 + 120 * math.cos(t), 256 + 120 * math.sin(t)) for t in [math.radians(a) for a in range(-33, 34, 3)]]
    for a, b in zip(pts, pts[1:]):
        line(a, b, BLUE, int(w * 0.66))
    return img.resize((size, size), Image.LANCZOS)


icon(192, 0, True).save(OUT / "icon-192.png")
icon(512, 0, True).save(OUT / "icon-512.png")
icon(512, 0.12, False).save(OUT / "icon-maskable-512.png")
icon(180, 0.04, False).convert("RGB").save(OUT / "apple-touch-icon.png")
print("icons written to", OUT)
