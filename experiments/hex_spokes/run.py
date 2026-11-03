"""Run the unmodified print/camera model and independently read its photos."""
import argparse
from dataclasses import asdict,replace
import hashlib
import json
from pathlib import Path
import sys
import subprocess
import time
import numpy as np

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"tests"))
from print_camera import PRESETS,rasterize,save_case
from decode import decode

def main():
    p=argparse.ArgumentParser();p.add_argument("--directory",type=Path,default=ROOT/"simulation-results/hex/documents")
    p.add_argument("--output",type=Path,default=ROOT/"simulation-results/hex/development")
    p.add_argument("--profiles",nargs="+",default=["reference"])
    p.add_argument("--documents",nargs="+",default=["plain","dense"])
    p.add_argument("--kinds",nargs="+",default=["rect","dots","hex6","hex12"])
    p.add_argument("--seed",type=int,default=168);p.add_argument("--reuse",action="store_true")
    p.add_argument("--require-all",action="store_true",help="Exit nonzero if any optical case fails")
    args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    # Expected matrices are kept in this harness, not passed into decode().
    fixtures=json.loads((args.directory/"manifest.json").read_text())
    rows=[];samples=[]
    for doc in fixtures["documents"]:
        if doc["name"] not in args.documents:continue
        for kind in args.kinds:
            pdf=args.directory/f'{doc["name"]}-{kind}.pdf';rasters={}
            for name in args.profiles:
                profile=replace(PRESETS[name],seed=args.seed)
                case=f'{doc["name"]}-{kind}-{name}-{args.seed}';start=time.monotonic()
                existing=list(args.output.glob(case+".jpg"))+list(args.output.glob(case+".png"))
                if args.reuse and existing:
                    photo=existing[0]
                    record=json.loads((args.output/(case+".json")).read_text())
                    if record["input_sha256"]!=hashlib.sha256(pdf.read_bytes()).hexdigest() or \
                        record["photo_sha256"]!=hashlib.sha256(photo.read_bytes()).hexdigest() or \
                        record["profile"]!=json.loads(json.dumps(asdict(profile))):
                        raise ValueError("Cached photo does not match source/profile/hash: "+case)
                else:
                    dpi=profile.printer.dpi
                    if dpi not in rasters:rasters[dpi]=rasterize(pdf,1,dpi)
                    photo,_=save_case(pdf,1,profile,args.output,case,raster=rasters[dpi])
                row={"id":case,"document":doc["name"],"kind":kind,"profile":name,"seed":args.seed}
                try:
                    measured=decode(photo)
                    row.update({k:v for k,v in measured.items() if k!="candidates"})
                    row["candidates"]=[]
                    truth=np.array(doc["bits"],dtype=np.uint8)
                    for i,candidate in enumerate(measured["candidates"]):
                        sample={"id":case+f'/{i}',**candidate};samples.append(sample)
                        wrong=np.array(sample["bits"])!=truth;unknown=np.array(sample["unknown"],dtype=bool)
                        row["candidates"].append({"id":sample["id"],"reader":sample["reader"],"erasure":sample["erasure"],
                            "bit_errors":int(wrong.sum()),"known_errors":int((wrong&~unknown).sum()),"erased_bits":int(unknown.sum()),
                            "total_bits":len(truth)})
                except Exception as error:row["error"]=str(error)
                row["seconds"]=round(time.monotonic()-start,2);rows.append(row)
                print(json.dumps(row),flush=True)
                (args.output/"measurements.json").write_text(json.dumps({"rows":rows},indent=2)+"\n")
                (args.output/"samples.json").write_text(json.dumps({"publicKey":fixtures["publicKey"],"samples":samples})+"\n")
    subprocess.run(["node","node_modules/vite-node/vite-node.mjs","scripts/verifyHexSpokeSamples.mjs",
        str((args.output/"samples.json").resolve()),str((args.output/"verified.json").resolve())],
        cwd=ROOT/"frontend",stdout=subprocess.DEVNULL,check=True)
    result=subprocess.run([sys.executable,str(Path(__file__).with_name("summarize.py")),str(args.output),
        "--manifest",str(args.directory/"manifest.json"),*(["--require-all"] if args.require_all else [])])
    raise SystemExit(result.returncode)

if __name__=="__main__":main()
