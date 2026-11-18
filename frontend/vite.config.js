import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";

// Cloudflare/GitHub builds expose the source revision; local builds use Git.
let buildId = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA;
if (!buildId) {
  try { buildId = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { buildId = null; }
}

export default defineConfig({
  plugins: [react()],
  define: { "import.meta.env.QRED_BUILD_ID": JSON.stringify(buildId) },
  // Rendered PDF/QR tests are CPU-heavy; avoid oversubscribing small CI runners.
  test: { minWorkers: 1, maxWorkers: 2 },
  server: {
    port: 3000,
  },
  build: {
    outDir: "build",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        verifier: resolve(__dirname, "verifier.html"),
        test: resolve(__dirname, "test.html"),
      },
    },
  },
});
