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

// A shadowed print can have pale ink near 220 in one corner and near 170 in
// another, even after paper normalization. Calibrate both ink and foreground
// locally instead of calling all pixels below a fixed level opaque text.
// Only observed pixels enter this estimate, never expected document bytes.
export function classifyLocalModuleSamples({ values, size }, {
  shouldContinue = () => true,
} = {}) {
  const medians = new Uint8Array(size * size), cell = new Uint8Array(SAMPLES_PER_MODULE);
  for (let i = 0; i < medians.length; i++) {
    if (i % size === 0 && !shouldContinue()) return null;
    cell.set(values.subarray(i * SAMPLES_PER_MODULE, (i + 1) * SAMPLES_PER_MODULE));
    cell.sort();
    medians[i] = cell[Math.floor(SAMPLES_PER_MODULE / 2)];
  }
  const bits = new Uint8Array(size * size), unknown = new Uint8Array(bits.length);
  const confidence = new Uint8Array(bits.length), radius = 8;
  for (let row = 0; row < size; row++) {
    if (!shouldContinue()) return null;
    for (let col = 0; col < size; col++) {
      const neighbors = [];
      for (let y = Math.max(0, row - radius); y <= Math.min(size - 1, row + radius); y++)
        for (let x = Math.max(0, col - radius); x <= Math.min(size - 1, col + radius); x++)
          neighbors.push(medians[y * size + x]);
      neighbors.sort((a, b) => a - b);
      const paper = neighbors[Math.floor(neighbors.length * 0.85)];
      const exposed = neighbors.filter(value => value > paper * 0.65);
      let ink = exposed[Math.floor(exposed.length * 0.2)];
      let light = exposed[Math.floor(exposed.length * 0.8)];
      for (let iteration = 0; iteration < 5; iteration++) {
        const middle = (ink + light) / 2;
        let darkSum = 0, lightSum = 0, darkCount = 0, lightCount = 0;
        for (const value of exposed) {
          if (value < middle) { darkSum += value; darkCount++; }
          else { lightSum += value; lightCount++; }
        }
        if (darkCount) ink = darkSum / darkCount;
        if (lightCount) light = lightSum / lightCount;
      }
      const index = row * size + col, threshold = (ink + light) / 2;
      const foreground = ink * 0.9;
      let dark = 0, white = 0, missing = 0;
      for (let i = index * SAMPLES_PER_MODULE; i < (index + 1) * SAMPLES_PER_MODULE; i++) {
        if (values[i] < foreground) missing++;
        else if (values[i] < threshold) dark++;
        else white++;
      }
      const margin = Math.abs(dark - white);
      bits[index] = Number(dark > white);
      // Uniform/fully covered neighborhoods have no usable contrast.
      unknown[index] = Number(!exposed.length || light - ink < 8 || missing > 0 || margin < 5);
      confidence[index] = missing + Math.max(0, 5 - margin);
    }
  }
  return { bits, unknown, confidence, size };
}
