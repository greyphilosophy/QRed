import { createHash } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { createQRedSeals } from "../qredSealer.js";
import { createQRedQrSymbol } from "../qredQr.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { qredPayloadFromScanResult } from "./qrPayload.js";
import { decodePhoto } from "./decodePhoto.js";
import { footerQrRegions, scanFooterSeals } from "./footerSealScan.js";

const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
const content = "Generated footer region regression. ".repeat(160).trimEnd();
let seals, image;
beforeAll(async () => {
  ({ seals } = await createQRedSeals({ content, publicKey,
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes",
    timestamp: "2026-11-03T12:00:00Z", encodingStrategy: "plaintext", preferFourQrPage: true,
    pageContext: { pageNumber: 1, pageCount: 1 } }));
  expect(seals).toHaveLength(4);
  const symbols = seals.map(createQRedQrSymbol), pitch = 3;
  const cell = Math.max(...symbols.map(symbol => symbol.modules.size)) * pitch + 80;
  const width = cell * 2 + 100, height = cell * 2 + 100;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  symbols.forEach(({ modules }, index) => {
    const left = 50 + index % 2 * cell, top = 50 + Math.floor(index / 2) * cell;
    for (let row = 0; row < modules.size; row++) for (let col = 0; col < modules.size; col++) {
      if (!modules.get(row, col)) continue;
      for (let dy = 0; dy < pitch; dy++) for (let dx = 0; dx < pitch; dx++) {
        const i = ((top + row * pitch + dy) * width + left + col * pitch + dx) * 4;
        data[i] = data[i + 1] = data[i + 2] = 20;
      }
    }
  });
  image = { data, width, height };
});

it("isolates adjacent symbols, preserves original pixels and requires normal signatures", async () => {
  const hash = () => createHash("sha256").update(image.data).digest("hex");
  const before = hash();
  const codes = scanFooterSeals(image);
  const recovered = codes.map(qredPayloadFromScanResult);
  expect(recovered.sort()).toEqual([...seals].sort());
  const action = decodePhoto(image, { returnPayload: true });
  expect(action.status).toBe("found-multiple");
  expect([...action.texts].sort()).toEqual([...seals].sort());
  expect(hash()).toBe(before);
  await expect(verifyQRedSeals(recovered, publicKey)).resolves.toMatchObject({ status: "VALID", content });
  await expect(verifyQRedSeals(recovered, "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI"))
    .resolves.toMatchObject({ status: "INVALID" });
  for (const code of codes) {
    expect(code.location.topLeftCorner.x).toBeGreaterThan(40);
    expect(code.location.topLeftCorner.y).toBeGreaterThan(40);
  }
});

it("stops preprocessing when the shared deadline expires", () => {
  let checks = 0;
  expect(footerQrRegions(image, { shouldContinue: () => ++checks < 4 })).toEqual([]);
  expect(checks).toBe(4);
  expect(scanFooterSeals(image, { shouldContinue: () => false })).toEqual([]);
});

it("does not treat a dark background or blank page as a footer symbol", () => {
  const blank = { width: 800, height: 800, data: new Uint8ClampedArray(800 * 800 * 4) };
  expect(footerQrRegions(blank)).toEqual([]);
  blank.data.fill(255);
  expect(scanFooterSeals(blank)).toEqual([]);
});

it("caps a dense page at eight candidates", () => {
  const width = 1200, height = 1200, data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let i = 0; i < 12; i++) {
    const left = 50 + i % 4 * 280, top = 50 + Math.floor(i / 4) * 280;
    for (let y = top; y < top + 100; y++) for (let x = left; x < left + 100; x++) {
      const at = (y * width + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = 0;
    }
  }
  expect(footerQrRegions({ data, width, height })).toHaveLength(8);
});

it("can stop while copying a candidate without decoding it", () => {
  let discoveryChecks = 0;
  footerQrRegions(image, { shouldContinue: () => { discoveryChecks++; return true; } });
  let checks = 0;
  expect(scanFooterSeals(image, { shouldContinue: () => ++checks < discoveryChecks + 5 })).toEqual([]);
  expect(checks).toBe(discoveryChecks + 5);
});
