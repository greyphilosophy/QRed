"""Existing QRed OCR/comparison on experiment photos (not a UI acceptance test)."""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import time
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

def main():
    p=argparse.ArgumentParser();p.add_argument("images",nargs="+",type=Path)
    p.add_argument("--manifest",type=Path,required=True);p.add_argument("--output",type=Path,required=True)
    p.add_argument("--url",default="http://127.0.0.1:3177");p.add_argument("--chromium")
    p.add_argument("--production-scan",action="store_true")
    p.add_argument("--start-server",action="store_true")
    args=p.parse_args();fixtures=json.loads(args.manifest.read_text())
    server=None
    if args.start_server:
        server=subprocess.Popen(["node","node_modules/vite/bin/vite.js","--host","127.0.0.1","--port",args.url.rsplit(":",1)[1]],
            cwd=Path(__file__).resolve().parents[2]/"frontend",stdout=subprocess.DEVNULL)
        for _ in range(50):
            try:
                with urlopen(args.url,timeout=1):break
            except OSError:time.sleep(.2)
    try:
        check(args,fixtures)
    finally:
        if server:
            server.terminate()
            try:server.wait(timeout=10)
            except subprocess.TimeoutExpired:server.kill();server.wait()

def check(args,fixtures):
    rows=[]
    with sync_playwright() as pw:
        browser=pw.chromium.launch(**({"executable_path":args.chromium} if args.chromium else {}))
        page=browser.new_page();page.goto(args.url,wait_until="networkidle")
        for path in args.images:
            document=next(d for d in fixtures["documents"] if path.name.startswith(d["name"]+"-"))
            mime="image/png" if path.suffix==".png" else "image/jpeg"
            data="data:"+mime+";base64,"+base64.b64encode(path.read_bytes()).decode()
            result=page.evaluate("""async ({data,expected,key,scan}) => {
              const {createPhotoOcrReader,openPagePhoto}=await import('/src/verifier/photoOcr.js');
              const {comparePageReading}=await import('/src/verifier/photoReading.js');
              const blob=await (await fetch(data)).blob();
              const canvas=await openPagePhoto(new File([blob],'photo', {type:blob.type}));
              const started=performance.now();const reader=createPhotoOcrReader();
              try {
                let scanned=null;
                if(scan) {
                  const {decodePhoto}=await import('/src/qr/decodePhoto.js');
                  const {verifyQRedSeals}=await import('/src/qredVerifier.js');
                  const image=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
                  const result=decodePhoto(image,{returnPayload:true,maxDurationMs:20000});
                  const payloads=result.texts || (result.text?[result.text]:[]);
                  const verified=payloads.length?await verifyQRedSeals(payloads,key):null;
                  scanned={status:result.status,verified:verified?.status,payloads};
                }
                let timer;
                const reading=await Promise.race([reader.read(canvas),new Promise((_,reject)=>{
                  timer=setTimeout(()=>reject(new Error('OCR exceeded 60 seconds')),60000);
                })]).finally(()=>clearTimeout(timer));
                const comparison=comparePageReading(expected,reading,{width:canvas.width,height:canvas.height});
                return {ocr_status:comparison.status,differences:comparison.differences,
                  uncertain_count:comparison.uncertainCount,words:reading.words,
                  contrast_assisted:reading.contrastAssisted,scanned,seconds:(performance.now()-started)/1000};
              } finally {reader.dispose();canvas.width=canvas.height=0;}
            }""",dict(data=data,expected=document["text"],key=fixtures["publicKey"],scan=args.production_scan))
            row={"image":path.name,"document":document["name"],**result};rows.append(row)
            args.output.write_text(json.dumps({"rows":rows},indent=2)+"\n")
            print(json.dumps({k:v for k,v in row.items() if k not in ("words","scanned")}),flush=True)
        browser.close()

if __name__=="__main__":main()
