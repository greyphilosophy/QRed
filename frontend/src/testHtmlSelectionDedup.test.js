import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

describe("frontend/test.html duplicate selection guard", () => {
  it("deduplicates the same file selection when both input and change fire", () => {
    const analyzerPath = resolve(process.cwd(), "src/testAnalyzer.js");
    const analyzer = readFileSync(analyzerPath, "utf8");

    expect(analyzer).toContain("function fileSelectionKey(");
    expect(analyzer).toContain("activeSelectionKey");
    expect(analyzer).toContain("activeSelectionAt");
    expect(analyzer).toContain("if (selectionKey === activeSelectionKey && Date.now() - activeSelectionAt < 1500)");
    expect(analyzer).toContain("activeSelectionKey = selectionKey;");
    expect(analyzer).toContain("activeSelectionAt = Date.now();");
  });
});
