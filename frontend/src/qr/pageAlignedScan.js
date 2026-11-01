// Recover page-filling QRed watermarks by the PAPER coordinate system.
// No PDF layout, private key, source content or off-device service is used.
// The legacy finder-based QR decoder remains an independent fallback.
import jsQR from "jsqr";
import { hiddenPayloadFromScanResult } from "./hiddenPayload.js";
import { isChromaticForeground } from "./watermarkFilter.js";
import { readErasedQrMatrix } from "./qrErasureRecovery.js";

// Printer-safe clearance for QRed's visible watermark modules. One PDF point
// is 1/72 inch, so 54 points = 0.75 inch of blank border on every side.
export const MIN_WATERMARK_MARGIN_POINTS = 54;
const LEGACY_PAPER_INSET = 0.03;
export const LETTER_PAGE_SIZE = Object.freeze({ width: 612, height: 792 });
// Printed documents do not carry metadata revealing the original paper size.
// A verifier therefore tries plausible physical page formats and accepts only
// an exact, cryptographically verified seal (not a guessed placement).
const PHOTO_PAGE_FORMATS = [
  LETTER_PAGE_SIZE,
  { width: 595.28, height: 841.89 }, // A4
  { width: 841.89, height: 1190.55 }, // A3
  { width: 612, height: 1008 },       // US Legal
  { width: 792, height: 1224 },       // US Tabloid/Ledger
];
// Allow current 12–48 MP phone stills without duplicating their full raster.
// Only the page-edge detector uses a small preview. QR module evidence is
// ALWAYS sampled from the original full-resolution pixels.
const MAX_PHOTO_PIXELS = 80_000_000;
const MAX_GEOMETRY_PIXELS = 1_500_000;
const MODULE_RENDER_PIXELS = 4;
const FINDER_LOCATIONS = ["topRight", "bottomLeft"];

// Margins refer to the ORIGINAL PDF page in points, not the photographed
// pixels. In particular, 54pt must NOT become "3%" on every paper size.
// Legacy 3%-inset documents stay readable through an explicit scan fallback.
export function pageWatermarkRegions(count, pageSize = LETTER_PAGE_SIZE, { legacy = false } = {}) {
  const { width, height } = pageSize ?? {};
  if (!Number.isFinite(width) || !Number.isFinite(height) ||
      width <= MIN_WATERMARK_MARGIN_POINTS * 2 ||
      height <= MIN_WATERMARK_MARGIN_POINTS * 2) {
    throw new Error("Page is too small for 0.75-inch watermark margins.");
  }
  const marginX = legacy ? LEGACY_PAPER_INSET : MIN_WATERMARK_MARGIN_POINTS / width;
  const marginY = legacy ? LEGACY_PAPER_INSET : MIN_WATERMARK_MARGIN_POINTS / height;
  const innerWidth = 1 - marginX * 2, innerHeight = 1 - marginY * 2;
  if (count === 1) {
    return [{ x: marginX, y: marginY, width: innerWidth, height: innerHeight }];
  }
  if (count !== 4) throw new Error("Page-aligned watermarks use one or four QR symbols.");
  const halfWidth = innerWidth / 2, halfHeight = innerHeight / 2;
  return Array.from({ length: 4 }, (_, i) => ({
    x: marginX + (i % 2) * halfWidth,
    y: marginY + Math.floor(i / 2) * halfHeight,
    width: halfWidth,
    height: halfHeight,
  }));
}

function photoPageSizes(image, quad) {
  if (image.bounds) return [image.bounds];
  const [tl, tr, br, bl] = quad;
  const measured = (distance(tl, tr) + distance(bl, br)) /
    Math.max(1, distance(tl, bl) + distance(tr, br));
  // Approximate image aspect ratio is only a RANKING clue because camera
  // perspective, curl and skew change the observed edge lengths. A4 and A3
  // require separate trials despite having the same aspect ratio.
  const ranked = PHOTO_PAGE_FORMATS
    .map(size => ({ size, deviation: Math.abs(size.width / size.height - measured) }))
    .sort((a, b) => a.deviation - b.deviation);
  return ranked.filter(({ deviation }, i) => i === 0 || deviation <= 0.15)
    .slice(0, 4).map(({ size }) => size);
}

function luminance(data, index) {
  return (data[index] + data[index + 1] + data[index + 2]) / 3;
}

