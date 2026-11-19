import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import jpeg from "jpeg-js";
import { expect, it } from "vitest";
import { decodePhoto } from "./decodePhoto.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { paleWatermarkRegions, scanWatermarkRegions } from "./watermarkRegionScan.js";

const fixtures = "../tests/fixtures/workshop/";
const expected = JSON.parse(readFileSync(fixtures + "expected.json"));
const publicKey = readFileSync(fixtures + "demo-public-key.txt", "utf8").trim();
const digest = value => createHash("sha256").update(value).digest("hex");
const photo = name => jpeg.decode(readFileSync(`${fixtures}photos/${name}.jpg`), { useTArray: true });

it.each([["statement-1-straight", "statement-1"], ["lot-register-oblique", "lot-register"]])(
  "automatically locates and authenticates every seal in the unchanged %s photo", async (name, record) => {
    const image = photo(name), before = digest(image.data), stages = [], checkpoints = [];
    const result = decodePhoto(image, { returnPayload: true,
      onStage: ({ stage }) => stages.push(stage), onProgress: action => checkpoints.push(action.texts) });
    const seals = result.texts ?? (result.text ? [result.text] : []);
    expect(seals.map(digest).sort()).toEqual(expected[record].sealDigests);
    expect(stages).toContain("watermark-regions");
    expect(stages).not.toContain("general-qr");
    expect(checkpoints.at(-1)?.map(digest).sort()).toEqual(expected[record].sealDigests);
    expect(digest(image.data)).toBe(before);
    await expect(verifyQRedSeals(seals, publicKey)).resolves.toMatchObject({ status: "VALID",
      signature_valid: true, page_hash: expected[record].pageHash });
    await expect(verifyQRedSeals(seals, "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI"))
      .resolves.toMatchObject({ status: "INVALID" });
  }, 70_000);

it("finds the pale seal after moving its pixels away from the fixture's lower-page position", () => {
  const source = photo("statement-1-straight"), width = 1500, height = 1900;
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
  // Only this fixture construction knows the original location. The production
  // detector receives a normal image with the seal now in its upper-right area.
  for (let y = 0; y < 600; y++) {
    const at = ((1590 + y) * source.width + 435) * 4;
    image.data.set(source.data.subarray(at, at + 600 * 4), ((210 + y) * width + 760) * 4);
  }
  const seals = [];
  const results = scanWatermarkRegions(image, { onSeal: seal => seals.push(seal),
    shouldContinue: () => seals.length === 0 });
  expect(results.map(result => digest(result.seal))).toEqual(expected["statement-1"].sealDigests);
  const corner = results[0].code.location.topLeftCorner;
  expect(corner.x).toBeGreaterThan(760);
  expect(corner.y).toBeGreaterThan(210);
  expect(corner.y).toBeLessThan(300);
}, 15_000);

it("checkpoints a real quadrant and preserves it when the shared deadline stops later work", async () => {
  const seals = [];
  const results = scanWatermarkRegions(photo("lot-register-oblique"), {
    onSeal: seal => seals.push(seal), shouldContinue: () => seals.length === 0,
  });
  expect(seals).toHaveLength(1);
  expect(results.map(result => result.seal)).toEqual(seals);
  expect(expected["lot-register"].sealDigests).toContain(digest(seals[0]));
  await expect(verifyQRedSeals(seals, publicKey)).resolves.toMatchObject({ status: "INCOMPLETE" });
}, 15_000);

it("rejects blank/solid regions and stops candidate discovery at the shared deadline", () => {
  const image = { width: 640, height: 800, data: new Uint8ClampedArray(640 * 800 * 4).fill(255) };
  expect(paleWatermarkRegions(image)).toEqual([]);
  for (let y = 200; y < 600; y++) for (let x = 120; x < 520; x++) {
    const at = (y * 640 + x) * 4;
    image.data[at] = image.data[at + 1] = image.data[at + 2] = 220;
  }
  expect(paleWatermarkRegions(image)).toEqual([]);
  let checks = 0;
  expect(paleWatermarkRegions(image, { shouldContinue: () => ++checks < 4 })).toEqual([]);
  expect(checks).toBe(4);
  expect(scanWatermarkRegions(image, { shouldContinue: () => false })).toEqual([]);
});
