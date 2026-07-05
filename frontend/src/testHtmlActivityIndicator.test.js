import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html upload activity indicator", () => {
  it("adds a visible scanning state while the selected image is being processed", () => {
    const html = readFileSync(testHtmlPath, "utf8");

    expect(html).toContain(".upload-zone.scanning {");
    expect(html).toContain(".upload-zone.scanning .upload-button {");
    expect(html).toContain("uploadZone.classList.toggle('scanning', tone === 'loading');");
    expect(html).toContain("setUploadStatus(`Scanning ${fileArray.length} photo");
    expect(html).toContain("setUploadStatus(`Done scanning ${fileArray.length} photo");
  });
});