function fit(values) {
  if (values.length < 12) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of values) {
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = values.length, denominator = n * sxx - sx * sx;
  if (!denominator) return null;
  const slope = (n * sxy - sx * sy) / denominator;
  return { slope, offset: (sy - slope * sx) / n };
}

function intersect(vertical, horizontal) {
  const denominator = 1 - vertical.slope * horizontal.slope;
  if (Math.abs(denominator) < 0.05) return null;
  const x = (vertical.offset + vertical.slope * horizontal.offset) / denominator;
  return { x, y: horizontal.offset + horizontal.slope * x };
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// Read a bounded geometry preview instead of copying a 12–48 MP phone photo.
// Nearest neighboring samples are averaged for edge stability, without
// softening or discarding fine watermark modules in the original image.
function previewForPaperEdges(image) {
  const { width, height, data } = image;
  if (width * height <= MAX_GEOMETRY_PIXELS) return image;
  const scale = Math.sqrt(MAX_GEOMETRY_PIXELS / (width * height));
  const w = Math.max(160, Math.floor(width * scale));
  const h = Math.max(160, Math.floor(height * scale));
  const pixels = new Uint8ClampedArray(w * h * 4);
  const offsets = [[-1, -1], [0, 0], [1, 0], [0, 1]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.round((x + 0.5) * width / w - 0.5);
    const sy = Math.round((y + 0.5) * height / h - 0.5);
    const out = (y * w + x) * 4;
    for (const [dx, dy] of offsets) {
      const px = Math.min(width - 1, Math.max(0, sx + dx));
      const py = Math.min(height - 1, Math.max(0, sy + dy));
      const input = (py * width + px) * 4;
      for (let channel = 0; channel < 3; channel++) pixels[out + channel] += data[input + channel] / offsets.length;
    }
    pixels[out + 3] = 255;
  }
  return { data: pixels, width: w, height: h };
}

function locatePaperAtResolution(image) {
  const { data, width, height } = image;
  const at = (x, y) => luminance(data, (y * width + x) * 4);
  const bg = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]
    .sort((a, b) => a - b)[1];
  // The center of the sheet may contain text. Sample several center-area
  // points; the high percentile estimates the unprinted paper.
  const middle = [];
  for (const v of [0.30, 0.40, 0.50, 0.60, 0.70])
    for (const u of [0.3, 0.4, 0.5, 0.6, 0.7])
      middle.push(at(Math.round(u * (width - 1)), Math.round(v * (height - 1))));
  middle.sort((a, b) => a - b);
  const paper = middle[Math.floor(middle.length * 0.8)];
  const contrast = paper - bg;
  // On a light desk, the sheet's brightness can differ by only ~10 levels.
  // A large fixed 45-level threshold rejects those pages unnecessarily.
  // The blank outer margin provides a continuous edge even where printed
  // glyphs obscure the interior. Do not invent an edge when no distinguishable
  // border exists; old finder-based scanning remains the fallback.
  const cornerOffsets = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
  const deskRgb = [0, 1, 2].map(channel =>
    cornerOffsets.reduce((sum, [x, y]) => sum + data[(y * width + x) * 4 + channel], 0) / 4);
  const deskChroma = Math.max(...deskRgb) - Math.min(...deskRgb);
  const paperChroma = [];
  for (const v of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    for (const u of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const x = Math.round(u * (width - 1)), y = Math.round(v * (height - 1));
      const index = (y * width + x) * 4;
      const r = data[index], g = data[index + 1], b = data[index + 2];
      paperChroma.push(Math.max(r, g, b) - Math.min(r, g, b));
    }
  }
  paperChroma.sort((a, b) => a - b);
  // A printed gray QR on white paper is nearly neutral even beneath shadow,
  // while a purple or brightly patterned tabletop remains chromatic.
  // Don't require paper to exceed 218: real photos often expose white as ~190.
  const useChroma = deskChroma >= 12 && paperChroma[Math.floor(paperChroma.length / 2)] < deskChroma * 0.55;
  if (Math.abs(contrast) < 8 && !useChroma) return null;
  const forward = contrast >= 0;
  const threshold = Math.abs(contrast) >= 45
    ? (paper + bg) / 2
    : bg + (forward ? 1 : -1) * Math.max(2.5, 0.23 * Math.abs(contrast));
  const chromaLimit = Math.max(7, Math.min(12, deskChroma * 0.45));
  const bright = (x, y) => {
    const value = at(x, y);
    if (useChroma) {
      const start = (y * width + x) * 4;
      const r = data[start], g = data[start + 1], b = data[start + 2];
      return value > Math.max(45, bg * 0.42) &&
        Math.max(r, g, b) - Math.min(r, g, b) < chromaLimit;
    }
    return forward ? value >= threshold : value <= threshold;
  };
  const rowStep = Math.max(2, Math.round(height / 280));
  const colStep = Math.max(2, Math.round(width / 280));
  const left = [], right = [], top = [], bottom = [];
  const brightRunX = (x, y, direction) => {
    const end = x + 3 * direction;
    return end >= 0 && end < width &&
      bright(x, y) && bright(x + direction, y) &&
      bright(x + 2 * direction, y) && bright(end, y);
  };
  const brightRunY = (x, y, direction) => {
    const end = y + 3 * direction;
    return end >= 0 && end < height &&
      bright(x, y) && bright(x, y + direction) &&
      bright(x, y + 2 * direction) && bright(x, end);
  };
  for (let y = 0; y < height; y += rowStep) {
    let lo = -1, hi = -1;
    for (let x = 0; x < width - 3; x++) if (brightRunX(x, y, 1)) { lo = x; break; }
    if (lo < 0) continue;
    for (let x = width - 1; x >= 3; x--) if (brightRunX(x, y, -1)) { hi = x; break; }
    if (hi - lo < width * 0.40) continue;
    left.push([y, lo]);
    right.push([y, hi]);
  }
  for (let x = 0; x < width; x += colStep) {
    let lo = -1, hi = -1;
    for (let y = 0; y < height - 3; y++) if (brightRunY(x, y, 1)) { lo = y; break; }
    if (lo < 0) continue;
    for (let y = height - 1; y >= 3; y--) if (brightRunY(x, y, -1)) { hi = y; break; }
    if (hi - lo < height * 0.40) continue;
    top.push([x, lo]);
    bottom.push([x, hi]);
  }
  // Exclude the short oblique row/column intersections near the corners.
  function central(points) {
    const ordered = points.sort((a, b) => a[0] - b[0]);
    return ordered.slice(Math.floor(ordered.length * 0.12), Math.ceil(ordered.length * 0.88));
  }
  const edges = [left, right, top, bottom].map(p => fit(central(p)));
  if (edges.some(edge => !edge)) return null;
  const [l, r, t, b] = edges;
  const quad = [intersect(l, t), intersect(r, t), intersect(r, b), intersect(l, b)];
  if (quad.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
      p.x < -width * 0.03 || p.x > width * 1.03 ||
      p.y < -height * 0.03 || p.y > height * 1.03)) return null;
  const [tl, tr, br, bl] = quad;
  const pageWidth = (distance(tl, tr) + distance(bl, br)) / 2;
  const pageHeight = (distance(tl, bl) + distance(tr, br)) / 2;
  if (pageWidth < width * 0.35 || pageHeight < height * 0.35 ||
      pageWidth > width * 1.15 || pageHeight > height * 1.15) return null;
  return quad;
}

