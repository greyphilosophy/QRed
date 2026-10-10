"""Regenerate the synthetic PDF that needs PDF.js's predefined CMaps."""
from pathlib import Path
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

pdfmetrics.registerFont(UnicodeCIDFont("HeiseiMin-W3"))
pdf = canvas.Canvas(str(Path(__file__).with_name("cjk-text.pdf")),
                    pagesize=(612, 792), invariant=1)
pdf.setFont("Helvetica", 12)
pdf.drawString(72, 740, "Invoice 123")
pdf.setFont("HeiseiMin-W3", 14)
pdf.drawString(72, 700, "承認金額は一万円です")
pdf.save()
