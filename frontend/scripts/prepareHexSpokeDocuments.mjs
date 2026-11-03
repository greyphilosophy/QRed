// Public synthetic fixtures for the opt-in hex-spoke experiment.
// This manifest is an encoder/test oracle. Never give it to the optical reader.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { sealPdfInBrowser } from "../src/pdfClientSeal.js";
import { verifyQRedSeals } from "../src/qredVerifier.js";
import { createQRedQrSymbol } from "../src/qredQr.js";

const output = resolve(process.env.QRED_HEX_OUTPUT || "../simulation-results/hex/documents");
mkdirSync(output, { recursive: true });
const signing = {
  privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes",
  publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q",
}; // Published demo key, never use for real documents.
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ["2026-11-02T12:00:00Z"])); }
};
try {
  const manifest = { publicKey: signing.publicKey, documents: [] };
  for (const kind of ["plain", "dense"]) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const page = pdf.addPage([612, 792]);
    if (kind === "plain") {
      ["Invoice 1042", "Account 123456", "Approved total 123.45", "Payment due Friday"].forEach((line, i) =>
        page.drawText(line, {x:65, y:680-i*65, font, size:22}));
    } else {
      page.drawText("NORTH SHORE - SAMPLE INVOICE", {x:60,y:690,size:16,font:bold,color:rgb(.1,.2,.4)});
      page.drawCircle({x:500,y:695,size:16,color:rgb(.15,.3,.45)});
      page.drawText("DEMO", {x:486,y:692,size:8,font:bold,color:rgb(1,1,1)});
      ["Customer: Sample Customer", "Account: 103458", "Reference: INV-2026-1042"].forEach((line,i) =>
        page.drawText(line,{x:60,y:640-i*18,size:10,font}));
      page.drawRectangle({x:60,y:549,width:490,height:20,color:rgb(.91,.91,.91)});
      page.drawText("Date          Description                                      Charge       Credit", {x:65,y:556,size:10,font:bold});
      for(let i=0;i<16;i++) {
        const y=535-i*19;
        page.drawText(`11-${String(i+1).padStart(2,"0")}-26`,{x:65,y,size:10,font});
        page.drawText(i%3?"Service charge":"Room charge",{x:135,y,size:10,font});
        page.drawText((i%3?5.25:125.50).toFixed(2),{x:430,y,size:10,font});
        page.drawLine({start:{x:60,y:y-5},end:{x:550,y:y-5},thickness:.35,color:rgb(.45,.45,.45)});
      }
      page.drawText("Balance  -100.00",{x:350,y:180,size:12,font:bold});
      page.drawText("Customer's approval - payment due Friday.",{x:60,y:130,size:10,font});
      page.drawText("Synthetic test data. Keep the original seal when testing altered wording.",{x:60,y:110,size:9,font});
    }
    const source=await pdf.save();
    writeFileSync(join(output,`${kind}-source.pdf`),source);
    const result=await sealPdfInBrowser({file:new File([source],`${kind}.pdf`,{type:"application/pdf"}),...signing,
      pageScalingStrategy:"automatic",encodingStrategy:"automatic"});
    writeFileSync(join(output,`${kind}-production.pdf`),Buffer.from(await result.blob.arrayBuffer()));
    const seals=result.pageSealStrings[0];
    if(seals.length!==1) throw new Error("Experiment currently supports one QR symbol per page");
    const verified=await verifyQRedSeals(seals,signing.publicKey);
    if(verified.status!=="VALID") throw new Error("Fixture signature failed");
    const symbol=await createQRedQrSymbol(seals[0]);
    const size=symbol.modules.size;
    manifest.documents.push({name:kind,source:`${kind}-source.pdf`,seals,text:verified.content,
      version:symbol.version,size,maskPattern:symbol.maskPattern,errorCorrectionLevel:symbol.errorCorrectionLevel,
      bits:Array.from({length:size*size},(_,i)=>Number(symbol.modules.get(Math.floor(i/size),i%size)))});
    console.log(JSON.stringify({name:kind,version:symbol.version,size,level:symbol.errorCorrectionLevel}));
  }
  writeFileSync(join(output,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
} finally {globalThis.Date=RealDate;}
