import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html responsiveness", () => {
  it("shows an immediate upload status when a photo is selected", () => {
    const html = readFileSync(testHtmlPath, "utf8");

    expect(html).toContain("<p class=\"upload-status ready\" id=\"uploadStatus\">Ready to scan</p>");
    expect(html).toContain("setUploadStatus(`Selected ${e.target.files.length} photo");
    expect(html).toContain("setUploadStatus(`Scanning photo ${index + 1} of ${fileArray.length}…`, 'loading');");
    expect(html).toContain("setUploadStatus(`Done scanning ${fileArray.length} photo");
  });
});
