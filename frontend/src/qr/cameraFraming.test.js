import { afterEach, expect, it } from "vitest";
import { cameraZoomRange, rememberCameraZoom } from "./cameraFraming.js";
import { forgetPreferredCamera, preferredCameraId } from "./cameraPreference.js";
import { cameraQualityPreferences } from "./cameraControls.js";

const trackFor = (label, deviceId) => ({ label, getSettings: () => ({ deviceId }) });
afterEach(() => forgetPreferredCamera(preferredCameraId()));

it("uses the phone's 1× setting on a combined rear camera and the reciprocal on a labeled physical lens", () => {
  const track = trackFor("Back 0.6×", "combined-or-physical");
  expect(cameraZoomRange(track, { min: 0.6, max: 8, step: 0.1 })).toEqual({
    preferred: 1, choices: [{ value: 0.6, label: "0.6×" }, { value: 1, label: "1×" }],
  });
  expect(cameraZoomRange(track, { min: 1, max: 8, step: 0.1 }).preferred).toBe(1.7);
  expect(cameraZoomRange(trackFor("Rear 0.5x", "half"), { min: 1, max: 4 }).preferred).toBe(2);
  expect(cameraZoomRange(trackFor("Rear Ultra Wide", "bounded"), { min: 1, max: 1.4, step: 0.2 }).preferred).toBe(1.4);
  expect(cameraZoomRange(track, { min: 1, max: 1 }).choices).toHaveLength(1);
  expect(cameraZoomRange(track, {})).toBeNull();
});

it("changes an anonymous lens only on request and reuses its own framing when that device reopens", () => {
  const track = trackFor("camera2 2, facing back", "numbered"), range = { min: 1, max: 4, step: 0.1 };
  expect(cameraZoomRange(track, range)).toEqual({ preferred: 1,
    choices: [{ value: 1, label: "Full view" }, { value: 1.7, label: "1.7× crop" }] });
  rememberCameraZoom(track, 1.7);
  expect(cameraQualityPreferences({ zoom: range }, trackFor(track.label, "numbered"))).toEqual([{ zoom: 1.7 }]);
  expect(cameraZoomRange(trackFor(track.label, "other"), range).preferred).toBe(1);
  expect(preferredCameraId()).toBe("numbered");
});
