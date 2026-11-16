"""Render fictional workshop documents and simulated photographs from source."""
import argparse
import json
import math
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageChops, ImageFilter


HERE = Path(__file__).resolve().parent
FRONTEND = HERE.parents[2] / "frontend"
PAGES = {
    "statement-1": ("Workshop_Statement.pdf", 1, ("straight",)),
    "statement-2": ("Workshop_Statement.pdf", 2, ("straight", "oblique")),
    "changed-2": ("Workshop_Statement_Changed.pdf", 2, ("straight",)),
    "lot-register": ("Workshop_Lot_Register.pdf", 1, ("straight", "oblique")),
}


def simulate_photo(raster, profile, destination):
    """Map a printed US Letter sheet onto a 4.9 MP camera frame and light the scene."""
    with Image.open(raster) as image:
        page = image.convert("RGB")
    sw, sh = page.size
    angled = profile == "oblique"
    if angled:
        # Printer fit is applied to the content while the paper keeps its size.
        scaled = page.resize((round(sw * .97), round(sh * .97)), Image.Resampling.LANCZOS)
        page = Image.new("RGB", (sw, sh), "white")
        page.paste(scaled, ((sw - scaled.width) // 2, (sh - scaled.height) // 2))
    w, h = 1920, 2560
    theta = math.radians(2 if angled else 0)
    skew, bow, shadow = (.05, .006, .31) if angled else (0, 0, .07)

    def paper_point(x, y):
        dx = (x / w - .5) * w / (sw / sh * h * .87)
        dy = (y / h - .5) / .87
        a = math.cos(theta) * dx + math.sin(theta) * dy
        b = -math.sin(theta) * dx + math.cos(theta) * dy
        divisor = 1 + skew * (1.4 * a - .7 * b)
        return ((.5 + a / divisor + bow * (1 - 4 * b * b)) * sw,
                (.5 + b / divisor + .6 * bow * (1 - 4 * a * a)) * sh)

    mesh = []
    for y in range(0, h, 64):
        for x in range(0, w, 64):
            x2, y2 = min(w, x + 64), min(h, y + 64)
            corners = ((x, y), (x, y2), (x2, y2), (x2, y))
            quad = tuple(coordinate for corner in corners for coordinate in paper_point(*corner))
            mesh.append(((x, y, x2, y2), quad))
    frame = page.transform((w, h), Image.Transform.MESH, mesh, Image.Resampling.BICUBIC,
                           fillcolor=(70, 78, 79))
    lamp = Image.new("RGB", (64, 64))
    light = []
    for y in range(64):
        for x in range(64):
            level = 254 - shadow * 180 * (.15 + .85 * (1 - x / 63)) * (.35 + .65 * y / 63)
            light.append(tuple(round(level * tint) for tint in (1, .985, .96)))
    lamp.putdata(light)
    frame = ImageChops.multiply(frame, lamp.resize((w, h), Image.Resampling.BILINEAR))
    frame.filter(ImageFilter.GaussianBlur(.15)).save(destination, quality=89, subsampling=0)


def build(output):
    """Create the three PDFs and six photos, checking the new seals against the goldens."""
    output = Path(output).resolve()
    photos = output / "photos"
    photos.mkdir(exist_ok=True, parents=True)
    subprocess.run(["node", "node_modules/vite-node/vite-node.mjs",
                    "scripts/generateWorkshopFixtures.mjs", str(output)], cwd=FRONTEND, check=True)
    expected = json.loads((HERE / "expected.json").read_text())
    if json.loads((output / "expected.json").read_text()) != expected:
        raise ValueError("The regenerated signed seals changed. Inspect the fixture before updating expected.json.")
    with TemporaryDirectory() as scratch:
        for name, (pdf, number, profiles) in PAGES.items():
            prefix = Path(scratch) / name
            subprocess.run(["pdftoppm", "-f", str(number), "-l", str(number), "-r", "240",
                            "-singlefile", "-png", str(output / pdf), str(prefix)], check=True)
            for profile in profiles:
                simulate_photo(prefix.with_suffix(".png"), profile, photos / f"{name}-{profile}.jpg")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    build(parser.parse_args().output)
