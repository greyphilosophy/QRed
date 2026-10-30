// Second-stage QR recovery for pale symbols crossed by black document text.
// Use jsQR's existing finder/alignment geometry and Reed-Solomon decoder;
// only the per-module pixel decision differs from the ordinary decoder.
import jsQR from "jsqr";
import { normalizeWatermarkLuminance } from "./watermarkFilter.js";

const OFFSETS = [0.15, 0.325, 0.5, 0.675, 0.85];
const MIN_SAMPLES = 4;

function moduleVote(matrix, mapping, normalized, width, height) {
  const votes = [];
  for (let y = 0; y < matrix.height; y++) for (let x = 0; x < matrix.width; x++) {
    let light = 0, ink = 0;
    for (const dy of OFFSETS) for (const dx of OFFSETS) {
      const point = mapping(x + dx, y + dy);
      const sx = Math.floor(point.x), sy = Math.floor(point.y);
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const value = normalized[sy * width + sx];
      // Black printed text has hidden the QR bit; do not count it as QR ink.
      if (value < 180) continue;
      if (value < 240) ink++;
      else light++;
    }
    const count = ink + light;
    const reliable = count >= MIN_SAMPLES && Math.abs(ink - light) >= 2;
    if (reliable) votes.push([x, y, ink > light]);
    // Fully hidden modules retain the existing local-filter estimate.
  }
  if (votes.length < matrix.width * matrix.height * 0.25) return null;
  for (const [x, y, dark] of votes) matrix.set(x, y, dark);
  return matrix;
}

export function scanModuleAwareQr(originalRgba, filteredRgba, width, height, normalizedImage = null) {
  if (!width || !height || width * height > 2_500_000 ||
      originalRgba.length !== width * height * 4 ||
      filteredRgba.length !== width * height * 4) return null;

  const normalized = normalizedImage ?? normalizeWatermarkLuminance(originalRgba, width, height);
  // jsQR has already been patched for QRed to retain corrected hidden bytes.
  // Extend that same tested decoder with a synchronous per-module callback;
  // no second QR implementation, and no dependence on the original PDF.
  const code = jsQR(filteredRgba, width, height, {
    inversionAttempts: "dontInvert",
    moduleSampler: (matrix, mapping) => moduleVote(matrix, mapping, normalized, width, height),
  });
  return code ? { ...code, moduleAware: true } : null;
}
