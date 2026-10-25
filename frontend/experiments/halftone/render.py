"""Deterministic synthetic covers and explicitly limited print/camera simulations.

These are stress fixtures, not calibrated printer models or photographs.
Requires Pillow. All generated input is synthetic; no user document is opened.
"""
import io
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

directory = Path(sys.argv[1])
fixture = json.loads((directory / "fixture.json").read_text())
modules, tile, margin = fixture["modules"], 12, 4
active = modules * tile
size = (modules + 2 * margin) * tile
font_root = Path("/usr/share/fonts/truetype/dejavu")
sans = lambda px: ImageFont.truetype(str(font_root / "DejaVuSans.ttf"), px)
mono = lambda px: ImageFont.truetype(str(font_root / "DejaVuSansMono.ttf"), px)


def cover(kind):
    image = Image.new("L", (active, active), 255)
    draw = ImageDraw.Draw(image)
    if kind == "text":
        lines = fixture["content"].splitlines()
        leading = min(49, (active - 190) / len(lines))
        for index, line in enumerate(lines):
            draw.text((95, 88 + index * leading), line, fill=0, font=mono(38))
    else:
        gradient = Image.linear_gradient("L").rotate(90).resize((active, active // 2))
        image.paste(gradient, (0, 0))
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, active // 2, active, active), fill=18)
        draw.polygon([(0, 1690), (300, 1000), (680, 1540), (1100, 850), (1550, 1500), (1870, 1000), (active, 1650), (active, active), (0, active)], fill=95)
        draw.polygon([(0, 1870), (450, 1490), (800, 1810), (1370, 1310), (active, 1800), (active, active), (0, active)], fill=0)
        for x in range(72, 1000, 36):
            draw.line((x, 120, x + 500, 900), fill=30, width=3)
        for index in range(9):
            x = 1100 + index * 100
            draw.rectangle((x, 150, x + 75, 470), fill=round(index * 255 / 8))
        draw.ellipse((1450, 550, 1930, 1030), fill=255, outline=0, width=10)
        draw.ellipse((1530, 630, 1850, 950), fill=0)
        draw.text((110, 1040), "IMAGE STRESS CHART", fill=255, font=sans(62))
        draw.text((110, 1130), "Shadows, highlights, edges and fine lines", fill=255, font=sans(37))
        draw.text((110, 1220), "0123456789  ABCDEFGHIJKLMNOP", fill=255, font=mono(36))
    image.save(directory / (kind + "-original.png"))
    # The user's proposed 5%-95% luminance range. Full black and white are
    # reserved digitally for the carrier, not assumed to stay unique in print.
    return image.point(lambda level: round(12.75 + 0.9 * level))


def carrier(background, fraction, shape="circle", markers="all"):
    image = Image.new("L", (size, size), 255)
    image.paste(background, (margin * tile, margin * tile))
    draw = ImageDraw.Draw(image)
    controlled = 0
    diameter = round(tile * fraction)
    radius = diameter / 2
    # Pixel-center definition keeps a circular dot centered on its QR module.
    dot = [(x, y) for y in range(tile) for x in range(tile)
           if (abs(x + .5 - tile / 2) <= radius and abs(y + .5 - tile / 2) <= radius
               and (shape == "square" or (x + .5 - tile / 2) ** 2 + (y + .5 - tile / 2) ** 2 <= radius ** 2))]
    for row in range(modules):
        for col in range(modules):
            index = row * modules + col
            value = 0 if fixture["matrix"][index] else 255
            x, y = (col + margin) * tile, (row + margin) * tile
            essential = ((row < 9 and col < 9) or (row < 9 and col >= modules - 8)
                         or (row >= modules - 8 and col < 9) or row == 6 or col == 6
                         or (row < 6 and modules - 11 <= col < modules - 8)
                         or (col < 6 and modules - 11 <= row < modules - 8)
                         or (modules - 9 <= row <= modules - 5 and modules - 9 <= col <= modules - 5))
            if (fixture["reserved"][index] and (markers == "all" or essential)) or fraction == 1:
                draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=value)
                controlled += tile * tile
            else:
                for dx, dy in dot:
                    image.putpixel((x + dx, y + dy), value)
                controlled += len(dot)
    return image, controlled / (active * active)


def jpeg(image, quality=85):
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=quality)
    buffer.seek(0)
    return Image.open(buffer).convert("RGB")


def solve(rows, values):
    """Small Gaussian elimination for a projective transform; no image oracle in scanning."""
    matrix = [list(row) + [value] for row, value in zip(rows, values)]
    for index in range(8):
        pivot = max(range(index, 8), key=lambda row: abs(matrix[row][index]))
        matrix[index], matrix[pivot] = matrix[pivot], matrix[index]
        factor = matrix[index][index]
        matrix[index] = [value / factor for value in matrix[index]]
        for row in range(8):
            if row != index:
                factor = matrix[row][index]
                matrix[row] = [a - factor * b for a, b in zip(matrix[row], matrix[index])]
    return [row[8] for row in matrix]


def perspective(image):
    target = [(65, 30), (1190, 105), (1100, 1190), (120, 1110)]
    source = [(0, 0), (size, 0), (size, size), (0, size)]
    rows, values = [], []
    for (x, y), (u, v) in zip(target, source):
        rows += [[x, y, 1, 0, 0, 0, -u*x, -u*y], [0, 0, 0, x, y, 1, -v*x, -v*y]]
        values += [u, v]
    return jpeg(image.transform((1250, 1250), Image.Transform.PERSPECTIVE,
                solve(rows, values), Image.Resampling.BICUBIC, fillcolor=255).filter(ImageFilter.GaussianBlur(.6)))


def simulate(image, condition):
    if condition == "clean":
        return image.convert("RGB")
    if condition == "perspective":
        return perspective(image)
    if condition == "print-spread":
        # A severe, simplified black-ink spread: one source pixel at 300 dpi.
        # This does not predict any particular real printer's output.
        image = image.convert("1", dither=Image.Dither.FLOYDSTEINBERG).convert("L").filter(ImageFilter.MinFilter(3))
    ppm = 4 if condition == "small-photo" else 6
    width = (modules + 2 * margin) * ppm
    return jpeg(image.resize((width, width), Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(.6)))


manifest = {"sourcePixelsPerModule": tile, "assumedPrintDpi": 300,
            "note": "Synthetic covers; simulations are not calibrated physical-print measurements.", "samples": []}
for kind in ["image", "text"]:
    background = cover(kind)
    for fraction, markers in [(1/3, "all"), (1/2, "all"), (1, "all"), (1/3, "minimal"), (1/2, "minimal")]:
        base, controlled = carrier(background, fraction, markers=markers)
        label = ("full" if fraction == 1 else str(round(fraction * 100))) + ("-minimal" if markers == "minimal" else "")
        base.save(directory / (kind + "-dots-" + label + ".png"))
        for condition in ["clean", "photo", "small-photo", "perspective", "print-spread"]:
            name = kind + "-" + label + "-" + condition
            filename = name + ".png"
            simulate(base, condition).save(directory / filename)
            manifest["samples"].append({"name": name, "file": filename, "cover": kind,
                "dotFraction": fraction, "markerStyle": markers, "controlledArea": round(controlled, 4), "condition": condition})
(directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(json.dumps({"samples": len(manifest["samples"]), "size": size}))
