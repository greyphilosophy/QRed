import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html hex dump helper", () => {
  it("defines the hex dump formatter used by the QR result card", () => {
    const html = readFileSync(testHtmlPath, "utf8");
    expect(html).toContain("function formatHexDump(bytes, start = 0, length = bytes?.length ?? 0) {");
    expect(html).toContain("const hex = chunk.map((value) => value.toString(16).padStart(2, '0')).join(' ');");
  });
});
