import { encodeErasureChunks } from "../erasureTransport.js";
import { decodeEnvelope, sealString } from "../sealFormat.js";
import { createQRedQrSymbol } from "../qredQr.js";
import { drawQrSymbol } from "./qrDrawing.js";

const MAX_PIXELS = 3_000_000;
// Fixed order is also the tie-break order. No OCR result influences placement.
const TRAVERSALS = [
  ["x", -1, -1], ["x", -1, 1], ["x", 1, -1], ["x", 1, 1],
  ["y", -1, -1], ["y", -1, 1], ["y", 1, -1], ["y", 1, 1],
];

// Opt-in planning only. Never changes the default layout or silently reduces
// evidence, module size, ECC, page size, or source content to force a fit.
// A caller must keep its ordinary seal/layout on every unavailable result and
// must additionally preflight optical recovery before using an available plan.
export async function planNonoverlapErasure(image, record, {
  required = 12, total = 16, moduleSize = 1.25, margin = 36, guard = 2, signal,
} = {}) {
  signal?.throwIfAborted();
  const checkpoint = async () => {
    if (signal) { await new Promise(resolve => setTimeout(resolve, 0)); signal.throwIfAborted(); }
  };
  const unavailable = reason => ({ status: "unavailable", reason });
  const { width, height, data, scale } = image || {};
  if (image?.rotation !== 0 || image?.userUnit !== 1 || image?.bounds?.x !== 0 || image?.bounds?.y !== 0 ||
      image.bounds.width * scale !== width || image.bounds.height * scale !== height ||
      scale !== 2 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width * height > MAX_PIXELS || data?.length !== width * height * 4) return unavailable("unsupported-render");
  if (!Number.isFinite(moduleSize) || moduleSize < 1.25 || moduleSize > 3 ||
      !Number.isFinite(margin) || margin < 36 || !Number.isFinite(guard) || guard < 2) return unavailable("invalid-placement-policy");
  let shards, symbols;
  try {
    decodeEnvelope(record);
    shards = await encodeErasureChunks(record, { required, total });
    symbols = shards.map(bytes => createQRedQrSymbol(sealString(bytes), { errorCorrectionLevel: "M" }));
  } catch { return unavailable("transport-capacity"); }
  await checkpoint();
  const size = Math.max(...symbols.map(symbol => symbol.modules.size + 8)) * moduleSize;
  const side = Math.ceil(size * scale), padding = Math.ceil(guard * scale), inset = Math.ceil(margin * scale);
  if (side + 2 * (inset + padding) > Math.min(width, height)) return unavailable("insufficient-whitespace");
  const stride = width + 1, integral = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      // Even faint original ink, antialiased edges and nonopaque pixels count.
      row += Number(data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255 || data[offset + 3] !== 255);
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  await checkpoint();
  const occupied = (x0, y0, x1, y1) => integral[y1 * stride + x1] - integral[y0 * stride + x1] -
    integral[y1 * stride + x0] + integral[y0 * stride + x0];
  const min = inset + padding, maxX = width - side - padding - inset, maxY = height - side - padding - inset;
  // At most MAX_PIXELS entries, not an object per origin. The maximum radius
  // is below sqrt(MAX_PIXELS)/2, safely within Uint16. Zero means unavailable.
  const clearance = new Uint16Array(width * height);
  const counts = new Uint32Array(Math.floor(Math.min(width, height) / 2) + 1);
  let originCount = 0;
  for (let y = min; y <= maxY; y++) for (let x = min; x <= maxX; x++) {
    if (occupied(x - padding, y - padding, x + side + padding, y + side + padding)) continue;
    let lo = padding, hi = Math.min(x, y, width - x - side, height - y - side);
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (occupied(x - mid, y - mid, x + side + mid, y + side + mid)) hi = mid - 1;
      else lo = mid;
    }
    clearance[y * width + x] = lo;
    counts[lo]++;
    originCount++;
  }
  await checkpoint();
  if (originCount < total) return unavailable("insufficient-whitespace");

  let best = null;
  const consider = (indexes, strategy) => {
    if (indexes.length !== total) return;
    let minimum = Infinity, sum = 0;
    for (const index of indexes) { minimum = Math.min(minimum, clearance[index]); sum += clearance[index]; }
    if (!best || minimum > best.minimum || minimum === best.minimum && sum > best.sum)
      best = { indexes, strategy, minimum, sum };
  };
  const append = (indexes, x, y) => {
    // side includes every quiet-zone module. Outer boxes may touch, but neither
    // quiet zones nor QR ink overlap. Source padding is enforced separately.
    for (const index of indexes) if (Math.abs(index % width - x) < side && Math.abs(Math.floor(index / width) - y) < side) return;
    indexes.push(y * width + x);
  };
  // Eight bounded traversals, at most total <= 16 selected indexes per pass.
  for (const [axis, dx, dy] of TRAVERSALS) {
    const indexes = [], xStart = dx > 0 ? min : maxX, yStart = dy > 0 ? min : maxY;
    const outerStart = axis === "x" ? xStart : yStart, innerStart = axis === "x" ? yStart : xStart;
    const outerEnd = axis === "x" ? (dx > 0 ? maxX : min) : (dy > 0 ? maxY : min);
    const innerEnd = axis === "x" ? (dy > 0 ? maxY : min) : (dx > 0 ? maxX : min);
    const outerStep = axis === "x" ? dx : dy, innerStep = axis === "x" ? dy : dx;
    for (let outer = outerStart; (outer - outerEnd) * outerStep <= 0 && indexes.length < total; outer += outerStep) {
      for (let inner = innerStart; (inner - innerEnd) * innerStep <= 0 && indexes.length < total; inner += innerStep) {
        const x = axis === "x" ? outer : inner, y = axis === "x" ? inner : outer;
        if (clearance[y * width + x]) append(indexes, x, y);
      }
    }
    consider(indexes, `${axis},${dx},${dy}`);
    await checkpoint();
  }
  // One additional clearance-first traversal. Counting sort is bounded and
  // preserves row-major order for ties; it avoids sorting millions of objects.
  const offsets = new Uint32Array(counts.length), origins = new Uint32Array(originCount);
  let offset = 0;
  for (let radius = counts.length - 1; radius > 0; radius--) { offsets[radius] = offset; offset += counts[radius]; }
  for (let y = min; y <= maxY; y++) for (let x = min; x <= maxX; x++) {
    const index = y * width + x, radius = clearance[index];
    if (radius) origins[offsets[radius]++] = index;
  }
  const indexes = [];
  for (const index of origins) { append(indexes, index % width, Math.floor(index / width)); if (indexes.length === total) break; }
  consider(indexes, "clearance-first");
  await checkpoint();
  if (!best) return unavailable("insufficient-whitespace");
  const boxes = best.indexes.map(index => {
    const x = index % width, y = Math.floor(index / width);
    return { pixelX: x, pixelY: y, x: x / scale, y: (height - y - side) / scale, width: side / scale, height: side / scale };
  });
  return { status: "available", required, total, errorCorrectionLevel: "M", moduleSize,
    shards, symbols, boxes, margin, guard, scale, pageWidth: width / scale, pageHeight: height / scale,
    placementStrategy: best.strategy };
}

// Use only an unmodified plan returned above, on the page it was planned for.
// This helper does not replace optical preflight. Normal blending is safe here
// because all QR ink is in guarded whitespace; Multiply can round unrelated
// original gray pixels when a PDF renderer composites the page. Overlapping
// watermark layouts must retain their separate Multiply drawing behavior.
export function drawNonoverlapErasurePlan(page, plan) {
  if (plan?.status !== "available" || plan.symbols?.length !== plan.total || plan.boxes?.length !== plan.total ||
      (!Number.isInteger(plan.total) || plan.total > 16 || plan.total < 1) || plan.errorCorrectionLevel !== "M" ||
      !Number.isFinite(plan.moduleSize) || plan.moduleSize < 1.25 || plan.moduleSize > 3 || plan.scale !== 2 ||
      !Number.isFinite(plan.margin) || plan.margin < 36 || !Number.isFinite(plan.guard) || plan.guard < 2 ||
      page.getRotation().angle !== 0 || page.getWidth() !== plan.pageWidth || page.getHeight() !== plan.pageHeight)
    throw new Error("A matching available non-overlap plan is required");
  plan.symbols.forEach((symbol, i) => drawQrSymbol(page, symbol, plan.boxes[i], .85, false));
}
