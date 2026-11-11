/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPhotoScanProgress, photoScanTiming } from "./photoScanProgress.js";
import { mountPhotoScanProgress } from "./mountPhotoScanProgress.js";

beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] }));
afterEach(() => vi.useRealTimers());

it("uses a real elapsed clock even when a decoder stage is silent", () => {
  const progress = createPhotoScanProgress(), changed = vi.fn();
  const unsubscribe = progress.subscribe(changed);
  const request = progress.begin("opening");
  expect(progress.getSnapshot()).toEqual({ label: "Opening photo on this device…", cameraCaptured: false, elapsedMs: 0, stepElapsedMs: 0 });
  vi.advanceTimersByTime(1000);
  request.phase("decoding");
  request.stage({ stage: "page-aligned", elapsedMs: 2600, private: "do not show" });
  vi.advanceTimersByTime(2500);
  expect(progress.getSnapshot()).toEqual({ label: "Checking page layouts…", cameraCaptured: false, elapsedMs: 3500, stepElapsedMs: 2500 });
  expect(photoScanTiming(progress.getSnapshot())).toBe("Elapsed 3.5 s · this step 2.5 s");
  request.stage({ stage: "page-aligned", elapsedMs: 5000 });
  request.stage({ stage: "private", elapsedMs: 5000 });
  request.phase("private");
  vi.advanceTimersByTime(500);
  expect(progress.getSnapshot().stepElapsedMs).toBe(3000);
  expect(JSON.stringify(progress.getSnapshot())).not.toContain("private");
  request.stop();
  expect(progress.getSnapshot()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  unsubscribe();
  expect(changed).toHaveBeenCalled();
});

it.each(["stop", "clear", "replacement"])("ignores queued stages and settlement after %s", reason => {
  const progress = createPhotoScanProgress(), old = progress.begin();
  if (reason === "stop") old.stop();
  if (reason === "clear") progress.clear();
  const current = progress.begin("opening");
  old.stage({ stage: "footer", elapsedMs: 500 });
  old.phase("capturing");
  old.stop();
  expect(progress.getSnapshot().label).toBe("Opening photo on this device…");
  vi.advanceTimersByTime(500);
  expect(progress.getSnapshot().elapsedMs).toBe(500);
  current.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("announces stages without announcing every clock tick or inventing percent complete", () => {
  const element = document.createElement("div"), progress = mountPhotoScanProgress(element);
  expect(element.hidden).toBe(true);
  const request = progress.begin();
  const status = element.querySelector('[role="status"]'), bar = element.querySelector("progress");
  expect(element.hidden).toBe(false);
  expect(status.textContent).toBe("Reading photo…");
  expect(bar.hasAttribute("value")).toBe(false);
  expect(bar.getAttribute("aria-label")).toBe("Photo seal scan");
  vi.advanceTimersByTime(1000);
  expect(status.textContent).toBe("Reading photo…");
  expect(element.querySelector('[role="timer"][aria-live="off"]').textContent).toContain("Elapsed 1.0 s");
  request.stage({ stage: "footer", elapsedMs: 800 });
  expect(status.textContent).toBe("Checking footer seals…");
  progress.dispose();
  request.stage({ stage: "general-qr", elapsedMs: 1000 });
  expect(element.hidden).toBe(true);
  expect(element.children).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the movement cue through decoder stages and clears it for a replacement file", () => {
  const notice = document.createElement("p");
  notice.scrollIntoView = vi.fn();
  const progress = mountPhotoScanProgress(document.createElement("div"), notice);
  const camera = progress.begin("capturing");
  expect(notice.textContent).toBe("");
  camera.phase("captured");
  expect(notice.textContent).toBe("Photo captured. You can move your phone.");
  const announcement = notice.firstChild;
  camera.stage({ stage: "footer", elapsedMs: 800 });
  vi.advanceTimersByTime(2500);
  expect(notice.firstChild).toBe(announcement);
  expect(notice.scrollIntoView).toHaveBeenCalledTimes(1);
  const file = progress.begin("opening");
  file.phase("decoding");
  camera.phase("captured");
  expect(notice.textContent).toBe("");
  progress.dispose();
});
