// Make a second OCR image of widely separated fields on one photographed
// line. Infer the gaps from its dark ink alone. Map every recognized word
// back to the original photo, including spaces that changed width.
export function spacePhotoLine({ data, width, height }) {
  if (width < height * 2 || width * height > 500000) return null;
  const gray = new Uint8Array(width * height), histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (data[4 * i] + data[4 * i + 1] + data[4 * i + 2]) / 3;
    histogram[gray[i]]++;
  }
  let paper = 255, count = histogram[paper];
  while (paper > 0 && count < gray.length * .1) count += histogram[--paper];
  if (!paper) return null;
  const columns = new Uint16Array(width);
  let first = height, last = -1;
  for (let y = 0; y < height; y++) {
    let dark = 0;
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] < paper * .545) { columns[x]++; dark++; }
    }
    if (dark >= 2) { first = Math.min(first, y); last = y; }
  }
  const inkHeight = last - first + 1;
  if (inkHeight < 6) return null;
  const minInk = Math.max(1, Math.round(inkHeight * .05));
  const gapWidth = Math.max(3, Math.round(inkHeight * .45));
  const spans = [];
  let start = 0, wideGap = false;
  for (let x = 0; x < width;) {
    if (columns[x] >= minInk) { x++; continue; }
    const left = x;
    while (x < width && columns[x] < minInk) x++;
    if (x - left < Math.max(3, Math.round(inkHeight * .2))) continue;
    if (left > start) spans.push({ left: start, right: left, length: left - start });
    if (left > 0 && x < width && x - left >= inkHeight) wideGap = true;
    spans.push({ left, right: x, length: gapWidth, gap: true });
    start = x;
  }
  if (!wideGap) return null;
  if (start < width) spans.push({ left: start, right: width, length: width - start });
  const pad = Math.max(2, Math.round(inkHeight * .22));
  const targetWidth = spans.reduce((sum, span) => sum + span.length, pad * 2), targetHeight = height + pad * 2;
  if (targetWidth * targetHeight > 500000) return null;
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4).fill(255);
  const sourceX = new Float32Array(targetWidth + 1);
  let offset = pad;
  for (const span of spans) {
    for (let dx = 0; dx < span.length; dx++) {
      const x = span.left + dx * (span.right - span.left) / span.length;
      sourceX[offset + dx] = x;
      if (span.gap) continue;
      for (let y = 0; y < height; y++) {
        const at = 4 * ((y + pad) * targetWidth + offset + dx);
        const value = (gray[y * width + span.left + dx] * 255 / paper - 84) * 255 / 86;
        output[at] = output[at + 1] = output[at + 2] = value;
      }
    }
    offset += span.length;
  }
  sourceX.fill(width, offset);
  return { data: output, width: targetWidth, height: targetHeight, sourceX, pad };
}
