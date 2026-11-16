"""Physical invariants for the simulator, independent of successful QR reading."""

from dataclasses import asdict, replace
import io
import json
import numpy as np
from PIL import Image, ImageOps
import pytest

from print_camera import (
    Camera,
    Printer,
    Profile,
    Scene,
    print_raster,
    photograph,
    simulate,
    profile_from_dict,
)


def small(**camera):
    return Profile(
        printer=Printer(scale=1, dot_gain=0, dropout=0),
        scene=Scene(
            corners=((0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)),
            illumination=1,
            gradient=0,
            shadow=0,
            tint=(1, 1, 1),
        ),
        camera=Camera(
            width=192, height=256, read_noise=0, shot_noise=0, codec="PNG", **camera
        ),
    )


@pytest.mark.parametrize("screening", ["dispersed", "clustered", "diffusion"])
def test_printer_conserves_tone_with_real_binary_spots(screening):
    p = small()
    p = replace(p, printer=replace(p.printer, screening=screening))
    source = Image.new("RGB", (400, 520), (220, 220, 220))
    printed = print_raster(source, p)
    assert len(np.unique(np.asarray(printed))) == 2
    photo = Image.open(io.BytesIO(photograph(printed, p)))
    center = np.asarray(photo)[80:180, 60:130]
    assert abs(center.mean() - 220) < 7  # averaging dots must preserve intended tone


def test_same_seed_replays_exactly_and_noise_changes_with_seed():
    p = small()
    p = replace(p, camera=replace(p.camera, read_noise=1))
    source = Image.new("RGB", (400, 520), (225, 225, 225))
    a = simulate(source, p)
    assert a == simulate(source, p)
    assert a != simulate(source, replace(p, seed=p.seed + 1))
    assert p == profile_from_dict(asdict(p))
    assert p == profile_from_dict(json.loads(json.dumps(asdict(p))))


def test_ink_gain_darkens_and_dropout_lightens_the_same_print():
    source = Image.new("RGB", (400, 520), (220, 220, 220))
    p = small()
    clean = np.asarray(print_raster(source, p)).mean()
    darker = np.asarray(
        print_raster(source, replace(p, printer=replace(p.printer, dot_gain=0.2)))
    ).mean()
    lighter = np.asarray(
        print_raster(source, replace(p, printer=replace(p.printer, dropout=0.2)))
    ).mean()
    assert darker < clean - 10 < lighter - 10


def test_printer_fit_leaves_physical_paper_white_and_moves_ink():
    p = small()
    p = replace(p, printer=replace(p.printer, scale=0.8, shift=(0.05, 0)))
    printed = np.asarray(print_raster(Image.new("RGB", (200, 200), "black"), p))
    assert np.all(printed[:, :29] == 255)
    assert np.all(printed[30:170, 40:170] < 10)


def test_camera_resolves_more_detail_at_higher_sampling_resolution():
    # A print with fine bars exercises sampling loss; enlarging a small image
    # cannot restore the modulation observed by a larger sensor raster.
    x = np.arange(768)[None, :]
    bars = np.broadcast_to(np.where((x // 2) % 2, 30, 240), (1024, 768)).astype("uint8")
    p = small(blur=0.35)
    low = np.asarray(Image.open(io.BytesIO(photograph(Image.fromarray(bars), p))))
    highp = replace(p, camera=replace(p.camera, width=768, height=1024))
    high = np.asarray(Image.open(io.BytesIO(photograph(Image.fromarray(bars), highp))))
    assert high[300:700, 200:550].std() > low[80:180, 60:130].std() * 2


def test_resource_limits_and_invalid_geometry_fail_before_allocating():
    p = small()
    source = Image.new("RGB", (100, 100), "white")
    with pytest.raises(ValueError, match="megapixel"):
        simulate(source, replace(p, camera=replace(p.camera, width=6000, height=6000)))
    with pytest.raises(ValueError, match="convex"):
        simulate(
            source,
            replace(
                p, scene=replace(p.scene, corners=((0, 0), (1, 1), (1, 0), (0, 1)))
            ),
        )
    with pytest.raises(TypeError):
        profile_from_dict({"camera": {"jpeg_quailty": 80}})


def test_jpeg_exif_rotates_encoded_pixels_without_changing_viewed_scene():
    p = small()
    p = replace(p, camera=replace(p.camera, codec="JPEG", orientation=6))
    photo = Image.open(io.BytesIO(simulate(Image.new("RGB", (400, 520), "white"), p)))
    assert photo.size == (p.camera.height, p.camera.width)
    assert photo.getexif()[274] == 6
    assert ImageOps.exif_transpose(photo).size == (p.camera.width, p.camera.height)
