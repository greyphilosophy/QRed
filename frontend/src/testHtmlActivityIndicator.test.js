import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

describe("frontend/test.html upload activity indicator", () => {
  it("adds a visible scanning state while the selected image is being processed", () => {
    const analyzerPath = resolve(process.cwd(), "src/testAnalyzer.js");
    const htmlPath = resolve(process.cwd(), "test.html");
    const analyzer = readFileSync(analyzerPath, "utf8");
    const html = readFileSync(htmlPath, "utf8");
    const combined = html + analyzer;

    // Scanning CSS lives in test.html + state toggling via classList.toggle lives in analyzer
    expect(combined).toContain(".upload-zone.scanning");
    expect(analyzer).toContain("uploadZone.classList.toggle");
    expect(analyzer).toContain("setUploadStatus(`Scanning ${fileArray.length} photo");
    expect(analyzer).toContain("setUploadStatus(`Done scanning ${fileArray.length} photo");
  });
});
