import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html file selection events", () => {
  it("handles both input and change events so Android Chrome shows a selection reaction", () => {
    const html = readFileSync(testHtmlPath, "utf8");

    expect(html).toContain("function handleSelectedFiles(files, source = 'change') {");
    expect(html).toContain("fileInput.addEventListener('input', (e) => {");
    expect(html).toContain("fileInput.addEventListener('change', (e) => {");
    expect(html).toContain("handleSelectedFiles(e.target.files, 'input');");
    expect(html).toContain("handleSelectedFiles(e.target.files, 'change');");
  });
});
