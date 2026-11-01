import { beforeEach, expect, it, vi } from "vitest";
import { refineSingles } from "./pageAlignedScan.js";
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
