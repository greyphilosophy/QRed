import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const testHtmlPath = resolve(process.cwd(), "test.html");

describe("frontend/test.html responsiveness", () => {
  it("does not block the upload path on requestAnimationFrame before decoding the selected photo", () => {
    const html = readFileSync(testHtmlPath, "utf8");

    expect(html).not.toContain("await new Promise((resolve) => requestAnimationFrame(resolve));");
  });
});
