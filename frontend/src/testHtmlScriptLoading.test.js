import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html script loading", () => {
  it("keeps file selection working even if the jsQR CDN import fails", () => {
    const html = readFileSync(testHtmlPath, "utf8");

    expect(html).toContain("let jsQR = null;");
    expect(html).toContain("async function loadJsQR() {");
    expect(html).toContain("import('https://esm.sh/jsqr@1.4.0')");
    expect(html).toContain("window.BarcodeDetector || globalThis.BarcodeDetector");
    expect(html).not.toContain("import jsQR from 'https://esm.sh/jsqr@1.4.0';");
  });
});