function locatePaper(image) {
  const { width, height } = image;
  if (image.bounds && Number.isFinite(image.scale)) {
    // PDF renderers already supply a known visible page crop; this is only a
    // raster-coordinate mapping, not metadata passed to the photo verifier.
    return [{ x: 0, y: 0 }, { x: width - 1, y: 0 },
      { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }];
  }
  const preview = previewForPaperEdges(image);
  const corners = locatePaperAtResolution(preview);
  if (!corners) return null;
  if (preview === image) return corners;
  const factorX = width / preview.width, factorY = height / preview.height;
  return corners.map(({ x, y }) => ({
    x: (x + 0.5) * factorX - 0.5,
    y: (y + 0.5) * factorY - 0.5,
  }));
}

// Unit-square-to-quadrilateral projective transform; correcting by the
// physical 8.5/11 ratio alone would not remove camera perspective distortion.
export function pageHomography([tl, tr, br, bl]) {
  const dx3 = tl.x - tr.x + br.x - bl.x;
  const dy3 = tl.y - tr.y + br.y - bl.y;
  const dx1 = tr.x - br.x, dx2 = bl.x - br.x;
  const dy1 = tr.y - br.y, dy2 = bl.y - br.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(denominator) < 1e-6) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  const a = tr.x - tl.x + g * tr.x, b = bl.x - tl.x + h * bl.x;
  const d = tr.y - tl.y + g * tr.y, e = bl.y - tl.y + h * bl.y;
  return (u, v) => {
    const scale = 1 / (g * u + h * v + 1);
    return { x: (a * u + b * v + tl.x) * scale,
      y: (d * u + e * v + tl.y) * scale };
  };
}

