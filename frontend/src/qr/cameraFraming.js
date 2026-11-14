// Browser zoom is relative to the camera track. Some rear cameras expose a
// phone-wide 0.6–1× range; a physical ultrawide can instead start at 1.
const zoomByDevice = new Map();
const zoomByTrack = new WeakMap();
let selectedCameraId;

function deviceId(track) {
  try { return track?.getSettings?.().deviceId; } catch { return undefined; }
}

export function cameraWithChosenFraming(devices) {
  return selectedCameraId && devices.find(device => device.kind === "videoinput" && device.deviceId === selectedCameraId);
}

export function cameraZoomRange(track, range) {
  if (!Number.isFinite(range?.max) || range.max <= 0) return null;
  const min = Number.isFinite(range.min) && range.min > 0 ? range.min : 1;
  if (min > range.max) return null;
  const step = Number.isFinite(range.step) && range.step > 0 ? range.step : 0;
  function supported(value) {
    const bounded = Math.min(range.max, Math.max(min, value));
    const rounded = step ? min + Math.round((bounded - min) / step) * step : bounded;
    return Number(Math.min(range.max, Math.max(min, rounded)).toFixed(4));
  }
  const label = track?.label || "";
  const labeledRatio = Number(label.match(/\b(0[.,]\d+)\s*[x×]/i)?.[1]?.replace(",", "."));
  const ultrawide = labeledRatio > 0 || /ultra[\s-]*wide/i.test(label);
  const phoneScale = min < 1 && range.max >= 1;
  const wide = supported(min);
  // A 0.6× lens needs about 1.7× magnification for standard framing. Keep
  // numbered/unknown cameras at their native setting until the user chooses.
  const magnification = labeledRatio > 0 ? 1 / labeledRatio : 1.7;
  const tighter = supported(phoneScale ? 1 : min * magnification);
  const choices = [{ value: wide, label: phoneScale ? `${min}×` : "Full view" }];
  if (tighter > wide) choices.push({ value: tighter, label: phoneScale ? `${tighter}×`
    : `${Number((tighter / min).toFixed(2))}× crop` });
  const id = deviceId(track);
  const remembered = zoomByTrack.get(track) ?? (id && zoomByDevice.get(id));
  const defaultZoom = phoneScale || ultrawide ? tighter : supported(1);
  const preferred = choices.some(choice => choice.value === remembered) ? remembered : defaultZoom;
  return { choices, preferred };
}

export function rememberCameraZoom(track, zoom) {
  zoomByTrack.set(track, zoom);
  const id = deviceId(track);
  if (id) { selectedCameraId = id; zoomByDevice.set(id, zoom); }
}
