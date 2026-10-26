"""Compare raw OCR on the original and dotted synthetic text, without grid removal.

Character error rate is a diagnostic, not a measure of human readability.
Requires Pillow and the tesseract executable with English data.
"""
import json
import subprocess
import sys
from pathlib import Path
from PIL import Image

directory = Path(sys.argv[1])
fixture = json.loads((directory / "fixture.json").read_text())
expected = "".join(fixture["content"].split())


def distance(a, b):
    row = list(range(len(b) + 1))
    for index, left in enumerate(a, 1):
        previous, row = row, [index]
        for column, right in enumerate(b, 1):
            row.append(min(row[-1] + 1, previous[column] + 1,
                           previous[column - 1] + (left != right)))
    return row[-1]


adaptive = len(sys.argv) > 2 and sys.argv[2] == "adaptive"
variants = ["original", "33-binary", "33-adaptive-gray", "50-binary", "50-adaptive-gray"] if adaptive else ["original", "33", "50", "33-minimal", "50-minimal"]
results = []
for name in variants:
    source = directory / ("text-original.png" if name == "original" else ("text-" if adaptive else "text-dots-") + name + ".png")
    image = Image.open(source)
    if name != "original":
        image = image.crop((48, 48, image.width - 48, image.height - 48))
    # Same text region for every variant; margins/finder patterns are excluded.
    image = image.crop((90, 80, 2050, 2050))
    target = directory / ("ocr-" + name + ".png")
    image.save(target)
    text = subprocess.check_output(["tesseract", str(target), "stdout", "--dpi", "300", "--psm", "6", "-l", "eng"], text=True, stderr=subprocess.DEVNULL)
    actual = "".join(text.split())
    errors = distance(expected, actual)
    result = {"variant": name, "expectedCharacters": len(expected), "recognizedCharacters": len(actual),
              "editDistanceIgnoringWhitespace": errors, "characterErrorRate": errors / len(expected)}
    results.append(result)
    print(json.dumps(result), flush=True)
(directory / ("ocr-adaptive-results.json" if adaptive else "ocr-results.json")).write_text(json.dumps({"note": "Raw OCR diagnostic only; not human readability or document verification.", "results": results}, indent=2))
