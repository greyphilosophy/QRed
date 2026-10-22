import { cp, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const target = fileURLToPath(new URL("../public/ocr/v1/", import.meta.url));
await mkdir(target, { recursive: true });
const engine = dirname(require.resolve("tesseract.js/package.json"));
const core = dirname(require.resolve("tesseract.js-core/package.json"));
const english = dirname(require.resolve("@tesseract.js-data/eng/package.json"));
// A dependency change must also change the immutable public cache namespace.
for (const [name, expected] of [["tesseract.js", "6.0.1"], ["tesseract.js-core", "6.1.2"], ["@tesseract.js-data/eng", "1.0.0"]]) {
  if (require(`${name}/package.json`).version !== expected) throw new Error(`Update the OCR asset version before changing ${name}.`);
}
await cp(join(engine, "dist/worker.min.js"), join(target, "worker.min.js"));
for (const variant of ["", "-simd", "-lstm", "-simd-lstm"]) {
  const file = `tesseract-core${variant}.wasm.js`;
  await cp(join(core, file), join(target, file));
}
await cp(join(english, "4.0.0_best_int/eng.traineddata.gz"), join(target, "eng.traineddata.gz"));
await cp(join(engine, "LICENSE.md"), join(target, "LICENSE-tesseract.txt"));
await cp(join(core, "LICENSE"), join(target, "LICENSE-core.txt"));
await cp(join(english, "package.json"), join(target, "english-package.json"));
await writeFile(join(target, "NOTICE.txt"), "OCR: Tesseract.js 6.0.1 and tesseract.js-core 6.1.2 (Apache-2.0).\nEnglish model: @tesseract.js-data/eng 1.0.0, 4.0.0_best_int.\nhttps://github.com/naptha/tessdata\nhttps://github.com/tesseract-ocr/tessdata_best (Apache-2.0)\nSee LICENSE-core.txt and english-package.json.\n");
