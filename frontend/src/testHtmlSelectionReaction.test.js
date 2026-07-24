import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

describe("frontend/test.html selection reaction", () => {
  it("yields after showing the selected-file status before decoding starts", () => {
    const analyzerPath = resolve(process.cwd(), "src/testAnalyzer.js");
    const analyzer = readFileSync(analyzerPath, "utf8");

    expect(analyzer).toContain("async function handleSelectedFiles(");
    expect(analyzer).toContain("async function processFiles(");
    const handleStart = analyzer.indexOf("async function handleSelectedFiles(");
    const processStart = analyzer.indexOf("async function processFiles(");
    const handleBlock = analyzer.slice(handleStart, processStart);

    expect(handleBlock).toContain("setUploadStatus(");
    expect(handleBlock).toContain("await new Promise((resolve) => setTimeout(resolve, 0));");
  });
});
