"""Make a lossless, actual-size print-test PDF after the experiment completes."""
import json
import sys
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

directory, output = Path(sys.argv[1]), Path(sys.argv[2])
results = json.loads((directory / "results.json").read_text())
assert results["complete"] and len(results["results"]) == 50
assert all(row["signatureValid"] for row in results["results"] if row["dotFraction"] == 1)
font_root = Path("/usr/share/fonts/truetype/dejavu")
pdfmetrics.registerFont(TTFont("Sans", str(font_root / "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("Bold", str(font_root / "DejaVuSans-Bold.ttf")))
output.parent.mkdir(parents=True, exist_ok=True)
pdf = canvas.Canvas(str(output), pagesize=(612, 792), pageCompression=1)
pdf.setTitle("QRed dot carrier - experimental print test")
pdf.setAuthor("QRed experiment")
ink, muted, purple = HexColor("#182438"), HexColor("#526178"), HexColor("#6d42aa")


def text(x, y, value, size=10, bold=False, color=ink):
    pdf.setFillColor(color)
    pdf.setFont("Bold" if bold else "Sans", size)
    pdf.drawString(x, y, value)


def footer(number):
    pdf.setStrokeColor(HexColor("#dce1e8"))
    pdf.line(40, 43, 572, 43)
    text(40, 28, "QRed / synthetic fixtures / 25 October 2026", 8, color=muted)
    text(530, 28, f"{number} / 4", 8, color=muted)


text(40, 751, "Dots, holes and a full QR40", 23, True)
text(40, 725, "A controlled experiment - not a validated printing method", 11, color=purple)
lines = [
    "The current QRed scanner can recover a complete 2,945-byte signed seal",
    "from a picture containing small black dots and white holes. Larger dots",
    "survive more simulated degradation, but angled capture remains a problem.",
]
for index, line in enumerate(lines): text(40, 694 - index * 16, line)

for x, image_name, label in [(40, "image-original.png", "Original chart"),
                            (224, "image-dots-33-minimal.png", "0.34 mm dots"),
                            (408, "image-dots-50-minimal.png", "0.51 mm dots")]:
    pdf.drawImage(ImageReader(str(directory / image_name)), x, 468, width=164, height=164)
    text(x, 452, label, 9, True)
text(40, 434, "Overview thumbnails are reduced. Use pages 2-4 for actual-size print tests.", 8, color=muted)

text(40, 404, "Complete payload + valid signature", 12, True)
headers = ["Fixture", "Clean", "Resize", "Low res", "Angle", "Ink spread"]
columns = [40, 268, 326, 384, 442, 500]
for x, header in zip(columns, headers): text(x, 381, header, 8, True)
conditions = ["clean", "photo", "small-photo", "perspective", "print-spread"]
rows = [("Image / small dots", "image", 1/3), ("Image / larger dots", "image", 1/2),
        ("Text / small dots", "text", 1/3), ("Text / larger dots", "text", 1/2),
        ("Conventional QR controls", "image", 1)]
for index, (label, cover, fraction) in enumerate(rows):
    y = 357 - index * 23
    text(40, y, label, 9)
    matching = {row["condition"]: row for row in results["results"]
                if row["cover"] == cover and row["dotFraction"] == fraction
                and row["markerStyle"] == ("all" if fraction == 1 else "minimal")}
    for x, condition in zip(columns[1:], conditions):
        passed = matching[condition]["signatureValid"]
        text(x, y, "PASS" if passed else "FAIL", 8, True,
             HexColor("#24664d") if passed else HexColor("#a2443d"))

notes = [
    "Both covers use 5%-95% gray; QR dots/holes use full black/white. The shown",
    "variants retain clear corner markers, timing/version information and one",
    "bottom-right alignment target. The remaining alignment cells use dots.",
    "",
    "Resize: 1,110 pixels across, blur and JPEG. Low res: 740 pixels across.",
    "Angle: a projective tilt at about 1,100 pixels across, blur and JPEG.",
    "Ink spread: a simplified 300 dpi halftone, one-pixel black expansion,",
    "then resizing/blur/JPEG. This is not a calibrated model of a real printer.",
    "",
    "50 cases / one payload / two synthetic covers. No physical paper tested.",
    "Text is visibly interrupted, and raw OCR worsens markedly. The chart is",
    "not a photo; these results cannot establish preservation of photo details.",
]
for index, line in enumerate(notes): text(40, 224 - index * 12, line, 8.5, color=muted)
footer(1)
pdf.showPage()

plates = [
    ("Image carrier / smaller dots", "image-dots-33-minimal.png", "0.34 mm dots; about 10% of the QR area is controlled by carrier marks.",
     "Passed clean and moderate-resize tests. Failed angle, low-res and ink-spread tests."),
    ("Image carrier / larger dots", "image-dots-50-minimal.png", "0.51 mm dots; about 24% of the QR area is controlled by carrier marks.",
     "Passed clean, resize, low-res and ink-spread tests. Failed the angle test."),
    ("Text carrier / smaller dots", "text-dots-33-minimal.png", "0.34 mm dots over synthetic text. Inspect digits and thin strokes closely.",
     "Passed the clean-image test only. Raw OCR is substantially worse than the original."),
]
for page_number, (title, filename, detail, outcome) in enumerate(plates, 2):
    text(40, 751, title, 19, True)
    text(40, 727, "Experimental | QR40-L | full 2,945-byte payload | QRed demo key", 9, color=muted)
    pdf.drawImage(ImageReader(str(directory / filename)), 39.6, 158, width=532.8, height=532.8)
    text(40, 137, "PRINT AT 100% / ACTUAL SIZE", 10, True, purple)
    text(40, 122, "QR plus white margin: 7.40 inches / 188 mm. Keep the white border intact.", 8.5)
    text(40, 107, detail, 8)
    text(40, 92, outcome, 7.5, color=muted)
    text(40, 74, "Every plate repeats the same signed synthetic test text. This tests the carrier,", 8, color=muted)
    text(40, 62, "not image authenticity. Scan the large code with QRed; ordinary readers see QRED.ORG.", 8, color=muted)
    footer(page_number)
    pdf.showPage()
pdf.save()
print(output)
