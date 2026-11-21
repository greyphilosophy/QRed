#!/usr/bin/env python3
"""Create synthetic, unsealed PDF inputs for QRed black-bar regression work.

Requires reportlab and PyMuPDF. No source letter or real personal data is used.
Usage: python generate.py --output /tmp/qred-black-banner
Optional: --bar-center-pt 353 --bar-height-pt 22
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

import fitz
from reportlab.lib.colors import black, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

PAGE_W, PAGE_H = 612, 792
LEFT, WIDTH = 42, 528
CAPTION = "Orientation Complete"
BODY_STYLE = ParagraphStyle("body", fontName="FixtureSans", fontSize=10.5, leading=13.8)
SMALL_STYLE = ParagraphStyle("small", fontName="FixtureSans", fontSize=9.5, leading=12.5)


def register_fonts():
    roots = [Path(__file__).parent / "fonts", Path('/usr/share/fonts/truetype/liberation'),
             Path('/usr/share/fonts/truetype/liberation2')]
    for root in roots:
        if (root / 'LiberationSans-Regular.ttf').exists():
            for name, suffix in [('FixtureSans', 'Regular'), ('FixtureSansBold', 'Bold'),
                                 ('FixtureSansItalic', 'Italic')]:
                pdfmetrics.registerFont(TTFont(name, str(root / f'LiberationSans-{suffix}.ttf')))
            return
    # Standard PDF fonts preserve the layout on systems without Liberation Sans.
    for name, source in [('FixtureSans', 'Helvetica'), ('FixtureSansBold', 'Helvetica-Bold'),
                         ('FixtureSansItalic', 'Helvetica-Oblique')]:
        pdfmetrics.registerFont(pdfmetrics.Font(name, source, 'WinAnsiEncoding'))


def text(c, x, baseline_from_top, value, font='FixtureSans', size=10.5, center=False):
    c.setFont(font, size)
    if center:
        c.drawCentredString(x, PAGE_H - baseline_from_top, value)
    else:
        c.drawString(x, PAGE_H - baseline_from_top, value)


def paragraph(c, value, top, x=LEFT+9, width=WIDTH-18, style=BODY_STYLE):
    p = Paragraph(value, style)
    _, height = p.wrap(width, 400)
    p.drawOn(c, x, PAGE_H - top - height)
    return top + height


def make_pdf(path, *, dark_bar=True, bar_height=22, bar_center=353):
    c = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H), invariant=1, pageCompression=1)
    c.setTitle('Synthetic equipment orientation notice - QRed test input')
    c.setAuthor('Synthetic fixture generator')
    c.setSubject('Fictional test document; no real applicant, agency or record')
    c.setFillColor(white)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(black)
    text(c, LEFT, 44, 'FICTIONAL TEST DOCUMENT - NOT A REAL RECORD', size=8)
    text(c, LEFT, 76, 'CEDAR LANTERN', 'FixtureSansBold', 17)
    text(c, LEFT, 94, 'Community Workshop', size=11)
    text(c, 436, 75, 'Equipment Orientation', 'FixtureSansBold', 15, center=True)
    text(c, 436, 94, 'Completion Notice', 'FixtureSansBold', 15, center=True)
    c.setLineWidth(.75)
    c.line(LEFT, PAGE_H-111, LEFT+WIDTH, PAGE_H-111)

    rows = [
        ('Completed on:', 'Friday, October 16, 2026'),
        ('Participant:', 'MORGAN SAMPLE'),
        ('Member ID:', 'SYN-482691'),
        ('Batch reference:', 'DEMO-2037-46'),
        ('Requesting group:', 'Example Tool Library'),
        ('Workshop:', 'Woodworking and repair'),
        ('Review type:', 'Introductory equipment orientation'),
        ('Session:', 'WS-1042'),
    ]
    for i, (label, value) in enumerate(rows):
        text(c, LEFT, 140+i*20, label, 'FixtureSansItalic')
        text(c, 212, 140+i*20, value, 'FixtureSansBold')

    text(c, PAGE_W/2, 321, 'Workshop access review', 'FixtureSansItalic', 11, center=True)
    c.setFillColor(black if dark_bar else white)
    c.rect(LEFT, PAGE_H-bar_center-bar_height/2, WIDTH, bar_height, fill=1, stroke=0)
    c.setFillColor(white if dark_bar else black)
    font, size = 'FixtureSansBold', 12
    asc, desc = pdfmetrics.getAscentDescent(font, size)
    # Center the actual font metrics inside the band, as well as centering horizontally.
    baseline_top = bar_center + (asc+desc)/2
    text(c, PAGE_W/2, baseline_top, CAPTION, font, size, center=True)
    c.setFillColor(black)
    c.setLineWidth(.65)
    c.rect(LEFT, PAGE_H-610, WIDTH, 307, fill=0, stroke=1)

    text(c, LEFT+9, 399, 'As of the session date, the participant has:')
    text(c, PAGE_W/2, 425, 'Completed the introductory equipment orientation.',
         'FixtureSansBold', 11, center=True)
    top = paragraph(c,
        "The workshop log records completion of the fictional orientation session shown above. "
        "This notice applies to the listed session only; equipment access still depends on "
        "the workshop's current rules and supervision requirements.", 448)
    top = paragraph(c,
        'Keep this notice with the sample training record. Questions about the session '
        'should be directed to the example program coordinator.', top+12)
    paragraph(c,
        'Reference check: the batch identifier is DEMO-2037-46. This deliberate digit '
        'sequence supports a later 7-to-2 text-change test.', top+12)

    text(c, LEFT, 636, 'About this fixture', 'FixtureSansBold', 10)
    paragraph(c,
        'CEDAR LANTERN is an invented workshop. All names, identifiers and events on this '
        'page are synthetic. This page is an input for document-stamping and camera-verification tests.',
        646, x=LEFT, width=WIDTH, style=SMALL_STYLE)
    paragraph(c,
        'Test note: compare the visible status text as well as the seal. A recovered seal alone '
        'does not demonstrate that the photographed text is unchanged.',
        693, x=LEFT, width=WIDTH, style=SMALL_STYLE)
    c.setLineWidth(.5)
    c.line(LEFT, PAGE_H-736, LEFT+WIDTH, PAGE_H-736)
    text(c, LEFT, 752, 'FICTIONAL TEST DOCUMENT | Sample equipment orientation', size=8)
    text(c, 516, 752, 'Page 1 of 1', size=8)
    c.showPage()
    c.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('.'))
    parser.add_argument('--bar-center-pt', type=float, default=353)
    parser.add_argument('--bar-height-pt', type=float, default=22)
    args = parser.parse_args()
    if not 4 <= args.bar_height_pt <= 80:
        parser.error('Use a bar height between 4 and 80 points.')
    if not 40 <= args.bar_center_pt <= 752:
        parser.error('Keep the bar center within the printable page.')
    args.output.mkdir(parents=True, exist_ok=True)
    register_fonts()
    cases = [
        ('QRed_Black_Bar_Test', True, args.bar_height_pt),
        ('QRed_White_Background_Control', False, args.bar_height_pt),
        ('QRed_Tall_Black_Bar_Test', True, 48),
    ]
    manifest = {'fixture': 'Synthetic workshop completion notice', 'sealed': False,
        'page_size_pt': [PAGE_W, PAGE_H], 'dpi': 300,
        'coordinates': 'Points from top-left; 72 points = 1 inch',
        'bar_text': CAPTION, 'bar_width_pt': WIDTH,
        'bar_center_y_pt': args.bar_center_pt,
        'status': 'Source inputs only. QRed end-to-end failure has not been measured.',
        'expected_behavior_after_fix': 'Recover every signed chunk and signature, or explicitly use a readable fallback; retain comparison of the white status text.',
        'cases': []}
    for name, dark, height in cases:
        path = args.output / f'{name}.pdf'
        make_pdf(path, dark_bar=dark, bar_height=height, bar_center=args.bar_center_pt)
        with fitz.open(path) as doc:
            plain = doc[0].get_text()
            doc[0].get_pixmap(dpi=300, alpha=False).save(args.output/f'{name}_300dpi.png')
        (args.output/f'{name}_expected.txt').write_text(plain)
        manifest['cases'].append({'pdf': path.name, 'png': f'{name}_300dpi.png',
            'bar_rect_pt': [LEFT, args.bar_center_pt-height/2, WIDTH, height],
            'bar_rgb': [0,0,0] if dark else [255,255,255],
            'caption_rgb': [255,255,255] if dark else [0,0,0],
            'pdf_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'text_sha256': hashlib.sha256(plain.encode()).hexdigest()})
    hashes = {case['text_sha256'] for case in manifest['cases']}
    if len(hashes) != 1:
        raise AssertionError('Variant text must be identical.')
    (args.output/'fixture_manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print(json.dumps({'created': [c['pdf'] for c in manifest['cases']],
                      'identical_extracted_text': True, 'page_size': 'US Letter',
                      'caption': CAPTION}, indent=2))


if __name__ == '__main__':
    main()
