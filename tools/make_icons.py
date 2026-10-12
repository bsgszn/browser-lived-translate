"""生成 livedtranslate 扩展图标（深色圆角底 + 蓝色声波）。仅用于构建期，产物是 PNG。"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
os.makedirs(OUT, exist_ok=True)

SS = 8  # 超采样倍率，保证 16px 下也干净


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make(size):
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # 圆角底：垂直渐变
    top, bottom = (26, 44, 78), (11, 14, 19)
    grad = Image.new("RGBA", (s, s))
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        gd.line([(0, y), (s, y)], fill=lerp(top, bottom, y / max(1, s - 1)) + (255,))

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.24), fill=255)
    img.paste(grad, (0, 0), mask)

    # 蓝色描边
    ImageDraw.Draw(img).rounded_rectangle(
        [1 * SS, 1 * SS, s - 1 - 1 * SS, s - 1 - 1 * SS],
        radius=int(s * 0.24),
        outline=(74, 158, 255, 90),
        width=max(1, SS),
    )

    # 声波：5 根圆头竖条
    d = ImageDraw.Draw(img)
    heights = [0.30, 0.56, 0.82, 0.56, 0.30]
    bar_w = s * 0.085
    gap = s * 0.052
    total = len(heights) * bar_w + (len(heights) - 1) * gap
    x = (s - total) / 2
    cy = s / 2
    for i, h in enumerate(heights):
        bh = s * h
        t = abs(i - 2) / 2
        color = lerp((140, 205, 255), (58, 140, 245), t)
        d.rounded_rectangle(
            [x, cy - bh / 2, x + bar_w, cy + bh / 2],
            radius=bar_w / 2,
            fill=color + (255,),
        )
        x += bar_w + gap

    return img.resize((size, size), Image.LANCZOS)


for px in (16, 32, 48, 128):
    make(px).save(os.path.join(OUT, f"icon{px}.png"))
    print("wrote", os.path.join(OUT, f"icon{px}.png"))
