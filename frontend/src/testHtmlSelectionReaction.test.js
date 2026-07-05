import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html selection reaction", () => {
  it("yields after showing the selected-file status before decoding starts", () => {
    const html = readFileSync(testHtmlPath, "utf8");
    const handleStart = html.indexOf("async function handleSelectedFiles(files, source = 'change') {");
    const processStart = html.indexOf("async function processFiles(files, source = 'change') {");
    const handleBlock = html.slice(handleStart, processStart);

    expect(handleBlock).toContain("setUploadStatus(");
    expect(handleBlock).toContain("await new Promise((resolve) => setTimeout(resolve, 0));");
    expect(handleBlock).toContain("await processFiles(fileArray, source);");
  });
});
