import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

describe("frontend/test.html script loading", () => {
  it("uses npm jsqr via Vite import, not a vendored bundle", () => {
    const htmlPath = resolve(process.cwd(), "test.html");
    const analyzerPath = resolve(process.cwd(), "src/testAnalyzer.js");
    const html = readFileSync(htmlPath, "utf8");
    const analyzer = readFileSync(analyzerPath, "utf8");

    expect(html).not.toContain('<script src="./jsQR.js"></script>');
    expect(html).toContain('from "./src/testAnalyzer.js"');
    expect(analyzer).toContain('from "jsqr"');
    expect(existsSync(resolve(process.cwd(), "jsQR.js"))).toBe(false);
  });
});
