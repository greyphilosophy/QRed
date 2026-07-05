import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html version footer", () => {
  it("shows a visible version number in the footer", () => {
    const html = readFileSync(testHtmlPath, "utf8");

    expect(html).toContain("<footer>QRed — Tamper-Evident Document Sealing <span class=\"app-version\" id=\"appVersion\">v1.0.10</span></footer>");
    expect(html).toContain(".app-version {");
  });
});
