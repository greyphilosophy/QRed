/* @vitest-environment node */

import { describe, it, expect, vi } from "vitest";

describe("frontend/src/verifier/ocrAr.js environment guards", () => {
  it("imports without throwing when navigator is not defined", async () => {
    // Ensure we're exercising the true “node/no navigator binding” case.
    const hadNavigator = Object.prototype.hasOwnProperty.call(globalThis, "navigator");
    const prevNavigator = globalThis.navigator;

    try {
      vi.resetModules();
      // Remove any navigator property/binding so `navigator` identifier lookup
      // behaves like it is undefined/not declared.
      if (hadNavigator) {
        delete globalThis.navigator;
      } else {
        // nothing to delete; ensure it's not present
        // (assignment could create a binding that masks the original bug)
      }

      await expect(import("./ocrAr.js")).resolves.toHaveProperty("captureDocumentFrameForOcr");
    } finally {
      // Restore original state to avoid polluting other tests.
      if (hadNavigator) {
        globalThis.navigator = prevNavigator;
      }
    }
  });
});
