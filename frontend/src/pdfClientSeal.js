import { createQRedSeals, DEFAULT_BOOTSTRAP_URL } from "./qredSealer.js";
import { LEGAL_FOOTER_HEIGHT, LEGAL_PAGE_HEIGHT } from "./pdf/pageScaling.js";
import { QR_SIZE, planQrStampLayout, planQrStampLayoutForFooterBand } from "./pdf/qrLayout.js";
import { planPageEvidence } from "./pdf/pageEvidencePlan.js";
import { flattenPdfForSealing } from "./pdf/flattenPdf.js";
import { createSealingOcrReader } from "./pdf/sealingOcr.js";
import { renderSealedPdf } from "./pdf/renderSealedPdf.js";
export { qrPngBytes } from "./pdf/renderSealedPdf.js";

export { QR_SIZE, LEGAL_PAGE_HEIGHT, LEGAL_FOOTER_HEIGHT };
export { planQrStampLayout, planQrStampLayoutForFooterBand };

async function extractPdfPageTexts(file) {
  const { extractPdfPageTexts: readPages } = await import("./pdf/readPdfText.js");
  return readPages(file);
}

export async function extractPdfText(file) {
  return extractPdfPageTexts(file).then((pages) => pages.join("\n\n").trim());
}

async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pageContentHash(body) { return sha256Hex(body); }

async function documentMerkleRoot(pageTexts) {
  const leaves = await Promise.all(pageTexts.map((pageText) => pageContentHash(pageText)));
  if (leaves.length === 0) return sha256Hex(new Uint8Array());
  let level = leaves;
  while (level.length > 1) {
    const nextLevel = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      nextLevel.push(await sha256Hex(`${left}${right}`));
    }
    level = nextLevel;
  }
  return level[0];
}

async function preparePageSealing({ file, privateKey, publicKey, bootstrapUrl, encodingStrategy, attested, pageScalingStrategy = "automatic", signal, onProgress }) {
  signal?.throwIfAborted();
  const { readPdfPagesWithEvidence } = await import("./pdf/readPdfText.js");
  const ocrReader = createSealingOcrReader({ signal, onProgress });
  let plans;
  try {
    plans = await readPdfPagesWithEvidence(file, page => planPageEvidence(page, {
      attested, multiple: page.pageCount > 1, encodingStrategy,
    }), { ocrReader, signal, onProgress });
  } finally { await ocrReader.dispose(); }
  signal?.throwIfAborted();
  const merkleRoot = await documentMerkleRoot(plans.map(page => page.body));
  const timestamp = new Date().toISOString();
  const contexts = plans.map((_, index) => ({
    pageNumber: index + 1, pageCount: plans.length, documentRoot: merkleRoot,
  }));
  const pages = plans.map((page, index) => ({
    content: page.body,
    metadata: { pdf: true, ...(page.pageEvidence ? { page_evidence: true } : {}),
      page_number: index + 1, page_count: plans.length,
      document_root: plans.length > 1 ? merkleRoot : null },
  }));
  return {
    pages,
    ocrPages: plans.flatMap((page, index) => page.ocr ? [{ pageNumber: index + 1, ...page.ocr }] : []),
    async complete(attestations = null) {
      signal?.throwIfAborted();
      if (attested && (!Array.isArray(attestations) || attestations.length !== plans.length)) {
        throw new Error("Missing page attestations");
      }
      const results = await Promise.all(plans.map(async (page, index) => createQRedSeals({
        content: page.text, pageEvidence: page.pageEvidence, privateKey, publicKey,
        bootstrapUrl, encodingStrategy, timestamp, pageContext: contexts[index],
        // Image-only and blank pages always use an ordinary footer, so do
        // not force them into four pieces merely because the user selected
        // Automatic. The 1-or-4 policy applies to watermark-eligible text.
        preferFourQrPage: Boolean(page.text) &&
          (pageScalingStrategy === "automatic" || pageScalingStrategy === "watermark"),
        attestation: attestations?.[index],
      })));
      return { results, plans };
    },
  };
}

async function createPageSealResults({ file, privateKey, publicKey, bootstrapUrl, encodingStrategy, attestPages, pageScalingStrategy, signal, onProgress, onReviewOcr }) {
  const prepared = await preparePageSealing({
    file, privateKey, publicKey, bootstrapUrl, encodingStrategy, attested: Boolean(attestPages), pageScalingStrategy, signal, onProgress,
  });
  signal?.throwIfAborted();
  if (prepared.ocrPages.length && onReviewOcr) await onReviewOcr(prepared.ocrPages);
  signal?.throwIfAborted();
  const attestations = attestPages ? await attestPages(prepared.pages) : null;
  return prepared.complete(attestations);
}

async function finishPdfSeal({ file, prepared, pageSealResults, plans, pageScalingStrategy }) {
  const { blob, watermarkLayout, footerPages, footerReasons } = await renderSealedPdf({
    file, pageSealResults, pagesWithText: plans.map(page => Boolean(page.text)), pageScalingStrategy,
  });
  const pageSealStrings = pageSealResults.map(result => result.seals);
  const firstResult = pageSealResults[0] ?? null;
  return {
    blob, sealResult: firstResult, stampedQrValues: firstResult?.seals ?? [],
    pageSealResults, pageSealStrings, flattenedFieldCount: prepared.flattenedFieldCount,
    watermarkLayout, footerPages, footerReasons,
    ocrPages: plans.flatMap((page, index) => page.ocr ? [{ pageNumber: index + 1, ...page.ocr }] : []),
  };
}

// Precompute all sensitive PDF work before the user initiates a provider login.
// No PDF, page text or keys are persisted or passed to any provider; these
// values live only in this browsing context's memory.
export async function prepareAccountPdfSeal({ file, bootstrapUrl = DEFAULT_BOOTSTRAP_URL,
  encodingStrategy = "automatic", pageScalingStrategy = "automatic", signal, onProgress }) {
  const prepared = await flattenPdfForSealing(file);
  const plan = await preparePageSealing({
    file: prepared.file, bootstrapUrl, encodingStrategy, attested: true, pageScalingStrategy, signal, onProgress,
  });
  return {
    pages: plan.pages,
    ocrPages: plan.ocrPages,
    async finish(attestations) {
      const { results, plans } = await plan.complete(attestations);
      return finishPdfSeal({
        file: prepared.file, prepared, pageSealResults: results, plans, pageScalingStrategy,
      });
    },
  };
}

export async function sealPdfInBrowser({ file, privateKey, publicKey, attestPages, bootstrapUrl = DEFAULT_BOOTSTRAP_URL, encodingStrategy = "automatic", pageScalingStrategy = "automatic", signal, onProgress, onReviewOcr }) {
  const prepared = await flattenPdfForSealing(file);
  file = prepared.file;
  const { results: pageSealResults, plans } = await createPageSealResults({ file, privateKey, publicKey, bootstrapUrl, encodingStrategy, attestPages, pageScalingStrategy, signal, onProgress, onReviewOcr });
  return finishPdfSeal({
    file, prepared, pageSealResults, plans, pageScalingStrategy,
  });
}