// Find the locally illuminated *paper*, not an absolute RGB white value.
// A printed sheet can be 130 gray in shadow and 220 gray under bright light.
// Twenty-five samples within each of 32x32 page-coordinate tiles estimate
// the exposed paper signal, rejecting colored glyphs. This is computed only
// once per page-aligned scan, even for a four-quadrant watermark.
function paperBrightnessMap(image, mapping) {
  const count = 32, values = new Float32Array(count * count);
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
    let best = 0;
    for (let sy = 0; sy < 5; sy++) for (let sx = 0; sx < 5; sx++) {
      const u = (col + (sx + 0.5) / 5) / count;
      const v = (row + (sy + 0.5) / 5) / count;
      const point = mapping(u, v), x = Math.round(point.x), y = Math.round(point.y);
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const index = (y * image.width + x) * 4;
      if (isChromaticForeground(image.data, index)) continue;
      const gray = luminance(image.data, index);
      if (gray > best) best = gray;
    }
    values[row * count + col] = best;
  }
  return (u, v) => {
    const xx = Math.max(0, Math.min(count - 1.001, u * count - 0.5));
    const yy = Math.max(0, Math.min(count - 1.001, v * count - 0.5));
    const x = Math.floor(xx), y = Math.floor(yy), fx = xx - x, fy = yy - y;
    const a = values[y * count + x], b = values[y * count + Math.min(count - 1, x + 1)];
    const c = values[Math.min(count - 1, y + 1) * count + x];
    const d = values[Math.min(count - 1, y + 1) * count + Math.min(count - 1, x + 1)];
    return Math.max(35, (a * (1 - fx) + b * fx) * (1 - fy) +
      (c * (1 - fx) + d * fx) * fy);
  };
}

function observe(image, mapping, region, size, row, col, ox = 0.5, oy = 0.5) {
  const u = region.x + region.width * (col + ox) / size;
  const v = region.y + region.height * (row + oy) / size;
  const { x, y } = mapping(u, v);
  const sx = Math.round(x), sy = Math.round(y);
  if (sx < 0 || sx >= image.width || sy < 0 || sy >= image.height) return null;
  const index = (sy * image.width + sx) * 4;
  if (isChromaticForeground(image.data, index)) return null;
  const gray = luminance(image.data, index);
  const paper = image.paperAt ? image.paperAt(u, v) : 255;
  // Dark text is missing evidence, but a gray watermark under a shadow
  // must never be discarded solely because its absolute luminance is <175.
  if (gray < paper * 0.56) return null;
  return Math.min(255, 255 * gray / paper);
}

function finderIsDark(row, col) {
  return row === 0 || row === 6 || col === 0 || col === 6 ||
    (row >= 2 && row <= 4 && col >= 2 && col <= 4);
}

// Calibrate to the actual local gray levels in printed QR finder cells.
// A phone may expose white paper as gray 180–240, and a pale module only
// 8–20 units darker. Fixed thresholds cannot handle that range.
function finderContrast(image, mapping, region, size) {
  const dark = [], light = [];
  for (const pattern of FINDER_LOCATIONS) {
    const rowOffset = pattern === "bottomLeft" ? size - 7 : 0;
    const colOffset = pattern === "topRight" ? size - 7 : 0;
    for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) {
      const gray = observe(image, mapping, region, size, rowOffset + row, colOffset + col);
      if (gray === null) continue;
      (finderIsDark(row, col) ? dark : light).push(gray);
    }
  }
  if (dark.length < 12 || light.length < 12) return null;
  const median = values => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const black = median(dark), white = median(light);
  if (white - black < 4) return null;
  return { threshold: (black + white) / 2, gap: white - black };
}

