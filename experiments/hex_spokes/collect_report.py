"""Collect compact, synthetic-only experiment evidence from completed runs."""
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
DATA=ROOT/"simulation-results/hex"
HERE=Path(__file__).resolve().parent

def read(path):return json.loads((DATA/path).read_text())

development=read("development2/results.json")["rows"]
holdout=read("holdout/results.json")["rows"]
faint=read("faint-development/results.json")["rows"]
fixtures=read("documents/manifest.json")
expected={d["name"]:d["seals"] for d in fixtures["documents"]}
ocr={}
for label,path in {
    "reference_raw":"development2/ocr.json",
    "reference_rectified":"development2/ocr-rectified.json",
    "faint_raw":"faint-development/ocr.json",
    "controls_raw":"controls/ocr.json",
    "production_reference":"production-baseline/ocr-and-scan.json",
}.items():
    ocr[label]=[]
    for row in read(path)["rows"]:
        scan=row.get("scanned") or {}
        ocr[label].append({"image":row["image"],"document":row["document"],
            "status":row["ocr_status"],"difference_groups":len(row["differences"]),
            "uncertain_words":row["uncertain_count"],"contrast_assisted":row["contrast_assisted"],
            "differences":row["differences"],"seconds":row["seconds"],
            **({"production_scan_status":scan.get("status"),"production_signature_status":scan.get("verified"),
                "production_exact_payload":scan.get("verified")=="VALID" and scan.get("payloads")==expected[row["document"]]}
                if label=="production_reference" else {})})
case_records=[]
for directory in ("development2","holdout","faint-development","controls","production-baseline"):
    for path in sorted((DATA/directory).glob("*.json")):
        data=json.loads(path.read_text())
        if "simulator_version" in data:case_records.append({"run":directory,**data})
source_files=["tests/print_camera.py","experiments/hex_spokes/decode.py","experiments/hex_spokes/layout.py",
              "experiments/hex_spokes/render.py","frontend/scripts/prepareHexSpokeDocuments.mjs"]
evidence={"date_utc":"2026-11-03","base_commit":"7e829556456e5ec7406e759df6f783bc6e03c216",
    "full_acceptance_passed":False,"scope":"Experimental optical reader and separate production OCR; no browser workflow integration",
    "development":development,"holdout":holdout,"faint_development":faint,
    "ocr":ocr,"negative_controls":read("controls/negative-controls.json")["rows"],
    "rendered":read("documents/rendered.json"),"faint_rendered":read("faint-documents/rendered.json"),
    "case_records":case_records,
    "code_sha256":{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in source_files}}
(HERE/"evidence.json").write_text(json.dumps(evidence,indent=2)+"\n")

passed=lambda row:"PASS" if row["passed"] else "FAIL"
index={(r["document"],r["kind"],r["profile"]):r for r in holdout}
count=lambda kind:sum(r["passed"] for r in holdout if r["kind"]==kind)
lines=["# Hex-spoke print/camera experiment results", "", "2026-11-03 UTC. **Not ready for a physical acceptance print.**", "",
    "The twelve-spoke carrier recovered the exact signed payload on both reference documents, but did not pass the full preset sweep. "
    "The independently run OCR checks also reported differences on unchanged pages, including unwatermarked controls. "
    "No full QRed browser workflow pass is claimed. No production behavior or acceptance threshold was changed.", "",
    "## Frozen optical evaluation", "",
    "Two synthetic documents, all nine unchanged simulator presets, seed 911. Rendering/reader settings were fixed after development with seed 168. "
    "A PASS requires recovery of the exact expected transport, normal QRed error correction, and valid digest/Ed25519 authentication. "
    "It does not mean the visible words passed OCR.", "",
    "The rectangular columns use the same experimental registration and sampler infrastructure as the hex columns. "
    "They are controlled carrier comparisons, not results from the native production scanner. "
    "All have the same payload, page area, marker dimensions and 85% gray ink shade; total ink coverage differs.", "",
    "| Simulator preset | Plain rectangles | Plain 12 spokes | Dense rectangles | Dense 12 spokes |",
    "| --- | --- | --- | --- | --- |"]
for profile in dict.fromkeys(r["profile"] for r in holdout):
    lines.append("| "+profile+" | "+" | ".join(passed(index[d,k,profile]) for d,k in
        (("plain","rect"),("plain","hex12"),("dense","rect"),("dense","hex12")))+" |")
