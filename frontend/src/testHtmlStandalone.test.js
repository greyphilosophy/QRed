import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html", () => {
  it("stays self-contained so the upload button works when opened as a static file", () => {
    const html = readFileSync(testHtmlPath, "utf8");

    expect(html).toContain("<label class=\"upload-zone\" id=\"uploadZone\" for=\"fileInput\">");
    expect(html).not.toContain("uploadZone.addEventListener('click', () => fileInput.click());");
  });
});
