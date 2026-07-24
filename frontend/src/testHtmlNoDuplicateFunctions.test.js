import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");
const lowLevelPath = resolve(process.cwd(), "src/qr/qrLowLevel.js");

describe("frontend/test.html script integrity", () => {
  it("does not declare the hidden payload helper twice and uses shared module", () => {
    const html = readFileSync(testHtmlPath, "utf8");
    const matches = html.match(/function extractHiddenQRedPayload\(/g) ?? [];
    expect(matches).toHaveLength(0);
    expect(html.length).toBeLessThan(12000);
    // shared low-level module exists
    const lowLevel = readFileSync(lowLevelPath, "utf8");
    expect(lowLevel).toContain("export function codewordsFromMatrix");
  });
});
