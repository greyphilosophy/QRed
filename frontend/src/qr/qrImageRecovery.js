// QR image sampling — derive module matrix from photo geometry + luma

function lerp(a, b, t) { return a + ((b - a) * t); }

function sampleLuminance(imageData, width, height, x, y) {
  const clampedX = Math.max(0, Math.min(width - 1, Math.round(x)));
  const clampedY = Math.max(0, Math.min(height - 1, Math.round(y)));
  const index = ((clampedY * width) + clampedX) * 4;
  return (imageData[index] + imageData[index + 1] + imageData[index + 2]) / 3;
}

function moduleCenter(location, row, col, size, rowOffset = 0.5, colOffset = 0.5) {
  const v = (row + rowOffset) / size;
  const u = (col + colOffset) / size;
  const leftX = lerp(location.topLeftCorner.x, location.bottomLeftCorner.x, v);
  const leftY = lerp(location.topLeftCorner.y, location.bottomLeftCorner.y, v);
  const rightX = lerp(location.topRightCorner.x, location.bottomRightCorner.x, v);
  const rightY = lerp(location.topRightCorner.y, location.bottomRightCorner.y, v);
  return { x: lerp(leftX, rightX, u), y: lerp(leftY, rightY, u) };
}

function sampledModuleLuminance(imageData, width, height, location, row, col, size, rowOffset, colOffset) {
  const center = moduleCenter(location, row, col, size, rowOffset, colOffset);
  const samples = [
    sampleLuminance(imageData, width, height, center.x, center.y),
    sampleLuminance(imageData, width, height, center.x - 0.35, center.y),
    sampleLuminance(imageData, width, height, center.x + 0.35, center.y),
    sampleLuminance(imageData, width, height, center.x, center.y - 0.35),
    sampleLuminance(imageData, width, height, center.x, center.y + 0.35),
  ].sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

export function adaptiveThreshold(luminances) {
  const sorted = [...luminances].sort((a, b) => a - b);
  if (sorted.length === 0) return 128;
  const darkest = sorted[Math.floor(sorted.length * 0.1)];
  const lightest = sorted[Math.floor(sorted.length * 0.9)];
  return (darkest + lightest) / 2;
}

export function sampleQrMatrix(imageData, width, height, location, version, options = {}) {
  const size = 17 + (4 * version);
  const rowOffset = options.rowOffset ?? 0.5;
  const colOffset = options.colOffset ?? 0.5;
  const luminances = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      luminances.push(sampledModuleLuminance(imageData, width, height, location, row, col, size, rowOffset, colOffset));
    }
  }
  const threshold = options.threshold ?? adaptiveThreshold(luminances);
  const matrix = [];
  let index = 0;
  for (let row = 0; row < size; row += 1) {
    const line = [];
    for (let col = 0; col < size; col += 1) {
      line.push(luminances[index] < threshold);
      index += 1;
    }
    matrix.push(line);
  }
  return matrix;
}
