import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html", () => {
  it("stays self-contained so the upload button works when opened as a static file", () => {
    const html = readFileSync(testHtmlPath, "utf8");

    expect(html).not.toContain("import { qredTextFromPhotoScanResult } from './src/qredVerifier.js';");
    expect(html).toContain("function qredTextFromPhotoScanResult(");
    expect(html).toContain("function qredTextFromScanResult(");
    expect(html).toContain("return extractHiddenQRedPayloadFromImage(");
  });
});
