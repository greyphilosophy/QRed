"""Visual comparison of binary dots and the experimental three-tone carrier."""
import json
import sys
from pathlib import Path
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

directory, output = Path(sys.argv[1]), Path(sys.argv[2])
results = json.loads((directory / "results.json").read_text())
assert results["complete"] and len(results["results"]) == 30
assert all(x["signatureValid"] for x in results["results"] if x["condition"] == "clean" or x["encoding"] == "binary")
fonts = Path("/usr/share/fonts/truetype/dejavu")
pdfmetrics.registerFont(TTFont("Sans", str(fonts / "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("Bold", str(fonts / "DejaVuSans-Bold.ttf")))
output.parent.mkdir(parents=True, exist_ok=True)
pdf = canvas.Canvas(str(output), pagesize=(612, 792), pageCompression=1)
pdf.setTitle("QRed three-tone dot comparison")
ink, muted, purple = HexColor("#182438"), HexColor("#526178"), HexColor("#6d42aa")


def text(x, y, value, size=10, bold=False, color=ink):
    pdf.setFillColor(color)
    pdf.setFont("Bold" if bold else "Sans", size)
    pdf.drawString(x, y, value)


def footer(number):
    pdf.setStrokeColor(HexColor("#dce1e8"))
    pdf.line(40, 43, 572, 43)
    text(40, 28, "QRed / synthetic fixtures / three-tone experiment", 8, color=muted)
    text(530, 28, f"{number} / 3", 8, color=muted)


text(40, 751, "Three tones, gentler dots", 23, True)
text(40, 725, "Experimental reader required - not supported by qred.org yet", 10, color=purple)
text(40, 697, "Black OR white = 0, choosing whichever matches the original pixel.", 10)
text(40, 680, "50% gray = 1. Three physical tones still carry one bit per dot.", 10)
text(40, 651, "Same payload, same 0.34 mm dots, same image scale", 11, True)

columns = [(40, "Original", "original"), (224, "Previous binary dots", "33-binary"), (408, "Adaptive three-tone dots", "33-adaptive-gray")]
for x, label, variant in columns:
    text(x, 626, label, 9, True)
    source = Image.open(directory / f"image-{variant}.png")
    if variant != "original":
        source = source.crop((48, 48, source.width - 48, source.height - 48))
    pdf.drawImage(ImageReader(source), x, 447, width=164, height=164)

text(40, 424, "Identical text detail, enlarged", 11, True)
for x, label, variant in columns:
    source = Image.open(directory / f"text-{variant}.png")
    if variant != "original":
        source = source.crop((48, 48, source.width - 48, source.height - 48))
    source = source.crop((90, 185, 570, 513))
    pdf.drawImage(ImageReader(source), x, 300, width=164, height=164 * 328 / 480)

text(40, 278, "What the first tests show", 12, True)
lines = [
    "All four clean source PNGs recover the full 2,945-byte seal and valid signature.",
    "The larger-dot image also passes the tested blur, low-resolution and angle cases.",
    "Text carriers fail all degraded cases. Every three-tone ink-spread case fails.",
    "All 10 conventional black/white QR controls pass their matching conditions.",
    "",
    "Raw OCR character error falls from 51.7% to 20.9% with the smaller dots.",
    "The original is 0.26%. This measures OCR errors, not human readability.",
    "",
    "30 scan cases / one payload / two synthetic covers / no physical print tests.",
    "Gray levels need printer/camera calibration. Black/white photocopying can",
    "destroy the distinction. Normal QR readers cannot decode this carrier.",
    "The payload signs synthetic text; the chart is not an authenticated photo.",
    "Full-page PDF raster test: image page decodes; text page fails at 300 dpi.",
]
for i, line in enumerate(lines):
    text(40, 255 - i * 15, line, 9, color=muted)
footer(1)
pdf.showPage()

for page, (kind, size, title, note) in enumerate([
    ("image", "50", "Image / adaptive 0.51 mm dots", "Passed clean, resize, low-resolution and angle simulations; failed ink spread."),
    ("text", "33", "Text / adaptive 0.34 mm dots", "Clean source PNG passed; full-page PDF raster and degradation cases failed."),
], 2):
    text(40, 751, title, 19, True)
    text(40, 725, "Custom experimental reader only - qred.org cannot read this carrier yet", 10, color=purple)
    pdf.drawImage(ImageReader(str(directory / f"{kind}-{size}-adaptive-gray.png")), 39.6, 158, width=532.8, height=532.8)
    text(40, 139, "PRINT AT 100% / ACTUAL SIZE", 10, True, purple)
    text(40, 122, "7.40 inches / 188 mm including the white border. Keep the border intact.", 9)
    text(40, 104, note, 8.5, color=muted)
    text(40, 82, "This sheet is for inspecting appearance and future scanner experiments.", 8.5, color=muted)
    text(40, 66, "Synthetic fixture; published demo key; not a proof of image authenticity.", 8.5, color=muted)
    footer(page)
    pdf.showPage()
pdf.save()
print(output)
