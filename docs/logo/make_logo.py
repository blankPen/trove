"""Generate trove's placeholder logo (light + dark) as PNG.

Design: a rounded treasure-chest/vault shape with a glowing gem rising out of it —
"every conversation is a treasure trove".

Run: python3 docs/logo/make_logo.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent

LIGHT = {
    "bg": (255, 255, 255, 0),
    "chest": (37, 99, 235, 255),      # indigo-600
    "chest_dark": (30, 64, 175, 255),  # indigo-700
    "lid": (55, 48, 255, 255),        # indigo-500
    "gem": (250, 204, 21, 255),       # amber-400
    "gem_dark": (245, 158, 11, 255),  # amber-500
    "lock": (255, 255, 255, 255),
}

DARK = {
    "bg": (255, 255, 255, 0),
    "chest": (99, 102, 241, 255),     # indigo-400
    "chest_dark": (79, 70, 229, 255), # indigo-500
    "lid": (129, 140, 248, 255),      # indigo-300
    "gem": (253, 224, 71, 255),       # yellow-300
    "gem_dark": (250, 204, 21, 255),  # amber-400
    "lock": (15, 23, 42, 255),
}

SIZE = 512


def draw_logo(c: dict) -> Image.Image:
    s = SIZE
    img = Image.new("RGBA", (s, s), c["bg"])
    d = ImageDraw.Draw(img)

    # --- gem above the chest (drawn first so the lid overlaps its bottom) ---
    cx = s / 2
    gem_top, gem_mid, gem_base = 60, 150, 232
    gem_half = 74
    d.polygon(
        [
            (cx, gem_top),
            (cx + gem_half, gem_mid),
            (cx, gem_base),
            (cx - gem_half, gem_mid),
        ],
        fill=c["gem"],
    )
    # facet highlight
    d.polygon(
        [
            (cx, gem_top),
            (cx + gem_half, gem_mid),
            (cx, gem_mid),
            (cx - gem_half, gem_mid),
        ],
        fill=c["gem_dark"],
    )
    d.polygon(
        [
            (cx, gem_top),
            (cx + gem_half * 0.42, gem_mid),
            (cx, gem_mid),
        ],
        fill=(255, 255, 255, 140),
    )

    # --- chest body ---
    body_l, body_r = 74, s - 74
    body_top, body_bot = 244, s - 84
    radius = 26
    d.rounded_rectangle(
        [body_l, body_top, body_r, body_bot],
        radius=radius,
        fill=c["chest"],
    )

    # --- lid ---
    lid_top = 208
    d.rounded_rectangle(
        [body_l, lid_top, body_r, body_top + 74],
        radius=radius,
        fill=c["lid"],
    )
    # flat bottom edge of the lid so it reads as a lid, not a second box
    d.rectangle([body_l, lid_top + 40, body_r, lid_top + 74], fill=c["lid"])

    # --- lid rim ---
    d.rounded_rectangle(
        [body_l - 10, lid_top + 56, body_r + 10, lid_top + 84],
        radius=12,
        fill=c["chest_dark"],
    )

    # --- lock plate ---
    d.rounded_rectangle(
        [cx - 34, lid_top + 84, cx + 34, body_bot - 6],
        radius=12,
        fill=c["chest_dark"],
    )
    d.ellipse([cx - 11, lid_top + 96, cx + 11, lid_top + 118], fill=c["lock"])

    # --- base shadow strip ---
    d.rounded_rectangle(
        [body_l, body_bot - 22, body_r, body_bot],
        radius=radius,
        fill=c["chest_dark"],
    )

    return img


def main() -> None:
    for name, palette in (("logo-light.png", LIGHT), ("logo-dark.png", DARK)):
        path = OUT / name
        draw_logo(palette).save(path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
