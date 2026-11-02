// Erase only a working raster, after recovery. Keep the original page image
// for comparison and never infer a seal from PDF metadata or extracted text.
export function maskQrCode(data, width, height, code, offset = { x: 0, y: 0 }) {
  const points = ["topLeftCorner", "topRightCorner", "bottomLeftCorner", "bottomRightCorner"]
    .map(name => code.location?.[name])
    .map(point => point && { x: point.x + offset.x, y: point.y + offset.y });
  if (points.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) return false;
  const left = Math.max(0, Math.floor(Math.min(...points.map(point => point.x))) - 2);
  const right = Math.min(width, Math.ceil(Math.max(...points.map(point => point.x))) + 2);
  const top = Math.max(0, Math.floor(Math.min(...points.map(point => point.y))) - 2);
  const bottom = Math.min(height, Math.ceil(Math.max(...points.map(point => point.y))) + 2);
  let changed = false;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const i = (y * width + x) * 4;
    changed ||= data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255;
    data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 255;
  }
  return changed;
}

