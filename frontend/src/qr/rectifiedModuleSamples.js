const OFFSETS = [-0.3, -0.15, 0, 0.15, 0.3];
const SAMPLES_PER_MODULE = OFFSETS.length ** 2;

// Geometry is independent of the ink/foreground thresholds. Read it once
// per candidate grid and reuse these observations for every threshold retry.
// This buffer is local to one scan; it never changes the retained photo.
export function collectModuleSamples(gray, width, height, moduleMap, version) {
  const size = 17 + 4 * version, values = new Uint8Array(size * size * SAMPLES_PER_MODULE);
  let index = 0;
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++)
    for (const dy of OFFSETS) for (const dx of OFFSETS) {
      const p = moduleMap(col + 0.5 + dx, row + 0.5 + dy);
      const x = Math.round(p.x), y = Math.round(p.y);
      values[index++] = x < 0 || y < 0 || x >= width || y >= height ? 0 : gray[y * width + x];
    }
  return { values, size };
}

// Vote only exposed pixels. Dark text and ambiguous votes remain erasures;
// QR parity must resolve them before the normal signature check can succeed.
export function classifyModuleSamples({ values, size }, threshold, foreground) {
  const bits = new Uint8Array(size * size), unknown = new Uint8Array(bits.length);
  const confidence = new Uint8Array(bits.length);
  for (let index = 0; index < bits.length; index++) {
    let dark = 0, light = 0, missing = 0;
    const start = index * SAMPLES_PER_MODULE;
    for (let i = start; i < start + SAMPLES_PER_MODULE; i++) {
      const value = values[i];
      if (value < foreground) missing++;
      else if (value < threshold) dark++;
      else light++;
    }
    const margin = Math.abs(dark - light);
    bits[index] = Number(dark > light);
    unknown[index] = Number(missing > 0 || margin < 5);
    confidence[index] = missing + Math.max(0, 5 - margin);
  }
  return { bits, unknown, confidence, size };
}
