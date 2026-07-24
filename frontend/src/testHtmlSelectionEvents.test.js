import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

describe("frontend/test.html file selection events", () => {
  it("handles both input and change events so Android Chrome shows a selection reaction", () => {
    const htmlPath = resolve(process.cwd(), "test.html");
    const analyzerPath = resolve(process.cwd(), "src/testAnalyzer.js");
    const html = readFileSync(htmlPath, "utf8");
    const analyzer = readFileSync(analyzerPath, "utf8");

    // handleSelectedFiles lives on controller; html wires both 'input' and 'change'
    expect(analyzer).toContain("async function handleSelectedFiles(");
    expect(html).toContain("fileInput.addEventListener('input'");
    expect(html).toContain("fileInput.addEventListener('change'");
    // Both events call handleSelectedFiles via bind indirection
    expect(html).toContain("handleSelectedFiles");
    expect(html).toContain("'input'");
    expect(html).toContain("'change'");
  });
});
