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
export function measureLocalModuleContrast({ values, size }, {
  shouldContinue = () => true, radius = 8,
} = {}) {
  const medians = new Uint8Array(size * size), cell = new Uint8Array(SAMPLES_PER_MODULE);
  for (let i = 0; i < medians.length; i++) {
    if (i % size === 0 && !shouldContinue()) return null;
    cell.set(values.subarray(i * SAMPLES_PER_MODULE, (i + 1) * SAMPLES_PER_MODULE));
    cell.sort();
    medians[i] = cell[Math.floor(SAMPLES_PER_MODULE / 2)];
  }
  const inkLevels = new Float64Array(size * size), paperLevels = new Float64Array(size * size);
  const histogram = new Uint16Array(256), counts = new Uint16Array(256), sums = new Uint32Array(256);
  for (let row = 0; row < size; row++) {
    if (!shouldContinue()) return null;
    histogram.fill(0);
    const top = Math.max(0, row - radius), bottom = Math.min(size - 1, row + radius);
    for (let y = top; y <= bottom; y++) for (let x = 0; x <= Math.min(size - 1, radius); x++)
      histogram[medians[y * size + x]]++;
    for (let col = 0; col < size; col++) {
      let count = 0, sum = 0;
      for (let value = 0; value < 256; value++) {
        count += histogram[value]; sum += value * histogram[value];
        counts[value] = count; sums[value] = sum;
      }
      const quantile = rank => {
        let value = 0;
        while (value < 255 && counts[value] <= rank) value++;
        return value;
      };
      const paper = quantile(Math.floor(count * 0.85));
      const excluded = Math.floor(paper * 0.65);
      const baseCount = counts[excluded], baseSum = sums[excluded];
      const exposed = count - baseCount, exposedSum = sum - baseSum;
      if (exposed) {
        let ink = quantile(baseCount + Math.floor(exposed * 0.2));
        let light = quantile(baseCount + Math.floor(exposed * 0.8));
        for (let iteration = 0; iteration < 5; iteration++) {
          const split = Math.max(excluded, Math.ceil((ink + light) / 2) - 1);
          const darkCount = counts[split] - baseCount, darkSum = sums[split] - baseSum;
          if (darkCount) ink = darkSum / darkCount;
          if (exposed > darkCount) light = (exposedSum - darkSum) / (exposed - darkCount);
        }
        inkLevels[row * size + col] = ink;
        paperLevels[row * size + col] = light;
      }
      // Slide the neighborhood rather than sorting hundreds of overlapping
      // observations again at every module. Integer histogram sums preserve
      // the same quantiles and two-cluster averages as the sorted samples.
      for (let y = top; y <= bottom; y++) {
        if (col - radius >= 0) histogram[medians[y * size + col - radius]]--;
        if (col + radius + 1 < size) histogram[medians[y * size + col + radius + 1]]++;
      }
    }
  }
  return { inkLevels, paperLevels };
}

// Reuse the measured local levels for a bounded nearby-threshold retry.
// Resampling can move antialiased strokes across the midpoint without
// changing the observed ink and paper clusters or the measured QR geometry.
export function classifyLocalModuleSamples(samples, {
  shouldContinue = () => true, contrast = null, thresholdFraction = 0.5,
} = {}) {
  const { values, size } = samples;
  contrast ??= measureLocalModuleContrast(samples, { shouldContinue });
  if (!contrast) return null;
  const { inkLevels, paperLevels } = contrast;
  const bits = new Uint8Array(size * size), unknown = new Uint8Array(bits.length);
  const confidence = new Uint8Array(bits.length);
  for (let row = 0; row < size; row++) {
    if (!shouldContinue()) return null;
    for (let col = 0; col < size; col++) {
      const index = row * size + col, ink = inkLevels[index], light = paperLevels[index];
      const threshold = ink + (light - ink) * thresholdFraction;
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
      unknown[index] = Number(light - ink < 8 || missing > 0 || margin < 5);
      confidence[index] = missing + Math.max(0, 5 - margin);
    }
  }
  return { bits, unknown, confidence, size };
}

// One bounded edge-emphasis retry for camera/resize interpolation. Work only
// from measured luminance: no expected QR bits or source document are used.
// The retained photo and the ordinary native observations remain unchanged.
export function sharpenModuleLuminance(gray, width, height, { shouldContinue = () => true } = {}) {
  if (!shouldContinue()) return null;
  const sharpened = gray.slice();
  for (let y = 1; y < height - 1; y++) {
    if (!shouldContinue()) return null;
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const neighbors = (gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width]) / 4;
      sharpened[i] = Math.max(0, Math.min(255, Math.round(2 * gray[i] - neighbors)));
    }
  }
  return sharpened;
}
