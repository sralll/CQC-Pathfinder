import sys
from io import BytesIO

import resvg_py
from PIL import Image

# Match OCAD's native export: 8-bit palette PNG (256 colours). MEDIANCUT
# minimises *total* error and drops small unique regions (e.g. #ce95f7
# restaurant-seating fills) into nearby clusters. LIBIMAGEQUANT preserves
# those small regions; fall back to MEDIANCUT if Pillow wasn't built with it.
PALETTE_COLORS = 256


def main():
    if len(sys.argv) != 5:
        raise SystemExit("Usage: render_svg_resvg.py input.svg output.png width height")

    input_svg, output_png, width_raw, height_raw = sys.argv[1:]
    width = int(float(width_raw))
    height = int(float(height_raw))

    with open(input_svg, "r", encoding="utf-8") as f:
        svg = f.read()

    png_data = resvg_py.svg_to_bytes(
        svg_string=svg,
        width=width,
        height=height,
        background="white",
    )

    img = Image.open(BytesIO(bytes(png_data))).convert("RGB")
    try:
        img = img.quantize(
            colors=PALETTE_COLORS,
            method=Image.Quantize.LIBIMAGEQUANT,
            dither=Image.Dither.NONE,
        )
    except (ValueError, OSError):
        img = img.quantize(
            colors=PALETTE_COLORS,
            method=Image.Quantize.MEDIANCUT,
            dither=Image.Dither.NONE,
        )
    img.save(output_png, format="PNG", optimize=True, compress_level=9)


if __name__ == "__main__":
    main()
