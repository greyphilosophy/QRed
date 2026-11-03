"""Unsealed source and registration-only controls; no expected bits in reader."""
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"tests"))
from print_camera import PRESETS,save_case
from decode import decode
from render import render

documents=ROOT/"simulation-results/hex/documents"
output=ROOT/"simulation-results/hex/controls";output.mkdir(parents=True,exist_ok=True)
fixtures=json.loads((documents/"manifest.json").read_text());rows=[];samples=[]
for doc in fixtures["documents"]:
    unsealed=output/f'{doc["name"]}-tags-only.pdf'
    render({**doc,"bits":[0]*len(doc["bits"])},documents/doc["source"],unsealed,"hex12")
    for kind,pdf in (("source-only",documents/doc["source"]),("tags-only",unsealed)):
        name=f'{doc["name"]}-{kind}-reference-168'
        photo,manifest=save_case(pdf,1,PRESETS["reference"],output,name)
        row={"id":name,"expected_authentication":False}
        try:
            result=decode(photo)
            for i,candidate in enumerate(result["candidates"]):samples.append({"id":name+f'/{i}',**candidate})
            row["optical_candidates"]=len(result["candidates"])
        except ValueError as error:row["rejection"]=str(error)
        rows.append(row);print(json.dumps(row),flush=True)
(output/"negative-controls.json").write_text(json.dumps({"rows":rows},indent=2)+"\n")
(output/"samples.json").write_text(json.dumps({"publicKey":fixtures["publicKey"],"samples":samples})+"\n")
