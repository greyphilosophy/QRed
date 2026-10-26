import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const output = resolve(process.argv[2] || "/tmp/qred-adaptive-gray");
const python = process.env.QRED_EXPERIMENT_PYTHON || "python3";
mkdirSync(output, { recursive: true });
for (const [source, destination] of [["carrier.mjs", "carrier.cjs"], ["adaptive_reader.mjs", "adaptive.cjs"]]) {
  await build({ entryPoints: [resolve(here, source)], outfile: resolve(output, destination),
    bundle: true, format: "cjs", platform: "node", target: "node24", logLevel: "warning" });
}
execFileSync(process.execPath, [resolve(output, "carrier.cjs"), "prepare", output], { stdio: "inherit" });
execFileSync(python, [resolve(here, "render_adaptive.py"), output], { stdio: "inherit" });
execFileSync(process.execPath, [resolve(output, "adaptive.cjs"), output, createRequire(import.meta.url).resolve("jsqr")], { stdio: "inherit" });
