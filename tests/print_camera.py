"""Deterministic print -> scene -> camera simulator; no QR/decoder knowledge.

Input is a raster of the COMPLETE sealed PDF, including its ordinary text.
This is an approximate monochrome printer/camera model, not device calibration.
All spatial sampling and blur before sensor readout operate on linear light.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, field, replace
import hashlib
import io
import json
from pathlib import Path
import platform
import re
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageFilter, __version__ as pillow_version


@dataclass(frozen=True)
class Printer:
    dpi: int = 300
    screening: str = "dispersed"
    cell: int = 4  # clustered screen period in printer spots, NOT its DPI
    dot_gain: float = 0.015  # partial expansion into adjacent printer spots
    dropout: float = 0.0002
    scale: float = 0.98
    shift: tuple[float, float] = (0.0, 0.0)  # fractions of paper width/height
    tone: float = 1.0  # power on ink coverage; 1 is the tone-preserving reference
    black: float = 0.015  # solid ink reflectance


@dataclass(frozen=True)
class Scene:
    # Clockwise paper corners in normalized camera coordinates, independent
    # of all production page/QR geometry helpers.
    corners: tuple = ((0.075, 0.055), (0.92, 0.075), (0.94, 0.945), (0.06, 0.93))
    background: str = "dark"
    illumination: float = 0.94
    gradient: float = 0.05
    shadow: float = 0.06
    glare: float = 0.0
    tint: tuple[float, float, float] = (1.0, 0.98, 0.95)


@dataclass(frozen=True)
class Camera:
    width: int = 1500
    height: int = 2000
    samples: int = 2
    blur: float = 0.28  # optical sigma in final sensor pixels
    motion: float = 0.0  # horizontal exposure travel in final sensor pixels
    read_noise: float = 0.35  # standard deviation, linear 8-bit units
    shot_noise: float = 0.015  # variance per unit signal
    sharpen: float = 0.0
    jpeg_quality: int = 94
    codec: str = "JPEG"  # live preview fixtures can use lossless PNG
    orientation: int = 1  # encoded JPEG EXIF; width/height describe the viewed image


@dataclass(frozen=True)
class Profile:
    printer: Printer = field(default_factory=Printer)
    scene: Scene = field(default_factory=Scene)
    camera: Camera = field(default_factory=Camera)
    seed: int = 168


PRESETS = {
    "reference": Profile(),
    "clustered": Profile(printer=Printer(dpi=600, screening="clustered", cell=4)),
    "preview": Profile(camera=Camera(width=1080, height=1440, codec="PNG")),
    "still": Profile(camera=Camera(width=3000, height=4000, samples=1)),
    "pattern-shadow": Profile(
        scene=Scene(
            background="pattern",
            gradient=0.16,
            shadow=0.18,
            corners=((0.06, 0.08), (0.92, 0.04), (0.89, 0.94), (0.09, 0.91)),
        )
    ),
    "pale-desk": Profile(scene=Scene(background="pale", shadow=0.08)),
    "low-dpi": Profile(printer=Printer(dpi=150, screening="diffusion", dot_gain=0.03)),
    "blur-compression": Profile(
        camera=Camera(blur=0.7, motion=0.8, read_noise=0.8, jpeg_quality=75)
    ),
    # Scene envelope measured from two private original JPEGs: 3000x4000
    # viewed pixels, EXIF 6, ~90% sheet coverage, paper around 192/255.
    # Printer screening and lens parameters remain approximate, not measured.
    "observed-scene": Profile(
        scene=Scene(
            background="pattern",
            illumination=0.56,
            gradient=0.08,
            shadow=0.1,
            tint=(1, 0.99, 0.98),
            corners=((0.035, 0.06), (0.955, 0.07), (0.97, 0.965), (0.035, 0.96)),
        ),
        camera=Camera(width=3000, height=4000, samples=1, orientation=6),
    ),
}


def profile_from_dict(value):
    """Reject misspelled knobs instead of silently running a different test."""
    printer = dict(value.get("printer", {}))
    scene = dict(value.get("scene", {}))
    if "shift" in printer:
        printer["shift"] = tuple(printer["shift"])
    if "corners" in scene:
        scene["corners"] = tuple(tuple(point) for point in scene["corners"])
    if "tint" in scene:
        scene["tint"] = tuple(scene["tint"])
    return Profile(
        **{
            **value,
            "printer": Printer(**printer),
            "scene": Scene(**scene),
            "camera": Camera(**value.get("camera", {})),
        }
    )


def validate(profile):
    p, s, c = profile.printer, profile.scene, profile.camera
    if p.dpi not in (150, 300, 600) or p.screening not in (
        "dispersed",
        "clustered",
        "diffusion",
    ):
        raise ValueError(
            "Use 150/300/600 DPI and dispersed, clustered, or diffusion screening"
        )
    if not 2 <= p.cell <= 16 or not 0.8 <= p.scale <= 1.05 or not 0.25 <= p.tone <= 4:
        raise ValueError("Invalid printer geometry/tone")
    if not 0 <= p.black < 0.2 or not 0 <= p.dot_gain <= 1 or not 0 <= p.dropout <= 1:
        raise ValueError("Invalid ink parameters")
    if len(p.shift) != 2 or any(abs(v) > 0.1 for v in p.shift):
        raise ValueError("Invalid printer shift")
    if not (
        64 <= c.width <= 6000
        and 64 <= c.height <= 6000
        and c.width * c.height <= 12_000_000
    ):
        raise ValueError("Camera raster must be between 64 pixels and 12 megapixels")
    if c.samples not in (1, 2, 3) or c.width * c.height * c.samples**2 > 27_000_000:
        raise ValueError("Optical working image exceeds the 27 megapixel budget")
    if c.codec not in ("JPEG", "PNG") or not 20 <= c.jpeg_quality <= 100:
        raise ValueError("Invalid image encoding")
    if c.orientation not in (1, 3, 6, 8) or (c.codec != "JPEG" and c.orientation != 1):
        raise ValueError("Orientation must be a supported JPEG EXIF rotation")
    if not all(
        0 <= v <= 8 for v in (c.blur, c.motion, c.read_noise, c.shot_noise, c.sharpen)
    ):
        raise ValueError("Invalid camera degradation")
    points = np.asarray(s.corners, dtype=float)
    if (
        points.shape != (4, 2)
        or not np.isfinite(points).all()
        or np.any(points < 0)
        or np.any(points > 1)
    ):
        raise ValueError("Supply four visible paper corners in normalized coordinates")
    edges = np.roll(points, -1, axis=0) - points
    turns = (
        edges[:, 0] * np.roll(edges, -1, axis=0)[:, 1]
        - edges[:, 1] * np.roll(edges, -1, axis=0)[:, 0]
    )
    if not np.all(turns > 0.001):
        raise ValueError("Paper corners must form a clockwise convex quadrilateral")
    if (
        s.background not in ("dark", "pale", "pattern")
        or not 0.1 <= s.illumination <= 1.5
    ):
        raise ValueError("Invalid scene")
    if (
        not all(0 <= v <= 1 for v in (s.gradient, s.shadow, s.glare))
        or len(s.tint) != 3
        or not all(0.5 <= v <= 1.5 for v in s.tint)
    ):
        raise ValueError("Invalid lighting")


def linearize(values):
    values = np.asarray(values, dtype=np.float32) / 255
    return np.where(
        values <= 0.04045, values / 12.92, ((values + 0.055) / 1.055) ** 2.4
    )


def encode_srgb(values):
    values = np.clip(values, 0, 1)
    return np.uint8(
        np.clip(
            np.where(
                values <= 0.0031308, values * 12.92, 1.055 * values ** (1 / 2.4) - 0.055
            )
            * 255
            + 0.5,
            0,
            255,
        )
    )


def rasterize(pdf, page, dpi):
    """An independent PDF renderer supplies printer samples, never QR matrices."""
    if dpi not in (150, 300, 600) or page < 1:
        raise ValueError("Invalid page or DPI")
    info = subprocess.run(
        ["pdfinfo", "-f", str(page), "-l", str(page), str(Path(pdf).resolve())],
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
    ).stdout
    size = re.search(r"Page(?:\s+\d+)?\s+size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts", info)
    if not size:
        raise ValueError("Could not determine PDF page dimensions before rendering")
    width, height = (int(np.ceil(float(points) * dpi / 72)) for points in size.groups())
    if width * height > 40_000_000:
        raise ValueError("Printer raster exceeds 40 megapixels")
    with tempfile.TemporaryDirectory(prefix="qred-raster-") as temp:
        target = Path(temp) / "page"
        subprocess.run(
            [
                "pdftoppm",
                "-f",
                str(page),
                "-l",
                str(page),
                "-r",
                str(dpi),
                "-singlefile",
                "-png",
                str(Path(pdf).resolve()),
                str(target),
            ],
            check=True,
            capture_output=True,
            timeout=60,
        )
        with Image.open(target.with_suffix(".png")) as image:
            if image.width * image.height > 40_000_000:
                raise ValueError("Printer raster exceeds 40 megapixels")
            return image.convert("RGB")


def print_raster(raster, profile):
    """Generate actual ink/no-ink spots, then approximate dot gain/dropout."""
    validate(profile)
    p = profile.printer
    if raster.width * raster.height > 40_000_000:
        raise ValueError("Printer raster exceeds 40 megapixels")
    rng = np.random.default_rng(profile.seed)
    w, h = raster.size
    # Fit-to-page changes the source BEFORE printer halftoning. It does not
    # resize the printed dot pattern or move the physical paper boundary.
    offset = [
        (1 - p.scale) * size / 2 + shift * size for size, shift in zip((w, h), p.shift)
    ]
    source = raster.convert("L").transform(
        (w, h),
        Image.Transform.AFFINE,
        (1 / p.scale, 0, -offset[0] / p.scale, 0, 1 / p.scale, -offset[1] / p.scale),
        resample=Image.Resampling.BICUBIC,
        fillcolor=255,
    )
    coverage = (
        np.clip((1 - linearize(np.asarray(source))) / (1 - p.black), 0, 1) ** p.tone
    )
    if p.screening == "diffusion":
        tone = Image.fromarray(np.uint8((1 - coverage) * 255))
        ink = 1 - np.asarray(
            tone.convert("1", dither=Image.Dither.FLOYDSTEINBERG), dtype=np.float32
        )
    else:
        if p.screening == "dispersed":
            tile = np.array([[0, 2], [3, 1]])
            for _ in range(2):
                tile = np.block(
                    [[4 * tile, 4 * tile + 2], [4 * tile + 3, 4 * tile + 1]]
                )
        else:
            y, x = np.indices((p.cell, p.cell))
            distance = (x - (p.cell - 1) / 2) ** 2 + (y - (p.cell - 1) / 2) ** 2
            tile = np.argsort(
                np.argsort(distance.ravel(), kind="stable"), kind="stable"
            ).reshape(distance.shape)
        phase = rng.integers(0, tile.shape[0], size=2)
        threshold = (
            tile[
                (np.arange(h)[:, None] + phase[0]) % len(tile),
                (np.arange(w)[None, :] + phase[1]) % len(tile),
            ]
            + 0.5
        ) / tile.size
        ink = (coverage > threshold).astype(np.float32)
    if p.dropout:
        ink *= rng.random(ink.shape, dtype=np.float32) >= p.dropout
    if p.dot_gain:
        expanded = (
            np.asarray(
                Image.fromarray(np.uint8(ink * 255)).filter(ImageFilter.MaxFilter(3)),
                dtype=np.float32,
            )
            / 255
        )
        ink += (expanded - ink) * p.dot_gain
    return Image.fromarray(np.uint8((1 - ink * (1 - p.black)) * 255 + 0.5))


def perspective_coefficients(corners, size, source_size):
    """Solve inverse homography independently of QRed's geometry code."""
    destination = np.asarray(corners) * np.asarray(size)
    source = np.array([[0, 0], [source_size[0], 0], source_size, [0, source_size[1]]])
    rows, values = [], []
    for (x, y), (u, v) in zip(destination, source):
        rows.extend(
            [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        )
        values.extend([u, v])
    return tuple(np.linalg.solve(rows, values))


def photograph(printed, profile):
    validate(profile)
    s, c = profile.scene, profile.camera
    w, h = c.width * c.samples, c.height * c.samples
    coefficients = perspective_coefficients(s.corners, (w, h), printed.size)
    # Large optical rasters stay uint8; lighting is processed in row tiles.
    paper = np.asarray(
        printed.transform(
            (w, h),
            Image.Transform.PERSPECTIVE,
            coefficients,
            Image.Resampling.BICUBIC,
            fillcolor=255,
        ),
        dtype=np.uint8,
    )
    mask = np.asarray(
        Image.new("L", printed.size, 255).transform(
            (w, h), Image.Transform.PERSPECTIVE, coefficients, Image.Resampling.BILINEAR
        ),
        dtype=np.uint8,
    )
    optical = np.empty((h, w, 3), dtype=np.uint8)
    for start in range(0, h, 128):
        end = min(h, start + 128)
        y, x = np.mgrid[start:end, :w].astype(np.float32)
        u, v = x / w, y / h
        if s.background == "pattern":
            motif = (np.sin(u * 83 + np.sin(v * 49) * 3) + np.cos(v * 97)) > 0.1
            background = np.where(motif[:, :, None], [168, 115, 163], [65, 40, 70])
        else:
            background = np.full(
                (end - start, w, 3), 218 if s.background == "pale" else 52
            )
        light = s.illumination * (
            1
            - s.gradient * v
            - s.shadow * np.exp(-(((u - 0.13) / 0.32) ** 2) - ((v - 0.65) / 0.6) ** 2)
        )
        glare = s.glare * np.exp(-(((u - 0.7) / 0.2) ** 2) - ((v - 0.3) / 0.3) ** 2)
        foreground = paper[start:end, :, None].astype(np.float32) / 255
        alpha = mask[start:end, :, None].astype(np.float32) / 255
        scene = foreground * alpha + linearize(background) * (1 - alpha)
        scene = (scene * light[:, :, None] + glare[:, :, None]) * np.array(
            s.tint, dtype=np.float32
        )
        optical[start:end] = np.uint8(np.clip(scene * 255 + 0.5, 0, 255))
    optics = Image.fromarray(optical)
    if c.blur:
        optics = optics.filter(ImageFilter.GaussianBlur(c.blur * c.samples))
    if c.motion:
        exposures = max(3, int(np.ceil(c.motion * c.samples * 2)) + 1)
        accumulated = np.zeros_like(optical, dtype=np.float32)
        for shift in np.linspace(
            -c.motion * c.samples / 2, c.motion * c.samples / 2, exposures
        ):
            accumulated += (
                np.asarray(
                    optics.transform(
                        (w, h),
                        Image.Transform.AFFINE,
                        (1, 0, float(shift), 0, 1, 0),
                        Image.Resampling.BILINEAR,
                    ),
                    dtype=np.float32,
                )
                / exposures
            )
        optics = Image.fromarray(np.uint8(accumulated + 0.5))
    # Integrate pixel area AFTER projection and optical blur, before noise/ISP.
    sensor = np.asarray(
        optics.resize((c.width, c.height), Image.Resampling.BOX), dtype=np.float32
    )
    rng = np.random.default_rng(profile.seed ^ 0xCA4E2A)
    sensor += rng.standard_normal(sensor.shape, dtype=np.float32) * np.sqrt(
        c.read_noise**2 + sensor * c.shot_noise
    )
    result = Image.fromarray(encode_srgb(sensor / 255))
    if c.sharpen:
        result = result.filter(
            ImageFilter.UnsharpMask(
                radius=1, percent=round(c.sharpen * 100), threshold=2
            )
        )
    output = io.BytesIO()
    options = {}
    if c.codec == "JPEG":
        options = {"quality": c.jpeg_quality, "subsampling": 2}
        if c.orientation != 1:
            # Store the inverse rotation; native browser JPEG loading must
            # honor EXIF to recover the intended camera scene.
            rotation = {
                3: Image.Transpose.ROTATE_180,
                6: Image.Transpose.ROTATE_90,
                8: Image.Transpose.ROTATE_270,
            }
            result = result.transpose(rotation[c.orientation])
            exif = Image.Exif()
            exif[274] = c.orientation
            options["exif"] = exif
    result.save(output, format=c.codec, **options)
    return output.getvalue()


def simulate(raster, profile):
    return photograph(print_raster(raster, profile), profile)


def save_case(pdf, page, profile, directory, name, raster=None, save_print=False):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    raster = raster if raster is not None else rasterize(pdf, page, profile.printer.dpi)
    printed = print_raster(raster, profile)
    payload = photograph(printed, profile)
    if save_print:
        printed.save(directory / (name + "-printer.png"))
    photo = directory / (name + (".jpg" if profile.camera.codec == "JPEG" else ".png"))
    photo.write_bytes(payload)
    manifest = {
        "simulator_version": 1,
        "input": Path(pdf).name,
        "input_sha256": hashlib.sha256(Path(pdf).read_bytes()).hexdigest(),
        "page": page,
        "profile": asdict(profile),
        "printer_pixels": list(raster.size),
        "photo": photo.name,
        "photo_sha256": hashlib.sha256(payload).hexdigest(),
        "runtime": {
            "python": platform.python_version(),
            "pillow": pillow_version,
            "numpy": np.__version__,
            "poppler": subprocess.run(
                ["pdftoppm", "-v"], capture_output=True, text=True, check=True
            ).stderr.splitlines()[0],
        },
        "simulator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "calibration": "Approximate model; not calibrated to a particular printer or phone.",
    }
    (directory / (name + ".json")).write_text(json.dumps(manifest, indent=2) + "\n")
    return photo, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument(
        "--page", type=int, help="PDF page (default: saved case's page, otherwise 1)"
    )
    parser.add_argument(
        "--profile", default="reference", help="Preset name or saved case/profile JSON"
    )
    parser.add_argument("--seed", type=int)
    parser.add_argument("--out", type=Path, default=Path("simulation-results"))
    parser.add_argument(
        "--sweep",
        action="store_true",
        help="Generate every preset; no decoder pass is implied",
    )
    parser.add_argument(
        "--save-print",
        action="store_true",
        help="Also save the printer spot raster (linear reflectance)",
    )
    args = parser.parse_args()
    page = args.page or 1
    if args.sweep:
        profiles = PRESETS.items()
    elif args.profile in PRESETS:
        profiles = [(args.profile, PRESETS[args.profile])]
    else:
        data = json.loads(Path(args.profile).read_text())
        if (
            "input_sha256" in data
            and hashlib.sha256(args.pdf.read_bytes()).hexdigest()
            != data["input_sha256"]
        ):
            parser.error(
                "Input PDF differs from the saved case; use the original PDF to replay it"
            )
        if args.page is None:
            page = data.get("page", 1)
        profiles = [("replay", profile_from_dict(data.get("profile", data)))]
    for name, profile in profiles:
        if args.seed is not None:
            profile = replace(profile, seed=args.seed)
        photo, manifest = save_case(
            args.pdf, page, profile, args.out, name, save_print=args.save_print
        )
        print(json.dumps({"photo": str(photo), "sha256": manifest["photo_sha256"]}))


if __name__ == "__main__":
    main()
