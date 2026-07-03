import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readJson(path) {
  return JSON.parse(readFileSync(resolve(__dirname, path), "utf8"));
}

describe("Cloudflare Pages build wiring", () => {
  it("copies the Worker into the Pages output directory", () => {
    const frontendPackage = readJson("../package.json");

    expect(frontendPackage.scripts["build:pages"]).toBe("npm run build && cp worker/index.js build/_worker.js");
  });

  it("uses the Pages-ready build from repository-root scripts", () => {
    const rootPackage = readJson("../../package.json");

    expect(rootPackage.scripts.build).toBe("cd frontend && npm ci && npm run build:pages");
    expect(rootPackage.scripts["build:worker"]).toBe("cd frontend && npm ci && npm run build:pages");
  });
});
