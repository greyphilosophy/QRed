// Read only an isolated gap or a measured mark from the untouched camera image.
// An absent mark, a joined stroke or a clipped crop supplies no corroboration.
function inkBands(canvas, box) {
  const x = Math.floor(box.x0), y = Math.floor(box.y0);
  const width = Math.ceil(box.x1) - x, height = Math.ceil(box.y1) - y;
  if (!canvas?.getContext || ![x, y, width, height].every(Number.isFinite) ||
      width < 3 || height < 5 || width > 64 || height > 96 ||
      x < 0 || y < 0 || x + width > canvas.width || y + height > canvas.height) return [];
  const pixels = canvas.getContext("2d")?.getImageData?.(x, y, width, height)?.data;
  if (!pixels || pixels.length !== width * height * 4) return [];
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++)
    gray[i] = (pixels[4 * i] + 2 * pixels[4 * i + 1] + pixels[4 * i + 2]) / 4;
  const levels = gray.slice().sort(), paper = levels[Math.floor(levels.length * .75)];
  if (paper - levels[0] < 32) return [];
  const threshold = (paper + levels[0]) / 2;
  const bands = [];
  for (let row = 0; row < height; row++) {
    let band = bands.at(-1);
    for (let col = 0; col < width; col++) {
      if (gray[row * width + col] >= threshold) continue;
      if (!band || band.y1 < y + row - 1) {
        band = { x0: x + col, x1: x + col, y0: y + row, y1: y + row, count: 0 };
        bands.push(band);
      }
      band.x0 = Math.min(band.x0, x + col); band.x1 = Math.max(band.x1, x + col);
      band.y1 = y + row; band.count++;
    }
  }
  return bands;
}

function compactDot(dot, limit, minAspect = .65, minFill = .55) {
  const w = dot.x1 - dot.x0 + 1, h = dot.y1 - dot.y0 + 1;
  return dot.count >= 3 && w <= limit && h <= limit && w >= h * minAspect && w <= h * 1.8 && dot.count >= w * h * minFill;
}

export function photographedColon(canvas, box) {
  if (!box) return false;
  const height = box.y1 - box.y0;
  if (height < 6 || box.x1 - box.x0 > height * .48) return false;
  const pad = Math.max(2, height * .2);
  const dots = inkBands(canvas, { x0: box.x0 - pad, x1: box.x1 + pad, y0: box.y0 - pad, y1: box.y1 + pad });
  if (dots.length !== 2 || !compactDot(dots[0], height * .42, .5) || !compactDot(dots[1], height * .42)) return false;
  const [top, bottom] = dots;
  return Math.abs(top.y0 - box.y0) < pad && Math.abs(bottom.y1 + 1 - box.y1) < pad &&
    Math.abs((top.x0 + top.x1 - bottom.x0 - bottom.x1) / 2) < Math.max(2, height * .12) &&
    bottom.y0 - top.y1 > height * .25;
}

// OCR sometimes places a faint label separator just outside the last letter's
// box. Require the edge of the letter as well as both dots in the following gap.
export function photographedLabelColon(canvas, label, next) {
  if (!label || !next || label.x1 >= next.x0 || label.y1 <= next.y0 || label.y0 >= next.y1) return false;
  const h = label.y1 - label.y0;
  if (h < 8 || label.x1 - label.x0 < h) return false;
  const edge = inkBands(canvas, { x0: label.x1 - 3, x1: label.x1 + 1,
    y0: label.y0 - h * .2, y1: label.y1 + h * .2 });
  if (!edge.some(part => part.y1 - part.y0 >= h * .45)) return false;
  const dots = inkBands(canvas, { x0: label.x1 + 1, x1: Math.min(next.x0 - 1, label.x1 + h * .85),
    y0: label.y0 - h * .1, y1: label.y1 + h * .2 }).filter(dot => dot.count > 1);
  if (dots.length !== 2 || !compactDot(dots[0], h * .32, .65, .4) || !compactDot(dots[1], h * .32)) return false;
  const [top, bottom] = dots;
  return bottom.y0 - top.y1 > h * .2 && top.y0 > label.y0 - h * .1 &&
    Math.abs(label.y1 - bottom.y1) < h * .3 &&
    Math.abs(top.x0 + top.x1 - bottom.x0 - bottom.x1) <= Math.max(3, h * .2);
}

export function photographedPeriod(canvas, left, right) {
  if (!left || !right) return false;
  const height = Math.max(left.y1 - left.y0, right.y1 - right.y0);
  const baseline = Math.min(left.y1, right.y1), gap = right.x0 - left.x1;
  if (gap < 4 || gap > height * .8 || Math.abs(left.y1 - right.y1) > height * .4) return false;
  const inset = Math.max(1, Math.round(gap * .22));
  const box = { x0: left.x1 + inset, x1: right.x0 - inset, y0: baseline - height * .9, y1: baseline + height * .3 };
  const dots = inkBands(canvas, box).filter(dot => dot.count > 1);
  if (dots.length !== 1 || !compactDot(dots[0], height * .28)) return false;
  const dot = dots[0];
  return dot.x0 > left.x1 && dot.x1 < right.x0 - 1 &&
    Math.abs((dot.y0 + dot.y1) / 2 - baseline) <= height * .25;
}
