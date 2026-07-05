import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html mobile picker fallback", () => {
  it("checks for selected files when the browser regains focus after the picker closes", () => {
    const html = readFileSync(testHtmlPath, "utf8");

    expect(html).toContain("let awaitingFileSelection = false;");
    expect(html).toContain("fileInput.addEventListener('click', () => {");
    expect(html).toContain("window.addEventListener('focus', () => {");
    expect(html).toContain("document.addEventListener('visibilitychange', () => {");
    expect(html).toContain("if (awaitingFileSelection && fileInput.files.length) {");
    expect(html).toContain("handleSelectedFiles(fileInput.files, 'focus');");
    expect(html).toContain("handleSelectedFiles(fileInput.files, 'visibility');");
  });
});