function scoreVersion(image, mapping, region, version) {
  const size = 17 + 4 * version;
  const contrast = finderContrast(image, mapping, region, size);
  if (!contrast) return 0;
  const threshold = contrast.threshold;
  let matches = 0, observed = 0;
  for (const pattern of FINDER_LOCATIONS) {
    const rowOffset = pattern === "bottomLeft" ? size - 7 : 0;
    const colOffset = pattern === "topRight" ? size - 7 : 0;
    for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) {
      const gray = observe(image, mapping, region, size, rowOffset + row, colOffset + col);
      if (gray === null || Math.abs(gray - threshold) < 1) continue;
      matches += Number((gray < threshold) === finderIsDark(row, col));
      observed++;
    }
  }
  if (observed < 36) return 0;
  // Finder geometry alone is ambiguous for dense v35–v40 symbols because
  // several nearby versions produce almost identical endpoint patterns.
  // Timing stripes provide a version-specific interior pitch reference.
  let timingHits = 0, timingSeen = 0;
  for (let position = 11; position < size - 11; position += 2) {
    for (const [row, col] of [[6, position], [position, 6]]) {
      const gray = observe(image, mapping, region, size, row, col);
      if (gray === null || Math.abs(gray - threshold) < 1) continue;
      timingHits += Number((gray < threshold) === (position % 2 === 0));
      timingSeen++;
    }
  }
  const finderScore = matches / observed;
  const timingScore = timingSeen >= 14 ? timingHits / timingSeen : finderScore;
  return finderScore * 0.58 + timingScore * 0.42;
}

function chooseVersions(image, mapping, region) {
  const candidates = [];
  for (let version = 1; version <= 40; version++) {
    const score = scoreVersion(image, mapping, region, version);
    if (score > 0.58) candidates.push({ version, score });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
}

function forceFinder(matrix, size, x0, y0) {
  // Finder pattern (7x7) plus its one-module white separator.
  for (let row = -1; row <= 7; row++) for (let col = -1; col <= 7; col++) {
    const x = x0 + col, y = y0 + row;
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    matrix[y * size + x] = row >= 0 && row < 7 && col >= 0 && col < 7
      && finderIsDark(row, col) ? 1 : 0;
  }
}

function restoreStructure(matrix, size) {
  forceFinder(matrix, size, 0, 0);
  forceFinder(matrix, size, size - 7, 0);
  forceFinder(matrix, size, 0, size - 7);
  // The public QR structure is not secret data. Restoring timing samples
  // prevents opaque text through them from defeating alignment.
  for (let position = 8; position < size - 8; position++) {
    matrix[6 * size + position] = position % 2 === 0 ? 1 : 0;
    matrix[position * size + 6] = position % 2 === 0 ? 1 : 0;
  }
}

function sampledMatrix(image, mapping, region, version) {
  const size = 17 + 4 * version;
  const bits = new Uint8Array(size * size), unknown = new Uint8Array(bits.length);
  const confidence = new Uint8Array(bits.length);
  const contrast = finderContrast(image, mapping, region, size);
  const threshold = contrast?.threshold ?? 237;
  const band = contrast ? Math.max(1.5, Math.min(6, contrast.gap * 0.12)) : 3;
  const offsets = [0.20, 0.5, 0.80];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let pale = 0, paper = 0;
    for (const oy of offsets) for (const ox of offsets) {
      const gray = observe(image, mapping, region, size, row, col, ox, oy);
      if (gray === null) continue;
      if (gray <= threshold - band) pale++;
      else if (gray >= threshold + band) paper++;
    }
    const index = row * size + col;
    bits[index] = pale > paper ? 1 : 0;
    // If text covers the entire module, guessing white turns an erasure
    // (known location) into a more expensive unknown-position byte error.
    // Flag for the RS erasure decoder instead.
    // Even one foreground-covered observation means the corresponding
    // module has missing bit evidence. Mark it for GF(2) parity recovery
    // (which spends only one bit of redundancy, not an entire codeword).
    // The fallback byte-erasure path ranks how much evidence is missing.
    if (pale + paper < 9 || Math.abs(pale - paper) < 2) {
      unknown[index] = 1;
      confidence[index] = Math.max(1, 9 - (pale + paper));
    }
  }
  restoreStructure(bits, size);
  return { bits, size, unknown, confidence };
}