lines += ["",f"Twelve spokes: **{count('hex12')}/18** optical cases passed. Controlled rectangles: **{count('rect')}/18**. "
    "One seed per preset and only two payloads are insufficient to establish a general advantage.", "",
    "## What the neighbor evidence contributed", "",
    "Reference development run, seed 168, 85% gray:", "",
    "| Carrier | Plain exact payload | Dense exact payload |",
    "| --- | --- | --- |"]
for kind in ("rect","dots","hex6","hex12"):
    lines.append("| "+kind+" | "+" | ".join(passed(next(r for r in development if r["document"]==d and r["kind"]==kind)) for d in ("plain","dense"))+" |")
lines += ["", "On the same twelve-spoke photo, enabling neighbor measurements changed the pre-ECC results:", "",
    "| Document | Center-only wrong bits | With neighbor evidence | Center-only payload | With neighbors |",
    "| --- | ---: | ---: | --- | --- |"]
for doc in ("plain","dense"):
    row=next(r for r in development if r["document"]==doc and r["kind"]=="hex12")
    a,b=row["candidates"][0],row["candidates"][2]
    lines.append(f'| {doc} | {a["bit_errors"]} | {b["bit_errors"]} | {"PASS" if a["exact_payload"] else "FAIL"} | {"PASS" if b["exact_payload"] else "FAIL"} |')
lines += ["", "These wrong-bit totals include guessed values at erased positions. They are not undetected errors after authentication. "
    "The dense held-out reference and clustered cases also passed only after neighbor evidence was used.", "",
    "## Failure limits", "",
    "* Dense live-preview resolution and blur/compression still fail. Twelve thin directions are not automatically easier to resolve than filled modules.",
    "* The plain blur/compression case fails marker-geometry consistency. Some other misses reject low separability or exhaust the erasure budget.",
    "* High-resolution and low-printer-DPI cases produce many erasures. A likely reader limitation is confusing resolved halftone dots with document ink; this diagnosis needs a separate ablation.",
    "* A 94% gray development trial still decoded the plain page but lost the dense-page payload. It did not eliminate the existing OCR differences.", "",
    "## Independent OCR and production baseline", "",
    "OCR used the existing QRed browser reader and comparison, with no expected text supplied to recognition. "
    "Difference groups are the existing comparison's output, not a normalized accuracy score. "
    "All listed raw-camera OCR checks failed the unchanged-text criterion.", "",
    "| Image | Gray / phase | Difference groups | OCR status |",
    "| --- | --- | ---: | --- |"]
for phase in ("reference_raw","faint_raw","controls_raw","production_reference"):
    for row in ocr[phase]:
        lines.append(f'| {row["image"]} | {phase} | {row["difference_groups"]} | {row["status"]} |')
lines += ["", "Rectifying the two reference carriers before OCR was tested separately and also failed; the detailed differences are in `evidence.json`. "
    "The unwatermarked controls already have OCR errors, so these results do not establish that hexes caused the whole OCR problem.", "",
    "For the actual production PDFs (without experimental tags), the unchanged production reader recovered "
    +str(sum(r["production_exact_payload"] for r in ocr["production_reference"]))+" of 2 exact reference payloads at seed 911. "
    "The production dense invoice authenticated; the plain page did not decode within the requested search. Both failed OCR. "
    "This baseline remains separate from the controlled rectangle experiment.", "",
    "## Validation and reproducibility", "",
    "* Three geometry invariants passed: correct two distance shells/reciprocity, contained strokes/margins, unique public registration IDs.",
    "* Nine existing simulator model tests passed.",
    "* Thirty-four existing QR construction, erasure recovery and verifier tests passed.",
    "* Four source-only/registration-only optical negatives were rejected before payload recovery; none authenticated.",
    "* The 36-case optical acceptance command exited **1**, preserving the failures. The measured pass/fail table is not an expected-failure waiver.", "",
    "`evidence.json` records the measurements, OCR differences, per-photo simulator manifests, hashes, profiles, seeds, and runtime versions. "
    "The normal simulator is unmodified. The photos and fixtures use only public synthetic material. "
    "See [README.md](README.md) to reproduce the experiment. No real printer or phone has been validated, and the hex reader is not installed in the production browser app.", ""]
(HERE/"RESULTS.md").write_text("\n".join(lines))
print(json.dumps({"hex12_passed":count("hex12"),"controlled_rect_passed":count("rect"),"case_records":len(case_records),
    "evidence_bytes":(HERE/"evidence.json").stat().st_size}))
