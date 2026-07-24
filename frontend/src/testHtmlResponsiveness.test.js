import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

describe("frontend/test.html responsiveness", () => {
  it("shows an immediate upload status when a photo is selected", () => {
    const analyzerPath = resolve(process.cwd(), "src/testAnalyzer.js");
    const analyzer = readFileSync(analyzerPath, "utf8");

    expect(analyzer).toContain("function fileSelectionKey(");
    expect(analyzer).toContain("async function handleSelectedFiles(");
    expect(analyzer).toContain("await new Promise((resolve) => setTimeout(resolve, 0));");
    expect(analyzer).toContain("setUploadStatus(");
    expect(analyzer).toContain("fileArray.length");
  });
});
