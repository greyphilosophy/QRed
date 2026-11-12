// Dates are selected by their format. The OCR pass receives only photographed pixels.
export const isDateReading = text => /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/u.test(text);

export function disputedDateFields(words, differences) {
  const fields = [];
  for (const difference of differences) {
    const dates = (difference.expected.match(/\d+(?:[-/.]\d+){2,}/gu) || []).filter(isDateReading);
    if (!dates.length) continue;
    const indices = difference.wordIndices.filter(i => {
      const word = words[i];
      // A lost separator can leave one long digit group. A decimal amount
      // beside a date must still go through its own ordinary comparison.
      return word?.bbox && (isDateReading(word.text) || /^\d{1,4}[-/]\d{3,4}$/u.test(word.text));
    });
    for (const i of indices) {
      if (!dates.includes(words[i].text)) fields.push({ wordIndices: [i], bbox: words[i].bbox,
        dateField: true, signedDate: dates.length === 1 && indices.length === 1 ? dates[0] : undefined });
    }
  }
  return fields;
}

function percentile(histogram, index) {
  for (let level = 0; level < 255; level++) {
    index -= histogram[level];
    if (index < 0) return level;
  }
  return 255;
}

export function dateReadingCanvas(source, box, pixelLimit) {
  const width = box.x1 - box.x0, height = box.y1 - box.y0;
  if (width <= 0 || height <= 0 || pixelLimit <= 0) return null;
  // Enlarge the isolated field and supply white space for single-line OCR.
  const fit = Math.min(1, Math.sqrt(pixelLimit / ((width * 3 + 28) * (height * 3 + 28))));
  const scaledWidth = Math.floor(width * 3 * fit), scaledHeight = Math.floor(height * 3 * fit);
  const pad = Math.floor(14 * fit);
  if (scaledWidth < 1 || scaledHeight < 1) return null;
  const crop = document.createElement("canvas");
  crop.width = Math.min(width, scaledWidth); crop.height = Math.min(height, scaledHeight);
  try {
    const ctx = crop.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, box.x0, box.y0, width, height, 0, 0, crop.width, crop.height);
    const image = ctx.getImageData(0, 0, crop.width, crop.height);
    const { data } = image, histogram = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
      const value = Math.round(.299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2]);
      histogram[value]++; data[i] = value;
    }
    // In a padded word crop the median samples paper. The dark tail samples
    // the ink. Leave shadow detail in the strokes when lifting pale overprint.
    const last = data.length / 4 - 1;
    const dark = percentile(histogram, Math.floor(last * .02));
    const white = percentile(histogram, Math.floor(last * .5));
    if (white - dark < 8) return null;
    const black = dark - .45 * (white - dark);
    for (let i = 0; i < data.length; i += 4)
      data[i] = data[i + 1] = data[i + 2] = (data[i] - black) * 255 / (white - black);
    ctx.putImageData(image, 0, 0);
    const detail = document.createElement("canvas");
    detail.width = scaledWidth + 2 * pad; detail.height = scaledHeight + 2 * pad;
    const output = detail.getContext("2d");
    output.fillStyle = "white"; output.fillRect(0, 0, detail.width, detail.height);
    output.imageSmoothingQuality = "high"; output.drawImage(crop, pad, pad, scaledWidth, scaledHeight);
    return detail;
  } finally { crop.width = crop.height = 0; }
}
