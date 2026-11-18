import { version as appVersion } from "../../package.json";

export const SCAN_METADATA_SCHEMA = "qred-scan-capture";
export const MAX_SCAN_METADATA_BYTES = 32 * 1024;
const captures = new WeakMap();
const numericSettings = ["width", "height", "frameRate", "aspectRatio", "zoom", "focusDistance",
  "exposureTime", "exposureCompensation", "iso", "colorTemperature"];
const modes = ["none", "manual", "single-shot", "continuous"];
const choice = (value, values) => values.includes(value) ? value : null;
const number = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e9 ? value : null;
const dimension = value => Number.isInteger(value) && value > 0 && value <= 80_000 ? value : null;
const size = value => dimension(value?.width) && dimension(value?.height)
  && value.width * value.height <= 80_000_000 ? { width: value.width, height: value.height } : null;
const identifier = value => typeof value === "string" && /^[\w.-]{1,80}$/.test(value) ? value : null;

// Explicit allowlist: device/group IDs, labels, user agents, location and text
// never enter QRed's metadata. Null means the browser did not report a value.
function settings(value = {}) {
  return {
    ...Object.fromEntries(numericSettings.map(key => [key, number(value?.[key])])),
    focusMode: choice(value?.focusMode, modes), exposureMode: choice(value?.exposureMode, modes),
    whiteBalanceMode: choice(value?.whiteBalanceMode, modes),
    facingMode: choice(value?.facingMode, ["user", "environment", "left", "right"]),
    resizeMode: choice(value?.resizeMode, ["none", "crop-and-scale"]),
    torch: typeof value?.torch === "boolean" ? value.torch : null,
  };
}

function photoSettings(value) {
  return { imageWidth: dimension(value?.imageWidth), imageHeight: dimension(value?.imageHeight),
    fillLightMode: choice(value?.fillLightMode, ["auto", "off", "flash"]),
    redEyeReduction: typeof value?.redEyeReduction === "boolean" ? value.redEyeReduction : null };
}

// Snapshot immediately before each shutter request, including an optional-size
// retry. A later save or torch shutdown must not change these reported values.
export function snapshotPhotoSettings(track, requested) {
  let reported;
  try { reported = track.getSettings?.(); } catch { /* Optional metadata only. */ }
  return { requestedAt: new Date().toISOString(), trackSettings: settings(reported),
    photoSettings: photoSettings(requested) };
}

function calibration(value) {
  if (value?.model !== "brown-conrady" || !size(value.imageSize)
    || !Array.isArray(value.coefficients) || ![4, 5, 8].includes(value.coefficients.length)
    || !value.coefficients.every(v => number(v) !== null)
    || !Array.isArray(value.cameraMatrix) || value.cameraMatrix.length !== 9
    || !value.cameraMatrix.every(v => number(v) !== null)) return null;
  return { model: value.model, profile: identifier(value.profile),
    imageSize: size(value.imageSize), cameraMatrix: [...value.cameraMatrix],
    coefficients: [...value.coefficients] };
}

// Imported metadata is descriptive, untrusted input. It never supplies signed
// text, a seal, a verification result, or instructions to warp the image.
export function normalizeScanMetadata(value) {
  if (value?.schema !== SCAN_METADATA_SCHEMA || value.version !== 1) return null;
  const capture = value.capture, processing = value.processing;
  return {
    schema: SCAN_METADATA_SCHEMA, version: 1,
    app: { version: identifier(value.app?.version), build: identifier(value.app?.build) },
    capture: {
      source: choice(capture?.source, ["native-still", "selected-photo"]),
      requestedAt: typeof capture?.requestedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(capture.requestedAt)
        && Number.isFinite(Date.parse(capture.requestedAt)) ? capture.requestedAt : null,
      trigger: choice(capture?.trigger, ["manual", "automatic"]),
      preview: size(capture?.preview),
      guideState: choice(capture?.guideState, ["framing", "small", "dark", "soft", "clear", "hold", "ready", "captured"]),
      trackSettings: settings(capture?.trackSettings), photoSettings: photoSettings(capture?.photoSettings),
    },
    image: { encodedSize: size(value.image?.encodedSize), decodedSize: size(value.image?.decodedSize),
      exifOrientation: choice(value.image?.exifOrientation, [1, 2, 3, 4, 5, 6, 7, 8]) },
    processing: {
      savedPixels: choice(processing?.savedPixels, ["camera-original", "selected-original"]),
      cameraLensCorrection: "unknown",
      qredLensCorrection: choice(processing?.qredLensCorrection, ["not-applied", "applied"]),
      qredPerspectiveCorrection: choice(processing?.qredPerspectiveCorrection, ["not-applied", "applied"]),
      decoderInput: size(processing?.decoderInput),
      decoderOrientation: choice(processing?.decoderOrientation, ["browser-default"]),
      decoderCrop: null,
    },
    calibration: calibration(value.calibration),
  };
}

export function createCaptureMetadata(snapshot, diagnostic, context = {}) {
  return normalizeScanMetadata({
    schema: SCAN_METADATA_SCHEMA, version: 1,
    app: { version: appVersion, build: import.meta.env.QRED_BUILD_ID },
    capture: { ...snapshot, source: "native-still", trigger: context.trigger, guideState: context.guideState,
      preview: { width: context.previewWidth, height: context.previewHeight } },
    image: { decodedSize: { width: diagnostic.sourceWidth, height: diagnostic.sourceHeight } },
    processing: { savedPixels: "camera-original", qredLensCorrection: "not-applied", qredPerspectiveCorrection: "not-applied",
      decoderInput: { width: diagnostic.width, height: diagnostic.height }, decoderOrientation: "browser-default" },
    calibration: null,
  });
}

export function rememberScanMetadata(photo, metadata) {
  const clean = normalizeScanMetadata(metadata);
  if (clean) captures.set(photo, clean);
}

export function getScanPhotoMetadata(photo) {
  return normalizeScanMetadata(captures.get(photo));
}
