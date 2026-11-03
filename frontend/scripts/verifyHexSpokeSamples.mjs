// Receives measured modules only. The expected payload is not a decoder input.
import { readFileSync,writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import jsQR from "jsqr";
import { readErasedQrMatrix } from "../src/qr/qrErasureRecovery.js";
import { extractQrBytePayload,qredPayloadFromScanResult } from "../src/qr/qrPayload.js";
import { verifyQRedSeals } from "../src/qredVerifier.js";

const inputBytes=readFileSync(resolve(process.argv[2]));
const input=JSON.parse(inputBytes.toString("utf8"));
const results=[];
for(const sample of input.samples) {
  const started=performance.now();let verified=null,payload=null,method=null,error=null;
  if(sample.bits) {
    const {bits,unknown,version}=sample;const n=17+4*version;
    try {
      const scale=4,w=(n+8)*scale;const rgba=new Uint8ClampedArray(w*w*4).fill(255);
      for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(bits[y*n+x])
        for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++) {
          const p=(((y+4)*scale+dy)*w+(x+4)*scale+dx)*4;
          rgba[p]=rgba[p+1]=rgba[p+2]=0;
        }
      payload=qredPayloadFromScanResult(jsQR(rgba,w,w,{inversionAttempts:"dontInvert"}));
      if(payload) {verified=await verifyQRedSeals([payload],input.publicKey);method="ordinary QR RS";}
      if(verified?.status!=="VALID") {
        const recovered=readErasedQrMatrix(bits,unknown,version,sample.risk,
          {allowRankedErasures:false});
        payload=recovered&&extractQrBytePayload(recovered.dataCodewords,version);
        verified=payload?await verifyQRedSeals([payload],input.publicKey):null;
        method="QRed bit/byte erasures";
      }
    } catch(e) {error=String(e.message||e);}
  }
  results.push({id:sample.id,status:verified?.status||"UNREADABLE",payload:verified?.status==="VALID"?payload:null,
    method,error,ms:Math.round(performance.now()-started)});
}
const output={input_sha256:createHash("sha256").update(inputBytes).digest("hex"),results};
if(process.argv[3])writeFileSync(resolve(process.argv[3]),JSON.stringify(output,null,2)+"\n");
console.log(JSON.stringify(output,null,2));
