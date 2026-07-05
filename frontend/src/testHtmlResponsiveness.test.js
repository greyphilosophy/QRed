import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html responsiveness", () => {
  it("shows an immediate upload status when a photo is selected", () => {
    const html = readFileSync(testHtmlPath, "utf8");

    expect(html).toContain("<p class=\"upload-status ready\" id=\"uploadStatus\">Ready to scan</p>");
    expect(html).toContain("function handleSelectedFiles(files, source = 'change') {");
    expect(html).toContain("setUploadStatus(\n    source === 'click'");
    expect(html).toContain("fileInput.addEventListener('input', (e) => {");
    expect(html).toContain("fileInput.addEventListener('change', (e) => {");
    expect(html).toContain("handleSelectedFiles(e.target.files, 'input');");
    expect(html).toContain("handleSelectedFiles(e.target.files, 'change');");
    expect(html).toContain("setUploadStatus(`Scanning photo ${index + 1} of ${fileArray.length}…`, 'loading');");
    expect(html).toContain("await new Promise((resolve) => setTimeout(resolve, 0));");
    expect(html).toContain("setUploadStatus(`Done scanning ${fileArray.length} photo");
  });
});
