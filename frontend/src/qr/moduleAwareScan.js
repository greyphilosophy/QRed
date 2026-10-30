// Second-stage QR recovery for pale symbols crossed by black document text.
// Use jsQR's existing finder/alignment geometry and Reed-Solomon decoder;
// only the per-module pixel decision differs from the ordinary decoder.
import { BitMatrix } from "jsqr/dist/BitMatrix";
import { locate } from "jsqr/dist/locator";
import { extract } from "jsqr/dist/extractor";
import { decode } from "jsqr/dist/decoder/decoder";
import { normalizeWatermarkLuminance } from "./watermarkFilter.js";

const OFFSETS = [0.15, 0.325, 0.5, 0.675, 0.85];
const MIN_SAMPLES = 4;
const MAX_LOCATIONS = 3;

function moduleVote(matrix, mapping, normalized, width, height) {
  const modules = BitMatrix.createEmpty(matrix.width, matrix.height);
  let confident = 0;
  for (let y = 0; y < modules.height; y++) {
    for (let x = 0; x < modules.width; x++) {
      let light = 0, ink = 0;
      for (const dy of OFFSETS) for (const dx of OFFSETS) {
        const point = mapping(x + dx, y + dy);
        const sx = Math.floor(point.x), sy = Math.floor(point.y);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const value = normalized[sy * width + sx];
        // Black document ink is occlusion, not evidence of a QR bit.
        // Keep it unknown and use the unobstructed parts of this module.
        if (value < 180) continue;
        if (value < 240) ink++;
        else light++;
      }
      const count = ink + light;
      // If fully masked, retain the original locally filtered estimate.
      // Reed-Solomon may correct the resulting codeword error.
      const reliable = count >= MIN_SAMPLES && Math.abs(ink - light) >= 2;
      if (reliable) confident++;
      modules.set(x, y, reliable ? ink > light : matrix.get(x, y));
    }
  }
  return { modules, confident };
}

export function scanModuleAwareQr(originalRgba, filteredRgba, width, height) {
  if (!width || !height || width * height > 2_500_000 ||
      originalRgba.length !== width * height * 4 ||
      filteredRgba.length !== width * height * 4) return null;

  const binary = BitMatrix.createEmpty(width, height);
  for (let index = 0; index < width * height; index++) {
    binary.set(index % width, Math.floor(index / width), filteredRgba[index * 4] < 128);
  }
  // Locate using the already recovered pale-ink image, *not* the original
  // dark text. Locations require intact finder patterns, independent of PDF.
  const locations = locate(binary);
  if (!locations?.length) return null;
  const normalized = normalizeWatermarkLuminance(originalRgba, width, height);
  for (const location of locations.slice(0, MAX_LOCATIONS)) {
    const dimensions = [location.dimension, location.dimension - 4, location.dimension + 4];
    for (const dimension of dimensions) {
      if (dimension < 21 || dimension > 177 || dimension % 4 !== 1) continue;
      const candidate = { ...location, dimension };
      const { matrix, mappingFunction } = extract(binary, candidate);
      const { modules, confident } = moduleVote(matrix, mappingFunction, normalized, width, height);
      if (confident < dimension * dimension * 0.25) continue;
      const decoded = decode(modules);
      if (!decoded) continue;
      return {
        binaryData: decoded.bytes,
        correctedData: decoded.correctedData,
        data: decoded.text,
        chunks: decoded.chunks,
        version: decoded.version,
        moduleAware: true,
        location: {
          topRightCorner: mappingFunction(dimension, 0),
          topLeftCorner: mappingFunction(0, 0),
          bottomRightCorner: mappingFunction(dimension, dimension),
          bottomLeftCorner: mappingFunction(0, dimension),
          topRightFinderPattern: location.topRight,
          topLeftFinderPattern: location.topLeft,
          bottomLeftFinderPattern: location.bottomLeft,
          bottomRightAlignmentPattern: location.alignmentPattern,
        },
      };
    }
  }
  return null;
}
