import { locatePaper } from "./pageAlignedScan.js";
import { estimatePaperColor } from "./paperColor.js";
import { curvedPaperMapping } from "./curvedPaper.js";

// Capture guidance, never a text/authenticity verdict. In particular, blurred
// printing must not be rejected because OCR cannot read it. Measure the physical
// paper boundary and movement; retain the original frame without stacking it.
export const STEADY_CAPTURE_MS = 600;
const MAX_PREVIEW_SIDE = 480;
const FRAME_MARGIN = .025;
const MAX_CORNER_MOTION = .012;
const MAX_FRAME_GAP_MS = 1500;
const PAGE_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function insideFrame(corners, margin) {
  return corners.every(p => p.x >= margin && p.y >= margin && p.x <= 1 - margin && p.y <= 1 - margin);
}

function moveBack(corners) {
  return { state: "framing", message: "Move back slightly to include all four page corners.", corners };
}

function preview(image) {
  const scale = Math.min(1, MAX_PREVIEW_SIDE / Math.max(image.width, image.height));
  if (scale === 1) return image;
  const width = Math.round(image.width * scale), height = Math.round(image.height * scale);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4;
    const target = (y * width + x) * 4;
    data[target] = image.data[source]; data[target + 1] = image.data[source + 1];
    data[target + 2] = image.data[source + 2]; data[target + 3] = 255;
  }
  return { data, width, height };
}

function gray(image, x, y) {
  const at = (Math.max(0, Math.min(image.height - 1, Math.round(y))) * image.width
    + Math.max(0, Math.min(image.width - 1, Math.round(x)))) * 4;
  return image.data[at] * .299 + image.data[at + 1] * .587 + image.data[at + 2] * .114;
}

function percentile(values, fraction) {
  return values.sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)] || 0;
}

