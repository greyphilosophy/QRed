import { beforeEach, expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { chooseVersions, locatePaper, refineSingles, refineQuadrants } from "./pageAlignedScan.js";
import { recoverRefinedQrRegion } from "./pageAlignedRecovery.js";

vi.mock("./pageAlignedRecovery.js", () => ({ recoverRefinedQrRegion: vi.fn() }));
beforeEach(() => recoverRefinedQrRegion.mockReset().mockReturnValue(null));

function hypothesis(score) {
  return { mapping: (u, v) => ({ x: u * 0.97, y: v * 0.97 }),
    fullMapping: (u, v) => ({ x: u, y: v }),
    region: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    versions: [{ version: 28, score }, { version: 30, score: score - 0.02 }] };
}

it("reaches a close-scoring orientation before neighboring versions exhaust the retry budget", () => {
  const candidates = [hypothesis(0.73), hypothesis(0.725), hypothesis(0.72), hypothesis(0.71)];
  const recovered = { seal: "scheduler-test-result", code: { version: 28 } };
  recoverRefinedQrRegion.mockImplementation((_image, mapping, _region, version) =>
    mapping === candidates[2].mapping && version === 28 ? recovered : null);
  expect(refineSingles({}, candidates)).toEqual([recovered]);
  expect(recoverRefinedQrRegion.mock.calls.length).toBeLessThanOrEqual(16);
});

it("keeps a single 16-region limit across competing mappings and versions", () => {
  const candidates = Array.from({ length: 20 }, (_, i) => hypothesis(0.9 - i * 0.01));
  expect(refineSingles({}, candidates)).toEqual([]);
  expect(recoverRefinedQrRegion).toHaveBeenCalledTimes(16);
});

it("stops refinement between candidates when the photo deadline expires", () => {
  let checks = 0;
  expect(refineSingles({}, [hypothesis(0.9)], () => checks++ < 1)).toEqual([]);
  expect(recoverRefinedQrRegion).toHaveBeenCalledTimes(1);
});

it("finds mildly tinted paper on a patterned desk with two dark corners", () => {
  const width = 400, height = 520, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = x >= 35 && x <= 365 && y >= 30 && y <= 490;
    const rgb = inside ? (y < 110 ? [205, 190, 197] : [200, 200, 200])
      : y > 510 ? [15, 14, 17] : (Math.floor(x / 18) + Math.floor(y / 23)) % 2
        ? [150, 100, 180] : [60, 43, 67];
    data.set([...rgb, 255], (y * width + x) * 4);
  }
  const quad = locatePaper({ data, width, height });
  const expected = [[35, 30], [365, 30], [365, 490], [35, 490]];
  expect(quad).toHaveLength(4);
  quad.forEach((point, i) => {
    expect(Math.abs(point.x - expected[i][0])).toBeLessThan(3);
    expect(Math.abs(point.y - expected[i][1])).toBeLessThan(3);
  });
});

it("uses a visible version field to disambiguate nearby grid sizes, without requiring it", () => {
  const symbol = QRCode.create("QRed public version evidence ranking fixture", {
    version: 28, errorCorrectionLevel: "L",
  });
  const size = symbol.modules.size, cellX = 8, cellY = 12, margin = 60;
  const width = size * cellX + 2 * margin, height = size * cellY + 2 * margin;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const row = Math.floor((y - margin) / cellY), col = Math.floor((x - margin) / cellX);
    const inside = row >= 0 && col >= 0 && row < size && col < size;
    const gray = inside && symbol.modules.get(row, col) ? 205 : 245;
    const offset = (y * width + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = gray;
    data[offset + 3] = 255;
  }
  const image = { data, width, height }, region = { x: 0, y: 0, width: 1, height: 1 };
  // A plausible coarse placement error makes finder/timing evidence alone
  // favor v30, then v29. The printed BCH field still identifies v28.
  const mapping = (u, v) => ({
    x: margin + size * cellX * (0.5 + (u - 0.5) * 0.98) - 8,
    y: margin + size * cellY * (0.5 + (v - 0.5) * 0.98) + 12,
  });
  expect(chooseVersions(image, mapping, region)[0].version).toBe(28);

  // Cover both sampled fields with opaque ink. Missing evidence must not
  // count as matching BCH bits or exclude the old finder/timing fallback.
  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3), col = size - 11 + i % 3;
    for (const [r, c] of [[row, col], [col, row]]) {
      const p = mapping((c + 0.5) / size, (r + 0.5) / size);
      const offset = (Math.round(p.y) * width + Math.round(p.x)) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = 25;
    }
  }
  const obscured = chooseVersions(image, mapping, region);
  expect(obscured[0].version).not.toBe(28);
  expect(obscured.some(candidate => candidate.version === 28)).toBe(true);
});


it("checkpoints a refined quadrant before a later recovery attempt can block", () => {
  const onSeal = vi.fn();
  const recovered = { seal: "first-recovered-chunk", code: { version: 28 } };
  recoverRefinedQrRegion.mockReturnValueOnce(recovered).mockImplementationOnce(() => {
    expect(onSeal).toHaveBeenCalledWith(recovered.seal);
    throw new Error("terminated during next quadrant");
  });
  const quadrants = [{ mapping: (x, y) => ({ x, y }),
    regions: Array.from({ length: 4 }, () => ({ x: 0, y: 0, width: 0.5, height: 0.5 })),
    versions: Array.from({ length: 4 }, () => [{ version: 28, score: 0.8 }]), codes: [] }];
  expect(() => refineQuadrants({}, quadrants, [], () => true, onSeal)).toThrow("terminated");
  expect(onSeal).toHaveBeenCalledTimes(1);
});
