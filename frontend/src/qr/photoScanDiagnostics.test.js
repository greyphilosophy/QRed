import { expect, it } from "vitest";
import { scanStageDiagnostic, scanStageFeedback } from "./photoScanDiagnostics.js";
import { photoScanTimeoutAction } from "./photoScanBudget.js";

it("keeps only an allowlisted stage and finite rounded duration", () => {
  const raw = { stage: "ordinary-qr", elapsedMs: 4123.6, text: "private text", pixels: [1, 2], deviceId: "private camera" };
  expect(scanStageDiagnostic(raw)).toEqual({ stage: "ordinary-qr", elapsedMs: 4124 });
  expect(scanStageFeedback(raw)).toBe(" Last reported step: reading conventional QR codes (4.1 s into decoding).");
});

it.each([null, {}, { stage: "private text", elapsedMs: 1 }, { stage: "constructor", elapsedMs: 1 },
  { stage: "footer", elapsedMs: NaN }, { stage: "footer", elapsedMs: Infinity },
  { stage: "footer", elapsedMs: -1 }, { stage: "footer", elapsedMs: 600001 },
  { stage: "footer", elapsedMs: "private" }])("ignores malformed or non-allowlisted stage metadata: %j", value => {
  expect(scanStageDiagnostic(value)).toBeNull();
  expect(scanStageFeedback(value)).toBe("");
});

it("retains partial chunks without claiming the last stage explains a timeout", () => {
  const partial = { status: "found-multiple", texts: ["partial seal"] };
  const result = photoScanTimeoutAction(partial, { stage: "page-aligned", elapsedMs: 6200, private: "private" });
  expect(result).toMatchObject({ ...partial, timedOut: true,
    scanDiagnostic: { stage: "page-aligned", elapsedMs: 6200 } });
  expect(result.message).toContain("Last reported step: checking page layouts (6.2 s into decoding).");
  expect(result.message).not.toContain("partial seal");
  expect(result.message).not.toContain("private");
  expect(partial).toEqual({ status: "found-multiple", texts: ["partial seal"] });
});
