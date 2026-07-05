import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html script integrity", () => {
  it("does not declare the hidden payload helper twice", () => {
    const html = readFileSync(testHtmlPath, "utf8");
    const matches = html.match(/function extractHiddenQRedPayload\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
