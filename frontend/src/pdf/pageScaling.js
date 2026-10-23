import { degrees, PDFName } from "pdf-lib";

const LETTER_PAGE_WIDTH = 612;
const LETTER_PAGE_HEIGHT = 792;
export const LEGAL_PAGE_HEIGHT = 1008;
export const LEGAL_FOOTER_HEIGHT = 216;

export function isLetterSizedPage(width, height) {
  return Math.abs(width - LETTER_PAGE_WIDTH) <= 2 && Math.abs(height - LETTER_PAGE_HEIGHT) <= 2;
}

export function resolvePageScalingStrategy(strategy, width, height) {
  if (strategy !== "automatic") return strategy;
  return isLetterSizedPage(width, height) ? "legal-footer" : "shrink-footer";
}

export function visiblePageGeometry(page) {
  const media = page.getMediaBox(), crop = page.getCropBox();
  let left = Math.max(media.x, crop.x), bottom = Math.max(media.y, crop.y);
  let right = Math.min(media.x + media.width, crop.x + crop.width), top = Math.min(media.y + media.height, crop.y + crop.height);
  if (right <= left || top <= bottom) { left = media.x; bottom = media.y; right = media.x + media.width; top = media.y + media.height; }
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const unit = page.node.lookup(PDFName.of("UserUnit"))?.asNumber?.() || 1;
  const sourceWidth = (right - left) * unit, sourceHeight = (top - bottom) * unit;
  return { width: rotation % 180 ? sourceHeight : sourceWidth, height: rotation % 180 ? sourceWidth : sourceHeight,
    sourceWidth, sourceHeight, rotation, bounds: { left, bottom, right, top } };
}

export async function applyPageScaling(pdf, pageIndex, page, resolvedStrategy, footerHeight) {
  if (!["legal-footer", "shrink-footer"].includes(resolvedStrategy)) return page;
  const geometry = visiblePageGeometry(page);
  const { width, height, rotation, sourceWidth, sourceHeight, bounds } = geometry;
  const scale = resolvedStrategy === "shrink-footer" ? (height - footerHeight) / height : 1;
  if (scale <= 0) throw new Error("PDF page is too short to shrink for the selected seal footer");
  // A blank page may have no Contents stream, which pdf-lib cannot embed.
  const embedded = page.node.Contents() ? await pdf.embedPage(page, bounds) : null;
  const replacement = pdf.insertPage(pageIndex + 1, [width, resolvedStrategy === "legal-footer" ? height + footerHeight : height]);
  if (embedded) {
    const x = rotation === 180 || rotation === 270 ? width * scale : 0;
    const y = footerHeight + (rotation === 90 || rotation === 180 ? height * scale : 0);
    replacement.drawPage(embedded, { x, y, width: sourceWidth * scale, height: sourceHeight * scale, rotate: degrees(-rotation) });
  }
  pdf.removePage(pageIndex);
  return replacement;
}
