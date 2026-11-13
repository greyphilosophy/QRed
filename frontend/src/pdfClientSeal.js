import { createQRedSeals, DEFAULT_BOOTSTRAP_URL } from "./qredSealer.js";
import { MAX_CHUNKS } from "./sealFormat.js";
import { MAX_PDF_SEALS } from "./sealBudget.js";
import { DEFAULT_PAGE_LAYOUT, LEGAL_FOOTER_HEIGHT, LEGAL_PAGE_HEIGHT } from "./pdf/pageScaling.js";
import { QR_SIZE, planQrStampLayout, planQrStampLayoutForFooterBand } from "./pdf/qrLayout.js";
import { planPageEvidence } from "./pdf/pageEvidencePlan.js";
import { flattenPdfForSealing } from "./pdf/flattenPdf.js";
import { renderSealedPdf } from "./pdf/renderSealedPdf.js";
import { usesSealSheets, usesWatermarks } from "./pdf/sealSheets.js";
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

async function preparePageSealing({ file, privateKey, publicKey, bootstrapUrl, encodingStrategy, attested, pageScalingStrategy, signal }) {
  const { readPdfPagesWithEvidence } = await import("./pdf/readPdfText.js");
  const maxPageSeals = usesSealSheets(pageScalingStrategy) ? MAX_CHUNKS : MAX_PDF_SEALS;
  const plans = await readPdfPagesWithEvidence(file, page => planPageEvidence(page, {
    attested, multiple: page.pageCount > 1, encodingStrategy, maxPageSeals,
  }), { signal });
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
    async complete(attestations = null) {
      if (attested && (!Array.isArray(attestations) || attestations.length !== plans.length)) {
        throw new Error("Missing page attestations");
      }
      const results = await Promise.all(plans.map(async (page, index) => createQRedSeals({
        content: page.text, pageEvidence: page.pageEvidence, privateKey, publicKey,
        bootstrapUrl, encodingStrategy, timestamp, pageContext: contexts[index],
        // Only watermark-eligible text pages need the one-or-four split.
        preferFourQrPage: page.hasPdfText && usesWatermarks(pageScalingStrategy),
        maxPageSeals,
        attestation: attestations?.[index],
      })));
      return { results, plans };
    },
  };
}

async function createPageSealResults({ file, privateKey, publicKey, bootstrapUrl, encodingStrategy, attestPages, pageScalingStrategy, signal }) {
  const prepared = await preparePageSealing({
    file, privateKey, publicKey, bootstrapUrl, encodingStrategy, attested: Boolean(attestPages), pageScalingStrategy, signal,
  });
  const attestations = attestPages ? await attestPages(prepared.pages) : null;
  return prepared.complete(attestations);
}

async function finishPdfSeal({ file, prepared, pageSealResults, plans, pageScalingStrategy }) {
  // For seal sheets, sign the validated snapshot of form appearances but keep
  // the original pages and their live fields in the delivered document.
  const originalPages = usesSealSheets(pageScalingStrategy);
  const placement = await renderSealedPdf({
    file: originalPages ? file : prepared.file, pageSealResults, pagesWithText: plans.map(page => page.hasPdfText), pageScalingStrategy,
  });
  const pageSealStrings = placement.pageSealStrings ?? pageSealResults.map(result => result.seals);
  const printedResults = pageSealResults.map((result, index) => ({ ...result, seals: pageSealStrings[index] }));
  const firstResult = printedResults[0] ?? null;
  return {
    ...placement, ocrUnavailablePages: plans.filter(page => page.ocrUnavailable).map(page => page.pageNumber),
    sealResult: firstResult, stampedQrValues: firstResult?.seals ?? [],
    pageSealResults: printedResults, pageSealStrings, flattenedFieldCount: originalPages ? 0 : prepared.flattenedFieldCount,
  };
}

// Precompute all sensitive PDF work before the user initiates a provider login.
// No PDF, page text or keys are persisted or passed to any provider; these
// values live only in this browsing context's memory.
export async function prepareAccountPdfSeal({ file, bootstrapUrl = DEFAULT_BOOTSTRAP_URL,
  encodingStrategy = "automatic", pageScalingStrategy = DEFAULT_PAGE_LAYOUT, signal }) {
  const prepared = await flattenPdfForSealing(file);
  const plan = await preparePageSealing({
    file: prepared.file, bootstrapUrl, encodingStrategy, attested: true, pageScalingStrategy, signal,
  });
  return {
    pages: plan.pages,
    async finish(attestations) {
      const { results, plans } = await plan.complete(attestations);
      return finishPdfSeal({
        file, prepared, pageSealResults: results, plans, pageScalingStrategy,
      });
    },
  };
}

export async function sealPdfInBrowser({ file, privateKey, publicKey, attestPages, bootstrapUrl = DEFAULT_BOOTSTRAP_URL, encodingStrategy = "automatic", pageScalingStrategy = DEFAULT_PAGE_LAYOUT, signal }) {
  const prepared = await flattenPdfForSealing(file);
  const { results: pageSealResults, plans } = await createPageSealResults({ file: prepared.file, privateKey, publicKey, bootstrapUrl, encodingStrategy, attestPages, pageScalingStrategy, signal });
  return finishPdfSeal({
    file, prepared, pageSealResults, plans, pageScalingStrategy,
  });
}
