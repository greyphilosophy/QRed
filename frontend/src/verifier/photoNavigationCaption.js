// The compact first-page navigation panel has a centered caption directly
// below its QR. An OCR near-match can suggest where to look, but only a
// decoded QRed URL establishes that the neighboring ink is a navigation code.
export async function locateNavigationCaption(canvas, words, codes, { pageNumber, prepareImage, signal }) {
  if (pageNumber !== 1) return null;
  let line;
  for (let i = 0; i + 2 < words.length; i++) {
    const [first, at, url] = words.slice(i, i + 3);
    if (!/^Veri[ft]y$/.test(first.text) || at.text !== "at" || url.text !== "qred.org") continue;
    // Multiple copies cannot establish which caption was printed by QRed.
    if (line) return null;
    const boxes = [first.bbox, at.bbox, url.bbox];
    if (boxes.some(b => !b || b.x1 <= b.x0 || b.y1 <= b.y0)) return null;
    const height = Math.max(...boxes.map(b => b.y1 - b.y0));
    if (boxes.some(b => Math.abs(b.y0 - first.bbox.y0) > height * .4) ||
        at.bbox.x0 < first.bbox.x1 || url.bbox.x0 < at.bbox.x1 ||
        at.bbox.x0 - first.bbox.x1 > height || url.bbox.x0 - at.bbox.x1 > height) return null;
    line = { indices: [i, i + 1, i + 2], x0: first.bbox.x0, x1: url.bbox.x1,
      y0: Math.min(...boxes.map(b => b.y0)), y1: Math.max(...boxes.map(b => b.y1)),
      tilt: Math.atan2(url.bbox.y1 - first.bbox.y1, url.bbox.x1 - first.bbox.x1) };
  }
  if (!line || Math.abs(line.tilt) > .12) return null;
  const width = line.x1 - line.x0;
  const centeredBelow = code => {
    const size = code.y1 - code.y0, gap = line.y0 - code.y1;
    return code.kind === "navigation" && gap >= size * .12 && gap <= size * .5 &&
      Math.abs(line.x0 + line.x1 - code.x0 - code.x1) <= size * .4 &&
      width >= size * 1.6 && width <= size * 2.8 && line.y1 - line.y0 < size * .4;
  };
  const found = codes.filter(code => code.kind === "navigation");
  if (found.length) return found.length === 1 && centeredBelow(found[0]) ? { line, code: found[0] } : null;
  const left = Math.max(0, Math.floor(line.x0 - width * .25)), top = Math.max(0, Math.floor(line.y0 - width));
  const right = Math.min(canvas.width, Math.ceil(line.x1 + width * .25));
  const height = Math.floor(line.y0) - top, cropWidth = right - left;
  if (height < 20 || cropWidth < 20 || cropWidth * height > 150000) return null;
  const crop = document.createElement("canvas");
  crop.width = cropWidth; crop.height = height;
  try {
    const context = crop.getContext("2d", { willReadFrequently: true });
    context.drawImage(canvas, left, top, cropWidth, height, 0, 0, cropWidth, height);
    const image = context.getImageData(0, 0, cropWidth, height), histogram = new Uint32Array(256);
    for (let i = 0; i < image.data.length; i += 4) {
      const gray = Math.round((image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3);
      histogram[gray]++; image.data[i] = gray;
    }
    // Dark QR modules occupy only part of this crop. The median samples paper.
    let count = 0, dark, paper;
    for (let gray = 0; gray < 256; gray++) {
      count += histogram[gray];
      if (dark === undefined && count >= cropWidth * height * .02) dark = gray;
      if (count >= cropWidth * height * .55) { paper = gray; break; }
    }
    if (paper - dark < 20) return null;
    const threshold = (dark + paper) / 2;
    for (let i = 0; i < image.data.length; i += 4)
      image.data[i] = image.data[i + 1] = image.data[i + 2] = image.data[i] < threshold ? 0 : 255;
    context.putImageData(image, 0, 0);
    const result = await prepareImage(crop, { signal });
    try {
      signal.throwIfAborted();
      const links = result.codes.filter(code => code.kind === "navigation");
      if (links.length !== 1) return null;
      const link = links[0], code = { kind: "navigation", x0: left + link.x0, y0: top + link.y0,
        x1: left + link.x1, y1: top + link.y1 };
      return centeredBelow(code) ? { line, code } : null;
    } finally { result.canvas.width = result.canvas.height = 0; }
  } finally { crop.width = crop.height = 0; }
}
