"""Compare the three-tone carrier to the existing binary dots, using synthetic input."""
import json
from PIL import Image, ImageChops, ImageStat
import render as baseline

directory = baseline.directory
manifest = {"note": "Three physical tones encode one bit per cell. Custom reader required. Synthetic simulations only.", "samples": []}
metrics = []
for kind in ["image", "text"]:
    background = baseline.cover(kind)
    original = Image.open(directory / (kind + "-original.png"))
    for fraction in [1/3, 1/2]:
        label = str(round(fraction * 100))
        for encoding in ["binary", "adaptive-gray"]:
            base, controlled = baseline.carrier(background, fraction, markers="minimal", encoding=encoding)
            name = f"{kind}-{label}-{encoding}"
            base.save(directory / (name + ".png"))
            active = base.crop((48, 48, base.width - 48, base.height - 48))
            difference = ImageChops.difference(active, original)
            stats = ImageStat.Stat(difference)
            metrics.append({"cover": kind, "dotFraction": fraction, "encoding": encoding,
                            "meanAbsoluteLumaChange": stats.mean[0], "rootMeanSquareLumaChange": stats.rms[0],
                            "note": "Raw pixel difference across active image, including contrast remapping and markers; not a perceptual metric."})
            if encoding == "binary":
                continue  # Baseline scan outcomes are already recorded in observations/.
            for condition in ["clean", "photo", "small-photo", "perspective", "print-spread"]:
                filename = f"{name}-{condition}.png"
                baseline.simulate(base, condition).save(directory / filename)
                manifest["samples"].append({"name": f"{name}-{condition}", "file": filename, "cover": kind,
                    "dotFraction": fraction, "markerStyle": "minimal", "encoding": encoding, "condition": condition})
    control, _ = baseline.carrier(background, 1)
    for condition in ["clean", "photo", "small-photo", "perspective", "print-spread"]:
        name = f"{kind}-control-{condition}"
        baseline.simulate(control, condition).save(directory / (name + ".png"))
        manifest["samples"].append({"name": name, "file": name + ".png", "cover": kind,
            "dotFraction": 1, "markerStyle": "all", "encoding": "binary", "condition": condition})
(directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
(directory / "visual-metrics.json").write_text(json.dumps(metrics, indent=2))
print(json.dumps({"samples": len(manifest["samples"])}))
