import { describe, expect, it } from "vitest";

describe("frontend/test.html plaintext seal display", () => {
  it("shows the original document text instead of the raw seal URL", async () => {
    const { chromium } = await import("/tmp/pwtest/node_modules/playwright");
    const browser = await chromium.launch({ headless: true, executablePath: "/snap/bin/chromium" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    await page.goto("file:///home/greyphilosophy/QRed/frontend/test.html?debugQRed=1", { waitUntil: "domcontentloaded", timeout: 60000 });

    const payload = "https://qred.org/#QRED1?v=1&alg=Ed25519&doc=DOC-PLAINTEXT&i=0&n=1&iss=QRed+Plaintext+QA&kid=deadbeef&ts=2026-07-05T00%3A00%3A00.000Z&txt=PDF+file%3A+plain.pdf%0ASize%3A+123+bytes%0ASHA-256%3A+deadbeef";
    const text = await page.evaluate((seal) => window.__qredStandaloneTestHooks.qredDisplayTextFromScannedPayload(seal), payload);

    expect(text).toBe("PDF file: plain.pdf\nSize: 123 bytes\nSHA-256: deadbeef");
    await browser.close();
  }, 30000);
});
