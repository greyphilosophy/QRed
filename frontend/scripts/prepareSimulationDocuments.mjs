// Synthetic documents sealed by the production PDF pipeline. Nothing private.
// Run: node node_modules/vite-node/vite-node.mjs scripts/prepareSimulationDocuments.mjs
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { sealPdfInBrowser } from "../src/pdfClientSeal.js";
import { verifyQRedSeals } from "../src/qredVerifier.js";

const output = resolve(process.env.QRED_SIM_OUTPUT || "../simulation-results/documents");
mkdirSync(output, { recursive: true });
const signing = {
  privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes",
  publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q",
};
// Only wall-clock date construction is fixed. Performance clocks still run.
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ["2026-11-02T12:00:00Z"])); }
};

async function sourceDocument(kind) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (let n = 0; n < (kind === "plain" ? 2 : 1); n++) {
    const page = pdf.addPage([612, 792]);
    if (kind === "plain") {
      ["Invoice 1042", "Account 123456", "Approved total 123.45", "Payment due Friday"].forEach((line, index) =>
        page.drawText(line, { x: 65, y: 680 - index*65, font, size: 22 }));
    } else if (kind === "dense") {
      page.drawText("NORTH SHORE - SAMPLE INVOICE", { x: 60, y: 720, size: 16, font: bold, color: rgb(.1, .2, .4) });
      page.drawCircle({ x: 500, y: 725, size: 16, color: rgb(.15, .3, .45) });
      page.drawText("DEMO", { x: 486, y: 722, size: 8, font: bold, color: rgb(1,1,1) });
      ["Customer: Sample Customer", "Account: 103458", "Reference: INV-2026-1042"].forEach((line, i) =>
        page.drawText(line, { x: 60, y: 670-i*18, size: 10, font }));
      page.drawRectangle({x:60,y:579,width:490,height:20,color:rgb(.91,.91,.91)});
      page.drawText("Date          Description                                      Charge       Credit", {x:65,y:586,size:10,font:bold});
      for (let i = 0; i < 16; i++) {
        const y = 565-i*19;
        page.drawText(`11-${String(i+1).padStart(2,"0")}-26`, {x:65,y,size:10,font});
        page.drawText(i%3 ? "Service charge" : "Room charge", {x:135,y,size:10,font});
        page.drawText((i%3 ? 5.25 : 125.50).toFixed(2), {x:430,y,size:10,font});
        page.drawLine({start:{x:60,y:y-5},end:{x:550,y:y-5},thickness:.35,color:rgb(.45,.45,.45)});
      }
      page.drawText("Balance  -100.00", {x:350,y:210,size:12,font:bold});
      page.drawText("Customer's approval - payment due Friday.", {x:60,y:160,size:10,font});
      page.drawText("Synthetic test data. Keep the original seal when testing altered wording.", {x:60,y:140,size:9,font});
    } else {
      page.drawText("MULTIPART INVENTORY - SYNTHETIC DATA", {x:50,y:740,size:12,font:bold});
      let state = 0x168;
      const next = () => {state ^= state<<13;state ^= state>>>17;state ^= state<<5;return state>>>0;};
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
      for (let row=0;row<52;row++) {
        const text = Array.from({length:82},()=>alphabet[next()%alphabet.length]).join("");
        page.drawText(text,{x:50,y:710-row*12,size:7,font});
      }
    }
  }
  return pdf.save();
}

try {
  const manifest = { publicKey: signing.publicKey, documents: [] };
  for (const kind of ["plain", "dense", "multipart"]) {
    const source = await sourceDocument(kind);
    writeFileSync(join(output, kind+"-source.pdf"), source);
    const result = await sealPdfInBrowser({file: new File([source], kind+".pdf", {type:"application/pdf"}),
      ...signing, pageScalingStrategy:kind==="multipart"?"legal-footer":"automatic",
      encodingStrategy:kind==="multipart"?"plaintext":"automatic"});
    const bytes = Buffer.from(await result.blob.arrayBuffer());
    writeFileSync(join(output, kind+"-sealed.pdf"), bytes);
    const pages = [];
    for (const seals of result.pageSealStrings) {
      const verified = await verifyQRedSeals(seals, signing.publicKey);
      if (verified.status !== "VALID") throw new Error("Synthetic signing failed");
      pages.push({seals, text:verified.content});
    }
    manifest.documents.push({name:kind, file:kind+"-sealed.pdf", pages,
      footerPages:result.footerPages, layouts:result.watermarkLayout});
    if (kind === "multipart" && pages[0].seals.length < 2) throw new Error("Multipart fixture did not require multiple seals");
    if (kind === "plain") {
      // Alter the already sealed PDF, never re-sign the changed content.
      const altered = await PDFDocument.load(bytes);
      const font = await altered.embedFont(StandardFonts.Helvetica);
      const page = altered.getPage(1);
      const offset = page.getHeight()-792;
      const x = 65+font.widthOfTextAtSize("Approved total ",22);
      page.drawRectangle({x:x-1,y:offset+544,width:100,height:28,color:rgb(1,1,1)});
      page.drawText("923.45",{x,y:offset+550,size:22,font});
      writeFileSync(join(output,"plain-altered.pdf"), await altered.save());
    }
    console.log(JSON.stringify({name:kind, parts:pages.map(p=>p.seals.length),footerPages:result.footerPages}));
  }
  writeFileSync(join(output,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
} finally { globalThis.Date = RealDate; }
