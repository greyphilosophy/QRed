function percentile(histogram, size, fraction) {
  let remaining = Math.floor(size * fraction);
  for (let i = 0; i < histogram.length; i++) {
    remaining -= histogram[i];
    if (remaining < 0) return i;
  }
  return 255;
}

// Recognize the value separately only when the photograph has a narrow pair
// of dots before it. Return those dots' actual position for punctuation review.
function separateFieldValue(gray, columns, width, height, inkHeight, threshold) {
  const runs = [];
  for (let x = 0; x < width; x++) {
    if (columns[x] < 2) continue;
    const previous = runs[runs.length - 1];
    if (previous && x - previous.right < inkHeight * .3) previous.right = x;
    else runs.push({ left: x, right: x });
  }
  if (runs.length < 3) return null;
  const mark = runs.shift();
  if (mark.right - mark.left + 1 > inkHeight * .4) return null;
  const rows = [];
  for (let y = 0; y < height; y++) {
    if (!gray.subarray(y * width + mark.left, y * width + mark.right + 1).some(pixel => pixel < threshold)) continue;
    const dot = rows[rows.length - 1];
    if (dot && dot.end === y - 1) dot.end = y;
    else rows.push({ start: y, end: y });
  }
  if (rows.length !== 2 || rows.some(dot => dot.end - dot.start + 1 > inkHeight * .35) ||
      rows[1].start - rows[0].end < inkHeight * .15) return null;
  const spans = [];
  // Keep stroke edges without letting the padding cross another group.
  const margin = Math.min(2, Math.floor((Math.ceil(inkHeight * .3) - 1) / 2));
  for (const run of runs) {
    const left = Math.max(0, run.left - margin), right = Math.min(width, run.right + margin + 1);
    if (spans.length) spans.push({ left: spans[spans.length - 1].right, right: left, length: inkHeight, gap: true });
    spans.push({ left, right, length: right - left });
  }
  return { spans, separator: { x0: mark.left, x1: mark.right + 1, y0: rows[0].start, y1: rows[1].end + 1 } };
}

// Make a second OCR image of widely separated fields on one photographed
// line. Infer the gaps from its dark ink alone. Map every recognized word
// back to the original photo, including spaces that changed width.
export function spacePhotoLine({ data, width, height }, separatedValue = false) {
  if (width < height * 2 || width * height > 500000) return null;
  const gray = new Uint8Array(width * height), histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (data[4 * i] + data[4 * i + 1] + data[4 * i + 2]) / 3;
    histogram[gray[i]]++;
  }
  const paper = percentile(histogram, gray.length, separatedValue ? .5 : .9);
  const black = separatedValue ? percentile(histogram, gray.length, .02) : 0;
  if (paper <= black) return null;
  const threshold = separatedValue ? (paper + black) / 2 : paper * .545;
  const columns = new Uint16Array(width);
  let first = height, last = -1;
  for (let y = 0; y < height; y++) {
    let dark = 0;
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] < threshold) { columns[x]++; dark++; }
    }
    if (dark >= 2) { first = Math.min(first, y); last = y; }
  }
  const inkHeight = last - first + 1;
  if (inkHeight < 6) return null;
  let separator, spans = [];
  if (separatedValue) {
    const field = separateFieldValue(gray, columns, width, height, inkHeight, threshold);
    if (!field) return null;
    ({ spans, separator } = field);
  } else {
    const minInk = Math.max(1, Math.round(inkHeight * .05));
    const gapWidth = Math.max(3, Math.round(inkHeight * .45));
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
  }
  const pad = separatedValue ? Math.max(4, Math.round(inkHeight * .4)) : Math.max(2, Math.round(inkHeight * .22));
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
        const pixel = gray[y * width + span.left + dx];
        const value = separatedValue ? (pixel - black) * 300 / (paper - black) : (pixel * 255 / paper - 84) * 255 / 86;
        output[at] = output[at + 1] = output[at + 2] = value;
      }
    }
    offset += span.length;
  }
  sourceX.fill(width, offset);
  return { data: output, width: targetWidth, height: targetHeight, sourceX, pad, separator };
}
