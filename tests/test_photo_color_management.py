"""Browser preparation must honor synthetic wide-gamut JPEG color metadata.

No user photographs, camera metadata or extracted profiles are test fixtures.
The profile below was generated with LittleCMS cmsCreateRGBProfile from D65
(0.3127, 0.3290), Display-P3 primaries R(0.68, 0.32), G(0.265, 0.69),
B(0.15, 0.06), and the sRGB parametric transfer curve. Its date is fixed.
"""
import base64
import io
from pathlib import Path

import pytest
from PIL import Image, ImageCms, ImageDraw, ImageOps


DISPLAY_P3_ICC = base64.b64decode(
    "AAACSGxjbXMEQAAAbW50clJHQiBYWVogB+QAAQABAAAAAAAAYWNzcEFQUEwAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA0Y3BydAAAATwAAABMd3RwdAAA"
    "AYgAAAAUY2hhZAAAAZwAAAAsclhZWgAAAcgAAAAUYlhZWgAAAdwAAAAUZ1hZWgAAAfAAAAAU"
    "clRSQwAAAgQAAAAgZ1RSQwAAAgQAAAAgYlRSQwAAAgQAAAAgY2hybQAAAiQAAAAkbWx1YwAA"
    "AAAAAAABAAAADGVuVVMAAAAYAAAAHABSAEcAQgAgAGIAdQBpAGwAdAAtAGkAbm1sdWMAAAAA"
    "AAAAAQAAAAxlblVTAAAAMAAAABwATgBvACAAYwBvAHAAeQByAGkAZwBoAHQALAAgAHUAcwBl"
    "ACAAZgByAGUAZQBsAHlYWVogAAAAAAAA9tYAAQAAAADTLXNmMzIAAAAAAAEMQgAABd7///Ml"
    "AAAHkwAA/ZD///uh///9ogAAA9wAAMBuWFlaIAAAAAAAAIPfAAA9v////7tYWVogAAAAAAAA"
    "KDgAABELAADIuVhZWiAAAAAAAABKvwAAsTcAAAq5cGFyYQAAAAAAAwAAAAJmZgAA8qcAAA1Z"
    "AAAT0AAACltjaHJtAAAAAAADAAAAAK4UAABR7AAAQ9cAALCkAAAmZgAAD1w="
)


def synthetic_jpeg(tagged, orientation):
    """Solid patches avoid coupling ICC assertions to JPEG edge interpolation."""
    colors = [
        (205, 221, 232), (245, 245, 245), (190, 200, 210), (150, 180, 210),
        (200, 80, 60), (40, 170, 200), (130, 70, 190), (210, 175, 80),
        (40, 40, 40), (128, 128, 128), (80, 170, 90), (230, 190, 210),
    ]
    source = Image.new("RGB", (128, 96))
    drawing = ImageDraw.Draw(source)
    for index, color in enumerate(colors):
        x, y = (index % 4) * 32, (index // 4) * 32
        drawing.rectangle((x, y, x + 31, y + 31), fill=color)
    exif = Image.Exif()
    exif[274] = orientation
    output = io.BytesIO()
    source.save(output, "JPEG", quality=95, subsampling=0, exif=exif,
                **({"icc_profile": DISPLAY_P3_ICC} if tagged else {}))
    jpeg = output.getvalue()
    decoded = ImageOps.exif_transpose(Image.open(io.BytesIO(jpeg))).convert("RGB")
    managed = ImageCms.profileToProfile(
        decoded, ImageCms.ImageCmsProfile(io.BytesIO(DISPLAY_P3_ICC)),
        ImageCms.createProfile("sRGB"), outputMode="RGB",
        renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
    ) if tagged else decoded
    points = [(x, y) for y in range(16, decoded.height, 32)
              for x in range(16, decoded.width, 32)]
    return jpeg, decoded, managed, points


PREPARE_PIXELS = """async ({source, jpeg, points}) => {
    const moduleUrl = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
    try {
        const {readCameraPhotoFile} = await import(moduleUrl);
        const bytes = Uint8Array.from(atob(jpeg), ch => ch.charCodeAt(0));
        const file = new File([bytes], 'synthetic-color-chart.jpg', {type: 'image/jpeg'});
        const output = {};
        const summarize = (image, canvas) => ({
            width: image.width, height: image.height, colorSpace: image.colorSpace,
            contextColorSpace: canvas.getContext('2d').getContextAttributes().colorSpace,
            samples: points.map(([x, y]) => Array.from(image.data.slice(
                (y * image.width + x) * 4, (y * image.width + x) * 4 + 3))),
        });
        const selectedCanvas = document.createElement('canvas');
        const selected = await readCameraPhotoFile(file, selectedCanvas, {requireHighResolution: false});
        output.selected = summarize(selected, selectedCanvas);
        // Native still capture uses createImageBitmap(blob), then the same
        // default canvas drawImage/getImageData path as this probe.
        const bitmap = await createImageBitmap(file);
        try {
            for (const colorSpace of [undefined, 'srgb', 'display-p3']) {
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width; canvas.height = bitmap.height;
                const context = canvas.getContext('2d', {willReadFrequently: true,
                    ...(colorSpace ? {colorSpace} : {})});
                context.drawImage(bitmap, 0, 0);
                output[colorSpace || 'bitmapDefault'] = summarize(
                    context.getImageData(0, 0, bitmap.width, bitmap.height), canvas);
            }
        } finally { bitmap.close(); }
        return output;
    } finally { URL.revokeObjectURL(moduleUrl); }
}"""


def max_error(actual, expected):
    return max(abs(a - e) for actual_pixel, expected_pixel in zip(actual, expected)
               for a, e in zip(actual_pixel, expected_pixel))


@pytest.mark.parametrize("orientation", [1, 6])
@pytest.mark.parametrize("tagged", [False, True], ids=["untagged-srgb", "tagged-display-p3"])
def test_selected_jpeg_matches_color_managed_browser_pixels(browser, tagged, orientation):
    jpeg, raw, managed, points = synthetic_jpeg(tagged, orientation)
    source = (Path(__file__).parents[1] / "frontend/src/qr/cameraPhoto.js").read_text()
    context = browser.new_context(service_workers="block")
    requests = []
    context.on("request", lambda request: requests.append(request.url))
    # No page navigation or service is needed, and the synthetic fixture stays
    # inside the test browser. Fail any accidental HTTP request.
    context.route("http://**/*", lambda route: route.abort())
    context.route("https://**/*", lambda route: route.abort())
    try:
        page = context.new_page()
        actual = page.evaluate(PREPARE_PIXELS, {
            "source": source, "jpeg": base64.b64encode(jpeg).decode(), "points": points,
        })
        expected = [managed.getpixel(point) for point in points]
        unconverted = [raw.getpixel(point) for point in points]
        for pipeline in ["selected", "bitmapDefault", "srgb"]:
            result = actual[pipeline]
            assert (result["width"], result["height"]) == managed.size
            assert result["colorSpace"] == result["contextColorSpace"] == "srgb"
            # Browser JPEG IDCT and skcms vs LittleCMS can round differently.
            assert max_error(result["samples"], expected) <= 2, (pipeline, result, expected)
        if tagged:
            assert max_error(actual["selected"]["samples"], unconverted) >= 10
            assert actual["display-p3"]["colorSpace"] == "display-p3"
            assert max_error(actual["display-p3"]["samples"], unconverted) <= 2
        assert not [url for url in requests if url.startswith(("http:", "https:"))]
    finally:
        context.close()
