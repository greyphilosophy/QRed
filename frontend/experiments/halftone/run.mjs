import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const output = resolve(process.argv[2] || "/tmp/qred-halftone");
const python = process.env.QRED_EXPERIMENT_PYTHON || "python3";
mkdirSync(output, { recursive: true });
const compiled = resolve(output, "carrier.cjs");
await build({ entryPoints: [resolve(here, "carrier.mjs")], outfile: compiled,
  bundle: true, format: "cjs", platform: "node", target: "node24", logLevel: "warning" });
execFileSync(process.execPath, [compiled, "prepare", output], { stdio: "inherit" });
execFileSync(python, [resolve(here, "render.py"), output], { stdio: "inherit" });
execFileSync(process.execPath, [compiled, "scan", output], { stdio: "inherit" });
