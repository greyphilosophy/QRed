"""Summarize synthetic measurements without treating stress misses as passes."""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


def report(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    rows = []
    for path in sorted(directory.glob("**/*-result.json")):
        rows.append((path, json.loads(path.read_text())))
    lines = [
        "# QRed print / camera simulation results",
        "",
        "These are synthetic tests of production decoding and OCR, not physical printer acceptance.",
        "",
        "| Case | Source | Exact signed page recovered | Seal seconds | Total seconds | Content differences | Outcome |",
        "| --- | --- | --- | ---: | ---: | ---: | --- |",
    ]
    for path, row in rows:
        name = str(path.relative_to(directory)).replace("-result.json", "")
        source = "altered" if row.get("content_changed") else "unchanged"
        if row.get("expected_authentication") is False:
            source = "unsealed"
        outcome = (
            row.get("error") or row.get("feedback") or row.get("ocr_status", "not-run")
        )
        cells = [
            name,
            source,
            "Yes" if row["seal_recovered"] else "No",
            row.get("seal_seconds"),
            row.get("total_seconds"),
            row.get("content_difference_groups"),
            outcome,
        ]
        lines.append(
            "| "
            + " | ".join(
                str(v if v is not None else "—").replace("|", "\\|").replace("\n", " ")
                for v in cells
            )
            + " |"
        )
    lines.extend(
        [
            "",
            "Content differences on an **unchanged** document are false alarms. A missing expected seal is an optical failure. "
            "An altered page must require review even though its original seal still authenticates. "
            "Read junit.xml for hard-gate failures; an exploratory sweep completing is not an acceptance pass.",
            "",
        ]
    )
    for path in sorted(directory.glob("camera-*/sequence.json")):
        result = json.loads(path.read_text())
        lines.append(
            f"- {path.parent.name}: {'PASS' if result.get('passed') else 'FAIL'}; {result.get('total_seconds','?')} seconds."
        )
    lines.extend(
        [
            "",
            "Every photo has a JSON record with its seed, complete parameters, source hash, output hash and runtime versions. "
            "The observed-scene preset matches approximate paper exposure/framing and EXIF orientation from two private photos; "
            "it is not a measured model of the printer's screening or the phone's optics. No private photos are included.",
            "",
        ]
    )
    text = "\n".join(lines)
    (directory / "REPORT.md").write_text(text)
    photos = [
        (
            path.parent / row.get("photo_relative", row["photo"]),
            path.parent.name + "/" + row["name"],
            row,
        )
        for path, row in rows
        if (path.parent / row.get("photo_relative", row["photo"])).exists()
    ]
    if photos:
        columns = 3
        cellw, cellh = 340, 490
        sheet = Image.new(
            "RGB",
            (columns * cellw, ((len(photos) + columns - 1) // columns) * cellh),
            "#eeeaf2",
        )
        draw = ImageDraw.Draw(sheet)
        try:
            font = ImageFont.truetype("DejaVuSans.ttf", 15)
        except OSError:
            font = ImageFont.load_default()
        for index, (photo, name, row) in enumerate(photos):
            x = (index % columns) * cellw
            y = (index // columns) * cellh
            with Image.open(photo) as image:
                thumb = ImageOps.exif_transpose(image).convert("RGB")
                thumb.thumbnail((cellw - 20, cellh - 65))
                sheet.paste(thumb, (x + (cellw - thumb.width) // 2, y + 10))
            draw.text((x + 10, y + cellh - 48), name[:40], fill="#241931", font=font)
            flags = row.get("content_difference_groups")
            label = f"Seal: {'recovered' if row['seal_recovered'] else 'not recovered'} / OCR flags: {flags if flags is not None else '—'}"
            draw.text((x + 10, y + cellh - 26), label, fill="#573277", font=font)
        sheet.save(directory / "CONTACT-SHEET.jpg", quality=92)
    return text


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    print(report(parser.parse_args().directory))
