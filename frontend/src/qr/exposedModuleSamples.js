// Printed text can darken part of a pale QR module. Estimate the exposed level
// from its brighter samples and use the darker samples to measure occlusion.
const LEVEL_RADIUS = 6, TEXTURE_RADIUS = 5;
function reflect(i, size) {
  return i < 0 ? -i - 1 : i >= size ? 2 * size - i - 1 : i;
}

export function classifyExposedModules({ values, size }, shouldContinue = () => true) {
  const count = size * size, bright = new Float32Array(count), low = new Float32Array(count);
  const cell = new Uint8Array(25);
  for (let i = 0; i < count; i++) {
    if (i % size === 0 && !shouldContinue()) return null;
    cell.set(values.subarray(i * 25, i * 25 + 25));
    cell.sort();
    // 80th and 15th percentiles of the 5 by 5 interior sample.
    bright[i] = .8 * cell[19] + .2 * cell[20];
    low[i] = .4 * cell[3] + .6 * cell[4];
  }
  const bits = new Uint8Array(count), reliability = new Float32Array(count);
  const stride = size + 1, exposedInk = new Uint16Array(stride * stride);
  const windowWidth = LEVEL_RADIUS * 2 + 1, area = windowWidth ** 2;
  const histogram = new Uint16Array(256);
  for (let row = 0; row < size; row++) {
    if (!shouldContinue()) return null;
    histogram.fill(0);
    const rows = Array.from({ length: windowWidth }, (_, i) => reflect(row + i - LEVEL_RADIUS, size) * size);
    for (const start of rows) for (let x = -LEVEL_RADIUS; x <= LEVEL_RADIUS; x++)
      histogram[Math.round(bright[start + reflect(x, size)])]++;
    for (let col = 0; col < size; col++) {
      let sum = 0, ink = -1, paper = 0;
      for (let value = 0; value < 256; value++) {
        sum += histogram[value];
        if (ink < 0 && sum > .27 * area) ink = value;
        if (sum > .85 * area) { paper = value; break; }
      }
      const i = row * size + col, gap = Math.max(5, paper - ink);
      const level = (bright[i] - ink) / gap;
      const covered = Math.max(0, (ink - low[i]) / gap - .1);
      const distance = level - .58;
      bits[i] = Number(distance < 0);
      // Dark strokes within a cell and even its brightest samples falling
      // below pale ink both weaken the evidence for its underlying bit.
      const belowInk = Math.max(0, -level - .1);
      reliability[i] = Math.abs(distance) * Math.exp(-Math.min(4, covered) - belowInk);
      // A quiet white area around an overprinted graphic supplies little QR
      // evidence even when its white modules appear to have decisive votes.
      const exposed = Math.abs(level) < .42 && bright[i] - low[i] < .8 * gap && covered < .75;
      const at = (row + 1) * stride + col + 1;
      exposedInk[at] = Number(exposed) + exposedInk[at - 1] + exposedInk[at - stride] - exposedInk[at - stride - 1];
      const leaving = reflect(col - LEVEL_RADIUS, size), arriving = reflect(col + LEVEL_RADIUS + 1, size);
      for (const start of rows) {
        histogram[Math.round(bright[start + leaving])]--;
        histogram[Math.round(bright[start + arriving])]++;
      }
    }
  }
  const unknown = new Uint8Array(count);
  for (let row = 0; row < size; row++) {
    if (!shouldContinue()) return null;
    const top = Math.max(0, row - TEXTURE_RADIUS), bottom = Math.min(size, row + TEXTURE_RADIUS + 1);
    for (let col = 0; col < size; col++) {
      const left = Math.max(0, col - TEXTURE_RADIUS), right = Math.min(size, col + TEXTURE_RADIUS + 1);
      const ink = exposedInk[bottom * stride + right] - exposedInk[top * stride + right]
        - exposedInk[bottom * stride + left] + exposedInk[top * stride + left];
      const fraction = ink / ((bottom - top) * (right - left));
      const i = row * size + col;
      reliability[i] *= Math.max(.008, Math.min(1, fraction / .27));
      unknown[i] = Number(reliability[i] < .25);
    }
  }
  return { bits, unknown, reliability, size };
}
