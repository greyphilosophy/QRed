
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

export async function applyPageScaling(pdf, pageIndex, page, resolvedStrategy, footerHeight) {
  const { width, height } = page.getSize();

  if (resolvedStrategy === "legal-footer") {
    const embeddedPage = await pdf.embedPage(page);
    const replacementPage = pdf.insertPage(pageIndex + 1, [width, height + footerHeight]);
    replacementPage.drawPage(embeddedPage, { x: 0, y: footerHeight, width, height });
    pdf.removePage(pageIndex);
    return replacementPage;
  }

  if (resolvedStrategy === "shrink-footer") {
    const availableContentHeight = height - footerHeight;
    if (availableContentHeight <= 0) {
      throw new Error("PDF page is too short to shrink for the selected seal footer");
    }
    const scale = availableContentHeight / height;
    const embeddedPage = await pdf.embedPage(page);
    const replacementPage = pdf.insertPage(pageIndex + 1, [width, height]);
    replacementPage.drawPage(embeddedPage, { x: 0, y: footerHeight, width: width * scale, height: height * scale });
    pdf.removePage(pageIndex);
    return replacementPage;
  }

  return page;
}
