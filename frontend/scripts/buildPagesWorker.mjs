import { build } from "esbuild";
await build({ entryPoints: ["worker/index.js"], bundle: true, format: "esm", platform: "browser",
  target: "es2022", outfile: "build/_worker.js", minify: true });
