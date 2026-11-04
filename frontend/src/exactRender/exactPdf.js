import { PDFDocument } from "pdf-lib";
import { encodeErasureChunks } from "../erasureTransport.js";
import { sealString } from "../sealFormat.js";
import { createQRedQrSymbol } from "../qredQr.js";
import { drawQrSymbol } from "../pdf/qrDrawing.js";
import { scanErasureSeals } from "../qr/scanErasureSeals.js";
import { authenticateExactRecord, createExactRecord } from "./record.js";
import { EXACT_PROFILE, renderExactPage, withExactDocument } from "./renderer.js";
import { compareExactPixels, EXACT_SCOPE, EXACT_STYLE, exactDocumentRoot, rasterHash, validateExactManifest } from "./evidence.js";
import { chooseExactBoxes } from "./placement.js";

export { EXACT_PROFILE, EXACT_SCOPE };
const next = async signal => { await new Promise(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted(); };
function drawSymbols(page, symbols, manifest) {
  symbols.forEach((symbol, index) => {
    const [x, y, width, height] = manifest.boxes[index];
    drawQrSymbol(page, symbol, { x: x / 2, y: (manifest.height - y - height) / 2, width: width / 2, height: height / 2 }, 0.85, false);
  });
}
async function symbolsFor(record, manifest) {
  validateExactManifest(manifest, EXACT_PROFILE);
  const shards = await encodeErasureChunks(record, { required: 12, total: 16 });
  const symbols = shards.map(bytes => createQRedQrSymbol(sealString(bytes), { errorCorrectionLevel: "M" }));
  if (symbols.some((symbol, index) => manifest.boxes[index][2] / 2 / (symbol.modules.size + 8) < 1.25))
    throw new Error("Exact-render evidence exceeds the fixed seal capacity");
  return symbols;
}
async function regeneratedOverlay(record, manifest, signal) {
  const symbols = await symbolsFor(record, manifest); signal?.throwIfAborted();
  const blank = await PDFDocument.create(), page = blank.addPage([manifest.width / 2, manifest.height / 2]);
  drawSymbols(page, symbols, manifest);
  const file = new Blob([await blank.save()], { type: "application/pdf" }); signal?.throwIfAborted();
  return withExactDocument(file, pdf => renderExactPage(pdf, 1, { signal }), { signal });
}

export async function verifyExactPdf({ file, publicKey, signal, onProgress = () => {} }) {
  const pages = [], manifests = [], identities = [];
  await withExactDocument(file, async pdf => {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      await next(signal); onProgress({ stage: "verifying", pageNumber, pageCount: pdf.numPages });
      try {
        const image = await renderExactPage(pdf, pageNumber, { signal }); signal?.throwIfAborted();
        const seals = await scanErasureSeals(image, { signal }); signal?.throwIfAborted();
        const authenticated = await authenticateExactRecord(seals, publicKey, { profile: EXACT_PROFILE }); signal?.throwIfAborted();
        const { manifest, record, metadata, signatureStatus } = authenticated;
        if (!manifest) {
          pages.push({ pageNumber, signatureStatus, exactRender: { status: "inconclusive", reason: authenticated.reason } });
          continue;
        }
        if (manifest.page !== pageNumber || manifest.pages !== pdf.numPages) {
          pages.push({ pageNumber, signatureStatus, exactRender: { status: "inconclusive", reason: "page-position-or-count-mismatch" } });
          continue;
        }
        const overlay = await regeneratedOverlay(record, manifest, signal); signal?.throwIfAborted();
        const exactRender = await compareExactPixels(image, manifest, overlay, EXACT_PROFILE); signal?.throwIfAborted();
        pages.push({ pageNumber, signatureStatus, exactRender, profile: manifest.profile });
        manifests.push(manifest); identities.push(`${metadata.key_id}:${metadata.timestamp}`);
      } catch (error) {
        signal?.throwIfAborted();
        pages.push({ pageNumber, signatureStatus: "UNSUPPORTED", exactRender: { status: "inconclusive", reason: "render-or-evidence-unavailable" }, message: error.message });
      }
    }
  }, { signal });
  let completeExactRenderedDocument = false;
  if (pages.length && pages.every(page => page.signatureStatus === "VALID" && page.exactRender.status === "exact-render-match")) {
    const root = await exactDocumentRoot(manifests, EXACT_PROFILE); signal?.throwIfAborted();
    completeExactRenderedDocument = manifests.length === pages.length && identities.every(value => value === identities[0]) &&
      manifests.every((manifest, index) => manifest.page === index + 1 && manifest.pages === pages.length && manifest.documentRoot === root);
    if (!completeExactRenderedDocument) for (const page of pages) page.exactRender = { status: "inconclusive", reason: "document-root-or-signing-session-mismatch" };
  }
  return { pages, completeExactRenderedDocument, profile: EXACT_PROFILE, scope: EXACT_SCOPE };
}

export async function sealExactPdf({ file, privateKey, publicKey, signal, onProgress = () => {} }) {
  const plans = [];
  await withExactDocument(file, async pdf => {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      await next(signal); onProgress({ stage: "reading-source", pageNumber, pageCount: pdf.numPages });
      const image = await renderExactPage(pdf, pageNumber, { signal }); signal?.throwIfAborted();
      const boxes = await chooseExactBoxes(image, { signal }), sourceSha256 = await rasterHash(image.data); signal?.throwIfAborted();
      plans.push({ width: image.width, height: image.height, sourceSha256, boxes });
    }
  }, { signal });
  const documentRoot = await exactDocumentRoot(plans, EXACT_PROFILE); signal?.throwIfAborted();
  const output = await PDFDocument.load(await file.arrayBuffer()); signal?.throwIfAborted();
  if (output.getPageCount() !== plans.length) throw new Error("PDF page count changed during sealing");
  const timestamp = new Date().toISOString();
  for (let index = 0; index < plans.length; index++) {
    await next(signal); onProgress({ stage: "sealing", pageNumber: index + 1, pageCount: plans.length });
    const plan = plans[index];
    const manifest = { type: "QRED-EXACT-RENDER", version: 1, profile: EXACT_PROFILE, style: EXACT_STYLE,
      width: plan.width, height: plan.height, scale: 2, rotation: 0, userUnit: 1, bounds: [0, 0, plan.width / 2, plan.height / 2],
      page: index + 1, pages: plans.length, sourceSha256: plan.sourceSha256, documentRoot, required: 12, total: 16, boxes: plan.boxes };
    const { record } = await createExactRecord(manifest, { privateKey, publicKey, timestamp, profile: EXACT_PROFILE }); signal?.throwIfAborted();
    const symbols = await symbolsFor(record, manifest); signal?.throwIfAborted();
    drawSymbols(output.getPage(index), symbols, manifest);
  }
  const blob = new Blob([await output.save()], { type: "application/pdf" }); signal?.throwIfAborted();
  // Actual rendered output must complete the source-free optical loop. Never
  // substitute generated sidecars, original rasters or direct record injection.
  const verified = await verifyExactPdf({ file: blob, publicKey, signal, onProgress }); signal?.throwIfAborted();
  if (!verified.completeExactRenderedDocument) throw new Error("The sealed PDF did not pass exact optical verification. No output was produced.");
  return { blob, ...verified };
}
