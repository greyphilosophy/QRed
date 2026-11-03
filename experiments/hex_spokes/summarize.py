"""Exact-payload acceptance, after independent optical/ECC/signature decoding."""
import argparse
import hashlib
import json
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument("directory",type=Path);p.add_argument("--manifest",type=Path,required=True)
p.add_argument("--require-all",action="store_true")
args=p.parse_args();fixtures=json.loads(args.manifest.read_text())
truth={d["name"]:d["seals"][0] for d in fixtures["documents"]}
measured=json.loads((args.directory/"measurements.json").read_text())["rows"]
decoded=json.loads((args.directory/"verified.json").read_text())
if decoded.get("input_sha256")!=hashlib.sha256((args.directory/"samples.json").read_bytes()).hexdigest():
    raise SystemExit("Verification does not belong to these samples; rerun the verifier")
verified={r["id"]:r for r in decoded["results"]}
for row in measured:
    for candidate in row.get("candidates",[]):
        result=verified.get(candidate["id"],{})
        candidate["authenticates"]=result.get("status")=="VALID"
        candidate["exact_payload"]=candidate["authenticates"] and result.get("payload")==truth[row["document"]]
        candidate["ecc_method"]=result.get("method")
        candidate["ecc_ms"]=result.get("ms")
    candidates=row.get("candidates",[])
    row["passed"]=any(c["exact_payload"] for c in candidates) and not any(
        c["authenticates"] and not c["exact_payload"] for c in candidates)
    print(row["id"],"PASS" if row["passed"] else "FAIL",
          [(c["reader"],c["erasure"],c["known_errors"],c["erased_bits"],c["exact_payload"]) for c in row.get("candidates",[])])
(args.directory/"results.json").write_text(json.dumps({"rows":measured},indent=2)+"\n")
if args.require_all and not all(r["passed"] for r in measured):raise SystemExit(1)