function rasterForDecoder({ bits, size }) {
  const tile = MODULE_RENDER_PIXELS, width = (size + 8) * tile;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    if (!bits[row * size + col]) continue;
    for (let y = (row + 4) * tile; y < (row + 5) * tile; y++) {
      const offset = (y * width + (col + 4) * tile) * 4;
      data.fill(0, offset, offset + tile * 4);
      for (let x = 3; x < tile * 4; x += 4) data[offset + x] = 255;
    }
  }
  return { data, width };
}

function scannedGeometry(mapping, region, size) {
  const at = (row, col) => mapping(
    region.x + region.width * col / size,
    region.y + region.height * row / size,
  );
  return {
    topLeftCorner: at(0, 0), topRightCorner: at(0, size),
    bottomLeftCorner: at(size, 0), bottomRightCorner: at(size, size),
    topLeftFinderPattern: at(3.5, 3.5),
    topRightFinderPattern: at(3.5, size - 3.5),
    bottomLeftFinderPattern: at(size - 3.5, 3.5),
  };
}

function decodeRegion(image, mapping, region) {
  for (const { version } of chooseVersions(image, mapping, region)) {
    const { bits, size, unknown, confidence } = sampledMatrix(image, mapping, region, version);
    const raster = rasterForDecoder({ bits, size });
    const ordinary = jsQR(raster.data, raster.width, raster.width, { inversionAttempts: "dontInvert" });
    if (ordinary?.version === version) {
      const seal = hiddenPayloadFromScanResult(ordinary);
      if (seal) return { seal, code: { ...ordinary,
        location: scannedGeometry(mapping, region, size), pageAligned: true } };
    }
    // Only the exact same QR parity blocks and corrected hidden payload can
    // pass this recovery. Erasures come from photographed opaque foreground,
    // never from a saved PDF's text, layout or claimed content.
    if (!unknown.some(Boolean)) continue;
    const recovered = readErasedQrMatrix(bits, unknown, version, confidence);
    if (!recovered) continue;
    const code = { data: "QRED.ORG", version, correctedData: recovered.correctedData,
      location: scannedGeometry(mapping, region, size), pageAligned: true, erasureAware: true };
    const seal = hiddenPayloadFromScanResult(code);
    if (seal) return { seal, code };
  }
  return null;
}

/** Synchronous photograph-only watermark recovery. The page and QR grids are
 * established from visible paper edges, not from metadata or a signing layout.
 * "pageAligned: false" is handled by callers as the legacy fallback path.
 */
export function scanPageAlignedImage(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
      image.width < 160 || image.height < 160 ||
      image.width * image.height > MAX_PHOTO_PIXELS ||
      image.data?.length !== image.width * image.height * 4) return [];
  const quad = locatePaper(image);
  if (!quad) return [];
  const mapping = pageHomography(quad);
  if (!mapping) return [];
  // Printing can shrink the PDF's content slightly within the fixed paper
  // boundary. Try one bounded centered scale hypothesis only after regular
  // geometry fails. This handles uniform 97% shrink; off-axis and local
  // distortion still require independent QR finder/timing calibration.
  const scaleAttempts = image.bounds ? [1] : [1, 0.97];
  // Keep legacy 3%-inset documents verifiable while new seals use 54pt.
  // The new safe layout is always attempted before the backward-compatible
  // one, and any result still needs the complete signed payload.
  const formats = photoPageSizes(image, quad);
  const profiles = [...formats.map(size => ({ size, legacy: false })),
    { size: LETTER_PAGE_SIZE, legacy: true }];
  let bestCodes = [];
  for (const scale of scaleAttempts) {
    const candidateMapping = scale === 1 ? mapping :
      (u, v) => mapping(0.5 + (u - 0.5) * scale, 0.5 + (v - 0.5) * scale);
    const sampledImage = { ...image, paperAt: paperBrightnessMap(image, candidateMapping) };
    for (const profile of profiles) {
      const singleRegion = pageWatermarkRegions(1, profile.size, profile)[0];
      const single = decodeRegion(sampledImage, candidateMapping, singleRegion);
      if (single) return [single];
      const codes = [];
      for (const region of pageWatermarkRegions(4, profile.size, profile)) {
        const found = decodeRegion(sampledImage, candidateMapping, region);
        if (found && !codes.some(other => other.seal === found.seal)) codes.push(found);
      }
      if (codes.length > bestCodes.length) bestCodes = codes;
      if (codes.length === 4) return codes;
    }
  }
  return bestCodes;
}
