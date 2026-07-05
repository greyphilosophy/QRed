import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html duplicate selection guard", () => {
  it("deduplicates the same file selection when both input and change fire", () => {
    const html = readFileSync(testHtmlPath, "utf8");

    expect(html).toContain("function fileSelectionKey(files) {");
    expect(html).toContain("let activeSelectionKey = null;");
    expect(html).toContain("let activeSelectionAt = 0;");
    expect(html).toContain("if (selectionKey === activeSelectionKey && Date.now() - activeSelectionAt < 1500) {");
    expect(html).toContain("activeSelectionKey = selectionKey;");
    expect(html).toContain("activeSelectionAt = Date.now();");
  });
});
