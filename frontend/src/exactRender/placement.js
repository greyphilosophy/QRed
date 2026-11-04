import { EXACT_SIDE, assertWhiteRegions, validateExactImage } from "./evidence.js";

// Fixed-size reservations are selected from source pixels BEFORE signing.
// No payload, private key, OCR, tolerance or favorable signature reroll enters
// this bounded placement policy. Failure does not silently switch layout.
export async function chooseExactBoxes(image, { signal } = {}) {
  validateExactImage(image); signal?.throwIfAborted();
  const { width, height, data } = image, side = EXACT_SIDE, guard = 4, inset = 72, stride = width + 1;
  const integral = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    if (y % 64 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted(); }
    let row = 0;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      row += Number(data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255 || data[offset + 3] !== 255);
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const clear = (x, y) => {
    const left = x - guard, top = y - guard, right = x + side + guard, bottom = y + side + guard;
    return integral[bottom * stride + right] - integral[top * stride + right] - integral[bottom * stride + left] + integral[top * stride + left] === 0;
  };
  const minimum = inset + guard, maxX = width - side - guard - inset, maxY = height - side - guard - inset;
  for (const axis of ["x", "y"]) for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
    await new Promise(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted();
    const boxes = [], xStart = dx > 0 ? minimum : maxX, yStart = dy > 0 ? minimum : maxY;
    const outerStart = axis === "x" ? xStart : yStart, innerStart = axis === "x" ? yStart : xStart;
    const outerEnd = axis === "x" ? (dx > 0 ? maxX : minimum) : (dy > 0 ? maxY : minimum);
    const innerEnd = axis === "x" ? (dy > 0 ? maxY : minimum) : (dx > 0 ? maxX : minimum);
    const outerStep = axis === "x" ? dx : dy, innerStep = axis === "x" ? dy : dx;
    if (maxX < minimum || maxY < minimum) break;
    for (let outer = outerStart; (outer - outerEnd) * outerStep <= 0; outer += outerStep) {
      if (Math.abs(outer - outerStart) % 64 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted(); }
      for (let inner = innerStart; (inner - innerEnd) * innerStep <= 0; inner += innerStep) {
        const x = axis === "x" ? outer : inner, y = axis === "x" ? inner : outer;
        if (!clear(x, y) || boxes.some(box => Math.abs(box[0] - x) < side && Math.abs(box[1] - y) < side)) continue;
        boxes.push([x, y, side, side]);
        if (boxes.length === 16) { assertWhiteRegions(image, boxes); return boxes; }
      }
    }
  }
  throw new Error("This PDF page has insufficient completely white space for sixteen exact-render seals. No output was produced.");
}
