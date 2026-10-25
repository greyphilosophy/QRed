import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
