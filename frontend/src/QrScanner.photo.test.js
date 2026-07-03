import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import process from "node:process";
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { qrScanAction } from "./QrScanner.jsx";

const DEFAULT_PHOTO_FIXTURE = "src/__fixtures__/qred-scanner-photo.jpg";
const photoFixturePath = resolve(process.cwd(), process.env.QRED_SCANNER_PHOTO || DEFAULT_PHOTO_FIXTURE);
const runWithPhotoFixture = existsSync(photoFixturePath) ? it : it.skip;

function decodePhoto(path) {
  const bytes = readFileSync(path);
  const extension = extname(path).toLowerCase();
  if (extension === ".png") {
    const png = PNG.sync.read(bytes);
    return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  }
  if ([".jpg", ".jpeg"].includes(extension)) {
    const jpg = jpeg.decode(bytes, { useTArray: true });
    return { data: new Uint8ClampedArray(jpg.data), width: jpg.width, height: jpg.height };
  }
  throw new Error(`Unsupported scanner photo fixture extension: ${extension}`);
}

describe("QrScanner real photo fixture", () => {
  runWithPhotoFixture("runs a real photographed QRed seal through the same jsQR and QRed scan decision path", () => {
    const image = decodePhoto(photoFixturePath);
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
    const scanAction = qrScanAction(image.data, image.width, image.height, code);

    expect(code, `jsQR did not detect a QR code in ${photoFixturePath}`).toBeTruthy();
    expect(scanAction, `QRed scanner did not recover a hidden payload from ${photoFixturePath}`).toMatchObject({ status: "found" });
  });
});
