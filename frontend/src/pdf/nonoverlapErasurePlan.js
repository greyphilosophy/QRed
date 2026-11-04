import { encodeErasureChunks } from "../erasureTransport.js";
import { decodeEnvelope, sealString } from "../sealFormat.js";
import { createQRedQrSymbol } from "../qredQr.js";

// Opt-in planning only. Never changes the default layout or silently reduces
// evidence, module size, ECC, page size, or source content to force a fit.
// A caller must keep its ordinary seal/layout on every unavailable result and
// must additionally preflight optical recovery before using an available plan.
export async function planNonoverlapErasure(image, record, {
  required = 12, total = 16, moduleSize = 1.25, margin = 36, guard = 2,
} = {}) {
  const unavailable = reason => ({ status: "unavailable", reason });
  const { width, height, data, scale } = image || {};
  if (image?.rotation !== 0 || image?.userUnit !== 1 || image?.bounds?.x !== 0 || image?.bounds?.y !== 0 ||
      image.bounds.width * scale !== width || image.bounds.height * scale !== height ||
      scale !== 2 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width * height > 3_000_000 || data?.length !== width * height * 4) return unavailable("unsupported-render");
  if (!Number.isFinite(moduleSize) || moduleSize < 1.25 || moduleSize > 3 ||
      !Number.isFinite(margin) || margin < 18 || !Number.isFinite(guard) || guard < 2) return unavailable("invalid-placement-policy");
  let shards, symbols;
  try {
    decodeEnvelope(record);
    shards = await encodeErasureChunks(record, { required, total });
    symbols = shards.map(bytes => createQRedQrSymbol(sealString(bytes), { errorCorrectionLevel: "M" }));
  } catch { return unavailable("transport-capacity"); }
  const size = Math.max(...symbols.map(symbol => symbol.modules.size + 8)) * moduleSize;
  const side = Math.ceil(size * scale), padding = Math.ceil(guard * scale), inset = Math.ceil(margin * scale);
  if (side + 2 * (inset + padding) > Math.min(width, height)) return unavailable("insufficient-whitespace");
  const stride = width + 1, integral = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      // Even faint original ink and antialiased edges count as occupied.
      row += Number(data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255 || data[offset + 3] !== 255);
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const boxes = [];
  for (let y = inset + padding; y + side + padding + inset <= height && boxes.length < total; y++) {
    for (let x = inset + padding; x + side + padding + inset <= width && boxes.length < total; x++) {
      const x0 = x - padding, y0 = y - padding, x1 = x + side + padding, y1 = y + side + padding;
      if (integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0]) continue;
      if (boxes.some(box => Math.abs(box.pixelX - x) < side + padding && Math.abs(box.pixelY - y) < side + padding)) continue;
      boxes.push({ pixelX: x, pixelY: y, x: x / scale, y: (height - y - side) / scale,
        width: side / scale, height: side / scale });
    }
  }
  if (boxes.length !== total) return unavailable("insufficient-whitespace");
  return { status: "available", required, total, errorCorrectionLevel: "M", moduleSize,
    shards, symbols, boxes, margin, guard, scale };
}
