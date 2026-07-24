import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

describe("frontend/test.html mobile picker fallback", () => {
  it("checks for selected files when the browser regains focus after the picker closes", () => {
    const htmlPath = resolve(process.cwd(), "test.html");
    const analyzerPath = resolve(process.cwd(), "src/testAnalyzer.js");
    const html = readFileSync(htmlPath, "utf8");
    const analyzer = readFileSync(analyzerPath, "utf8");

    // Controller exposes awaitingFileSelection getter/setter — wiring happens in test.html shell
    expect(analyzer).toContain("awaitingFileSelection");
    expect(html).toContain("controller.awaitingFileSelection");
    expect(html).toContain("window.addEventListener('focus'");
    expect(html).toContain("document.addEventListener('visibilitychange'");
    expect(html).toContain("'focus'");
    expect(html).toContain("'visibility'");
  });
});
