import { Buffer } from "node:buffer";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { PDFDocument, rgb } from "pdf-lib";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";

import { qredQrPngDataUrl } from "./qredQr.js";
import { qredTextFromPhotoScanResult } from "./qredVerifier.js";

const USDA_DUMMY_PDF_URL = "https://www.rd.usda.gov/sites/default/files/pdf-sample_0.pdf";
const W3_DUMMY_PDF_URL = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";

async function fetchPdfBytes() {
  const candidates = [USDA_DUMMY_PDF_URL, W3_DUMMY_PDF_URL];
  const attempts = [];

  for (const url of candidates) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      attempts.push({ url, status: response.status });
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
        return { bytes, sourceUrl: url, attempts };
      }
    } catch (error) {
      attempts.push({ url, error: error.message });
    }
  }

  throw new Error(`Unable to download a usable PDF sample. Attempts: ${JSON.stringify(attempts)}`);
}

const hasPlaywright = existsSync("/tmp/pwtest/node_modules/playwright");

describe.skipIf(!hasPlaywright)("remote PDF sample end-to-end stamping", () => {
  it("stamps the sample PDF, screenshots it, and scans a QR that decodes to Dummy PDF File", async () => {
    const { chromium } = await import("/tmp/pwtest/node_modules/playwright");
    const { bytes: pdfBytes, sourceUrl } = await fetchPdfBytes();
    const pdf = await PDFDocument.load(pdfBytes);
    const firstPage = pdf.getPages()[0];

    const qrDataUrl = await qredQrPngDataUrl("Dummy PDF File");
    const qrBytes = Buffer.from(qrDataUrl.split(",")[1], "base64");
    const qrImage = await pdf.embedPng(qrBytes);

    firstPage.drawRectangle({ x: 24, y: 24, width: 280, height: 280, color: rgb(1, 1, 1) });
    firstPage.drawImage(qrImage, { x: 32, y: 32, width: 264, height: 264 });

    const stampedPdfBytes = await pdf.save();
    const stampedPdfPath = join(tmpdir(), `qred-remote-stamped-${Date.now()}.pdf`);
    const screenshotBase = join(tmpdir(), `qred-remote-stamped-${Date.now()}`);
    writeFileSync(stampedPdfPath, stampedPdfBytes);
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(stampedPdfBytes);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();

    const browser = await chromium.launch({ headless: true, executablePath: "/snap/bin/chromium" });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${port}/stamped.pdf`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${screenshotBase}.png`, fullPage: true });
    await browser.close();
    server.close();

    execFileSync("pdftoppm", ["-png", "-r", "240", "-singlefile", stampedPdfPath, screenshotBase]);
    const screenshotBytes = readFileSync(`${screenshotBase}.png`);
    const png = PNG.sync.read(screenshotBytes);
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: "attemptBoth" });

    expect(sourceUrl).toMatch(/rd\.usda\.gov|w3\.org/);
    expect(code, "QR code not detected in the screenshot").toBeTruthy();
    expect(code.data).toBe("QRED.ORG");
    expect(qredTextFromPhotoScanResult(new Uint8ClampedArray(png.data), png.width, png.height, code)).toBe("Dummy PDF File");
  }, 30000);
});
