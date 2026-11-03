"""Compare two frontend versions using byte-identical existing camera photos.

The benchmark supplies the authenticated reference independently of optical
recovery, so source-only controls can be read too. It is an OCR benchmark,
not an end-to-end seal-recovery or automatic-acceptance assertion.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-frontend",type=Path,required=True)
    parser.add_argument("--candidate-frontend",type=Path,required=True)
    parser.add_argument("--photos-root",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--chromium")
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    images=[args.photos_root/path for path in (
        "controls/plain-source-only-reference-168.jpg",
        "controls/dense-source-only-reference-168.jpg",
        "development2/plain-rect-reference-168.jpg",
        "development2/dense-rect-reference-168.jpg",
        "development2/plain-hex12-reference-168.jpg",
        "development2/dense-hex12-reference-168.jpg",
        "production-baseline/plain-production-reference-911.jpg",
        "production-baseline/dense-production-reference-911.jpg",
    )]
    metadata={}
    for label,frontend in (("baseline",args.baseline_frontend),("candidate",args.candidate_frontend)):
        metadata[label]={"commit":subprocess.check_output(["git","rev-parse","HEAD"],cwd=frontend,text=True).strip()}
        subprocess.run([sys.executable,str(Path(__file__).with_name("browser_check.py")),
            *map(str,images),"--manifest",str(args.photos_root/"documents/manifest.json"),
            "--output",str(args.output/(label+".json")),"--frontend",str(frontend),"--start-server",
            *(["--chromium",args.chromium] if args.chromium else [])],check=True)
    before=json.loads((args.output/"baseline.json").read_text())["rows"]
    after=json.loads((args.output/"candidate.json").read_text())["rows"]
    if len(before)!=len(images) or len(after)!=len(images):raise ValueError("Incomplete OCR comparison")
    rows=[]
    for old,new in zip(before,after):
        if old["image"]!=new["image"] or old["image_sha256"]!=new["image_sha256"]:
            raise ValueError("Compared inputs are not identical")
        rows.append({"image":new["image"],"image_sha256":new["image_sha256"],
            "baseline":{"status":old["ocr_status"],"content_differences":old["content_difference_groups"],
                "spacing_reviews":old["spacing_reviews"],"retry_reviews":len(old["retry_reviews"]),"line_aware":old["line_aware"]},
            "candidate":{"status":new["ocr_status"],"content_differences":new["content_difference_groups"],
                "spacing_reviews":new["spacing_reviews"],"retry_reviews":len(new["retry_reviews"]),"line_aware":new["line_aware"]}})
    result={"frontends":metadata,"scope":"Isolated OCR with authenticated fixture reference; no optical recovery claim", "rows":rows}
    (args.output/"comparison.json").write_text(json.dumps(result,indent=2)+"\n")
    print(json.dumps(result,indent=2),flush=True)


if __name__=="__main__":main()
