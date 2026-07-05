import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html script loading", () => {
  it("uses the local jsQR bundle instead of a CDN import", () => {
    const html = readFileSync(testHtmlPath, "utf8");

    expect(html).toContain("<script src=\"./jsQR.js\"></script>");
    expect(html).toContain("const jsQR = globalThis.jsQR || null;");
    expect(html).toContain("window.BarcodeDetector || globalThis.BarcodeDetector");
    expect(html).not.toContain("import('https://esm.sh/jsqr@1.4.0')");
  });
});