// Measure edge spread on the guidance frame. Corner detection uses a smaller
// thumbnail. The paper boundary supplies a focus signal even on a blank sheet.
function measureBoundary(image, corners, mapping) {
  const step = Math.max(1, Math.min(image.width, image.height) / 720);
  const sides = [], edgeSigns = [];
  for (let side = 0; side < 4; side++) {
    const a = corners[side], b = corners[(side + 1) % 4], length = distance(a, b);
    const [u, v] = PAGE_CORNERS[side], [nextU, nextV] = PAGE_CORNERS[(side + 1) % 4];
    const nx = (b.y - a.y) / length, ny = (a.x - b.x) / length;
    const scores = [];
    let lighter = 0, darker = 0;
    for (let point = 1; point <= 16; point++) {
      const t = .12 + point / 17 * .76;
      const { x, y } = mapping ? mapping(u + (nextU - u) * t, v + (nextV - v) * t)
        : { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const samples = [];
      for (let offset = -8; offset <= 8; offset++) samples.push(gray(image, x + nx * offset * step, y + ny * offset * step));
      // A sheet edge has a consistent change from outside to inside. Text
      // near a falsely detected edge can be sharp but varies in both directions.
      const change = (samples[0] + samples[2] + samples[4] - samples[12] - samples[14] - samples[16]) / 3;
      if (change >= 12) lighter++;
      if (change <= -12) darker++;
      const contrast = Math.abs(samples.at(-1) - samples[0]);
      if (contrast < 12) continue;
      let largest = 0;
      for (let i = 1; i < samples.length; i++) largest = Math.max(largest, Math.abs(samples[i] - samples[i - 1]));
      scores.push(Math.min(1, largest / contrast));
    }
    sides.push(scores.length >= 6 ? percentile(scores, .5) : 0);
    edgeSigns.push(lighter >= 10 ? 1 : darker >= 10 ? -1 : 0);
  }
  return { sharpness: percentile(sides, .25), consistent: edgeSigns[0] !== 0 && edgeSigns.every(sign => sign === edgeSigns[0]) };
}

function samplePage(image, corners) {
  const [tl, tr, br, bl] = corners, values = [];
  // Tiny shifts can move a single sample from paper to a printed module or
  // letter on the same page. Compare local average tones between video frames.
  const step = Math.max(1, Math.min(image.width, image.height) / 320);
  for (let row = 0; row < 16; row++) for (let col = 0; col < 16; col++) {
    const u = (col + .5) / 16, v = (row + .5) / 16;
    const x = (tl.x * (1-u) + tr.x * u) * (1-v) + (bl.x * (1-u) + br.x * u) * v;
    const y = (tl.y * (1-u) + tr.y * u) * (1-v) + (bl.y * (1-u) + br.y * u) * v;
    let sum = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      sum += gray(image, x + dx * step, y + dy * step);
    values.push(sum / 25);
  }
  return values;
}

function assessOutline(image, corners, captureOnly, margin, mapping) {
  if (!insideFrame(corners, margin)) return moveBack(corners);
  const pixels = corners.map(p => ({ x: p.x * image.width, y: p.y * image.height }));
  const width = (distance(pixels[0], pixels[1]) + distance(pixels[2], pixels[3])) / 2;
  const height = (distance(pixels[0], pixels[3]) + distance(pixels[1], pixels[2])) / 2;
  // A native still is validated separately for document detail. Its video
  // preview only guides framing and focus, and can be much smaller than the
  // photograph. Requiring 420 preview pixels makes capture impossible on
  // low-resolution streams, even while a well-framed page fills the view.
  const minimumSide = captureOnly ? Math.min(420, Math.min(image.width, image.height) * .6) : 420;
  if (Math.min(width, height) < minimumSide || width * height < image.width * image.height * .28)
    return { state: "small", message: "Move closer while keeping all four corners visible.", corners };
  const samples = samplePage(image, pixels);
  if (percentile([...samples], .8) < 65)
    return { state: "dark", message: "More light may help. You can also use Capture now.", corners };
  const { sharpness } = measureBoundary(image, pixels, mapping);
  if (sharpness < .45)
    return { state: "soft", message: "The page edges look soft. Hold steady for focus, or use Capture now.", corners, sharpness };
  return { state: "clear", corners, sharpness, samples };
}

export function inspectPageFrame(image, { captureOnly = false } = {}, margin = FRAME_MARGIN) {
  if (!image?.data || image.data.length !== image.width * image.height * 4 || image.width < 40 || image.height < 40)
    return { state: "framing", message: "Waiting for camera frames…", corners: null };
  const small = preview(image);
  const found = locatePaper({ ...small, paperColor: estimatePaperColor(small) });
  if (!found) return { state: "framing", message: "Show all four page corners. Try a contrasting background, or use Capture now.", corners: null };
  const corners = found.map(p => ({ x: p.x / small.width, y: p.y / small.height }));
  const initial = assessOutline(image, corners, captureOnly, margin);
  if (!captureOnly || (initial.state !== "soft" && initial.state !== "small")) return initial;
  if (initial.state === "small") {
    const pixels = corners.map(p => ({ x: p.x * image.width, y: p.y * image.height }));
    if (measureBoundary(image, pixels).consistent) return initial;
  }
  // Mixed illumination can make only the middle of a sheet look like paper.
  // Check the other outline against the same framing, light and focus criteria.
  const mapping = curvedPaperMapping(image);
  if (!mapping) return initial;
  const curvedCorners = PAGE_CORNERS.map(([u, v]) => {
    const p = mapping(u, v);
    return { x: p.x / image.width, y: p.y / image.height };
  });
  const curved = assessOutline(image, curvedCorners, captureOnly, margin, mapping);
  return curved.state === "clear" ? curved : initial;
}

export function createPageCaptureGate() {
  let anchor = null, lastAt = null, startedAt = null, frames = 0, captured = false;
  return {
    update(image, now, options) {
      const continuous = anchor && now >= lastAt && now - lastAt <= MAX_FRAME_GAP_MS;
      // Start a hold with the full border. Let the same tracked page use its
      // existing movement allowance without resetting on a few pixels of sway.
      const margin = continuous ? FRAME_MARGIN - MAX_CORNER_MOTION : FRAME_MARGIN;
      const measured = inspectPageFrame(image, options, margin);
      let { samples, ...quality } = measured;
      // After capture, a small change in the printing can identify a new page.
      const moved = quality.state === "clear" && (!anchor
        || quality.corners.some((p, i) => distance(p, anchor.corners[i]) > MAX_CORNER_MOTION)
        || samples.reduce((sum, value, i) => sum + Math.abs(value - anchor.samples[i]), 0)
          / samples.length > (captured ? 2 : 9));
      // A changed scene needs to qualify on its own before another hold starts.
      if (moved && !insideFrame(quality.corners, FRAME_MARGIN)) quality = moveBack(quality.corners);
      if (quality.state !== "clear") {
        anchor = null; startedAt = null; frames = 0; lastAt = now; captured = false;
        return { ...quality, ready: false, progress: 0 };
      }
      if (captured && !moved) return { ...quality, ready: false, progress: 0, state: "captured",
        message: "Move the page to capture again, or use Capture now." };
      if (moved || !continuous) {
        anchor = measured; startedAt = now; frames = 0; captured = false;
      }
      lastAt = now; frames++;
      const progress = Math.min(1, (now - startedAt) / STEADY_CAPTURE_MS, frames / 4);
      if (progress === 1) captured = true;
      return { ...quality, ready: progress === 1, progress, state: progress === 1 ? "ready" : "hold",
        message: progress === 1 ? "Page steady. Hold still for the photo…" : "Hold steady — capturing automatically…" };
    },
  };
}
