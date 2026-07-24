import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

describe("frontend/test.html hex dump helper", () => {
  it("defines the hex dump formatter in the shared testAnalyzer module", () => {
    const analyzerPath = resolve(process.cwd(), "src/testAnalyzer.js");
    const analyzer = readFileSync(analyzerPath, "utf8");

    expect(analyzer).toContain("function formatHexDump(");
    // After refactor the hex line is `const hex = chunk.map((value)...` but variable is per-chunk array
    // Accept either naming pattern via hexRow or hex
    expect(
      analyzer.includes("const hex = chunk.map((value) => value.toString(16).padStart(2, \"0\")).join(\" \");") ||
      analyzer.includes("chunk.map((value) => value.toString(16).padStart(2,")
    ).toBe(true);
  });
});
