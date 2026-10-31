// Recover page-filling QRed watermarks by the PAPER coordinate system.
// No PDF layout, private key, source content or off-device service is used.
// The legacy finder-based QR decoder remains an independent fallback.
import jsQR from "jsqr";
import { hiddenPayloadFromScanResult } from "./hiddenPayload.js";
import { isChromaticForeground } from "./watermarkFilter.js";
import { readErasedQrMatrix } from "./qrErasureRecovery.js";

const PAPER_INSET = 0.03;
const MAX_PHOTO_PIXELS = 12_000_000;
const MODULE_RENDER_PIXELS = 4;
const FINDER_LOCATIONS = ["topRight", "bottomLeft"];

export function pageWatermarkRegions(count) {
  if (count === 1) return [{ x: PAPER_INSET, y: PAPER_INSET, width: 1 - PAPER_INSET * 2, height: 1 - PAPER_INSET * 2 }];
  if (count !== 4) throw new Error("Page-aligned watermarks use one or four QR symbols.");
  const half = (1 - PAPER_INSET * 2) / 2;
  return Array.from({ length: 4 }, (_, i) => ({
    x: PAPER_INSET + (i % 2) * half,
    y: PAPER_INSET + Math.floor(i / 2) * half,
    width: half,
    height: half,
  }));
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

function locatePaper(image) {
  const { data, width, height } = image;
  if (image.bounds && Number.isFinite(image.scale)) {
    return [{ x: 0, y: 0 }, { x: width - 1, y: 0 },
      { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }];
  }
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
  if (paper - bg < 45) return null; // White-on-white photograph: use ordinary QR.
  const threshold = (paper + bg) / 2;
  const bright = (x, y) => at(x, y) >= threshold;
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
  if (quad.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const [tl, tr, br, bl] = quad;
  const pageWidth = (distance(tl, tr) + distance(bl, br)) / 2;
  const pageHeight = (distance(tl, bl) + distance(tr, br)) / 2;
  if (pageWidth < width * 0.35 || pageHeight < height * 0.35 ||
      pageWidth > width * 1.15 || pageHeight > height * 1.15) return null;
  return quad;
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

function observe(image, mapping, region, size, row, col, ox = 0.5, oy = 0.5) {
  const u = region.x + region.width * (col + ox) / size;
  const v = region.y + region.height * (row + oy) / size;
  const { x, y } = mapping(u, v);
  const sx = Math.round(x), sy = Math.round(y);
  if (sx < 0 || sx >= image.width || sy < 0 || sy >= image.height) return null;
  const index = (sy * image.width + sx) * 4;
  if (isChromaticForeground(image.data, index)) return null;
  const gray = luminance(image.data, index);
  // Solid dark text is opaque, not evidence of the pale QR bit.
  if (gray < 175) return null;
  return gray;
}

function finderIsDark(row, col) {
  return row === 0 || row === 6 || col === 0 || col === 6 ||
    (row >= 2 && row <= 4 && col >= 2 && col <= 4);
}

function scoreVersion(image, mapping, region, version) {
  const size = 17 + 4 * version;
  let matches = 0, observed = 0;
  for (const pattern of FINDER_LOCATIONS) {
    const rowOffset = pattern === "bottomLeft" ? size - 7 : 0;
    const colOffset = pattern === "topRight" ? size - 7 : 0;
    for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) {
      const gray = observe(image, mapping, region, size, rowOffset + row, colOffset + col);
      if (gray === null || (gray > 220 && gray < 231)) continue;
      matches += Number((gray < 225) === finderIsDark(row, col));
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
      if (gray === null || gray > 220 && gray < 231) continue;
      timingHits += Number((gray < 225) === (position % 2 === 0));
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
  const offsets = [0.20, 0.5, 0.80];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let pale = 0, paper = 0;
    for (const oy of offsets) for (const ox of offsets) {
      const gray = observe(image, mapping, region, size, row, col, ox, oy);
      if (gray === null) continue;
      if (gray <= 223) pale++;
      else if (gray >= 230) paper++;
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
  const single = decodeRegion(image, mapping, pageWatermarkRegions(1)[0]);
  if (single) return [single];
  const codes = [];
  for (const region of pageWatermarkRegions(4)) {
    const found = decodeRegion(image, mapping, region);
    if (found && !codes.some(other => other.seal === found.seal)) codes.push(found);
  }
  return codes;
}


/** Diagnostic geometry and version scores; never returns page contents or
 * signed data. Used by synthetic benchmark tests to isolate alignment faults.
 */
export function pageAlignedDiagnostics(image) {
  const quad = locatePaper(image);
  const mapping = quad && pageHomography(quad);
  if (!mapping) return { pageFound: false };
  return {
    pageFound: true,
    corners: quad.map(({ x, y }) => [Math.round(x), Math.round(y)]),
    single: chooseVersions(image, mapping, pageWatermarkRegions(1)[0]),
    quadrants: pageWatermarkRegions(4).map(region => chooseVersions(image, mapping, region)),
  };
}


/** Test diagnostic: return sampled bit decisions without pretending they are
 * authenticated. Production verification never trusts this helper's output.
 */
export function sampledPageAlignedBits(image, regionIndex, version) {
  const quad = locatePaper(image);
  const mapping = quad && pageHomography(quad);
  if (!mapping || !Number.isInteger(version) || version < 1 || version > 40) return null;
  const regions = pageWatermarkRegions(regionIndex === 0 ? 1 : 4);
  const region = regionIndex === 0 ? regions[0] : regions[regionIndex - 1];
  return region ? sampledMatrix(image, mapping, region, version) : null;
}
