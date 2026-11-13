import { describe, expect, it } from "vitest";
import { createPageCaptureGate, pageScanQualityFeedback, inspectPageFrame, STEADY_CAPTURE_MS } from "./pageCaptureQuality.js";

function paper({ x = 90, y = 100, width = 600, height = 800, desk = 55, ink = false, blur = 0 } = {}) {
  const image = { width: 800, height: 1000, data: new Uint8ClampedArray(800 * 1000 * 4) };
  for (let row = 0; row < image.height; row++) for (let col = 0; col < image.width; col++) {
    const offset = (row * image.width + col) * 4;
    const edgeDistance = Math.min(col - x, x + width - col, row - y, y + height - row);
    const coverage = blur ? 1 / (1 + Math.exp(-edgeDistance / blur)) : edgeDistance >= 0 ? 1 : 0;
    let value = desk + (245 - desk) * coverage;
    // An intentionally unreadable block of printing must not prevent capture.
    if (ink && col > x + 40 && col < x + width - 40 && row > y + 100 && row < y + 200) value = 130;
    image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = value;
    image.data[offset + 3] = 255;
  }
  return image;
}

// A generated, densely printed page with a mild bow and bright fabric folds.
function fabricPrint(shift = 0, striped = false) {
  const width = 720, height = 960, data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const x = (col - shift) / width, y = row / height;
    const u = (x - .145 + .017 * y) / .73;
    const v = (y - .07 - .013 * (2 * u - 1) ** 2 - .015 * u) / .78;
    const page = u >= 0 && u <= 1 && v >= 0 && v <= 1;
    const ridge = 62 * Math.max(0, Math.sin(41 * x + 11 * Math.sin(6 * y))) ** 12;
    const fold = 55 * Math.max(0, Math.cos(30 * y - 7 * x + Math.cos(24 * x))) ** 10;
    let light = 44 + 12 * Math.sin(13 * x + 8 * y) + ridge + fold;
    if (!page && striped && Math.floor((col - shift + row * .35) / 6) % 2) light += 25;
    if (page) {
      const pattern = Math.imul(Math.floor(u * 150), 73856093) ^ Math.imul(Math.floor(v * 185), 19349663);
      const ink = u > .075 && u < .925 && v > .07 && v < .93 && (pattern & 16);
      light = 186 + 10 * Math.cos(4 * u) - 42 * v - (ink ? 32 : 0);
    }
    const at = (row * width + col) * 4;
    data[at] = light * 1.17; data[at + 1] = light; data[at + 2] = light * .85; data[at + 3] = 255;
  }
  return { width, height, data };
}

function mixedLighting({ smallPage = false } = {}) {
  const width = 800, height = 1000, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x - 100) / 600, v = (y - 100) / 800;
    const at = (y * width + x) * 4;
    let r = 34, g = 45, b = 74;
    if (u >= 0 && u < 1 && v >= 0 && v < 1) {
      const radius = Math.hypot(u - .5, .93 * (v - .5));
      const fade = Math.max(0, Math.min(1, (radius - .265) / .14));
      g = smallPage ? 178 : 185 - 20 * fade;
      r = smallPage ? 142 : g * (1.13 - .18 * fade);
      b = smallPage ? 214 : g * (.86 + .25 * fade);
      if (smallPage && u > .18 && u < .82 && v > .17 && v < .83) {
        r = 220; g = 210; b = 199;
      }
    }
    data[at] = r; data[at + 1] = g; data[at + 2] = b; data[at + 3] = 255;
  }
  return { width, height, data };
}

describe("automatic whole-page capture", () => {
  it("waits for sharp printing inside an already sharp page outline", () => {
    const preview = soft => {
      const image = paper();
      for (let y = 170; y < 830; y++) for (let x = 145; x < 630; x++) {
        const distance = Math.cos(x * Math.PI / 10);
        const value = soft ? 165 + 78 * distance : distance > 0 ? 243 : 87;
        const i = 4 * (y * image.width + x);
        image.data.fill(value, i, i + 3);
      }
      return image;
    };
    const gate = createPageCaptureGate(), soft = preview(true), sharp = preview(false);
    for (const t of [0, 150, 300, 450]) {
      const quality = gate.update(soft, t, { captureOnly: true });
      expect(quality).toMatchObject({ state: "soft", ready: false });
      expect(quality.message).toContain("printing looks blurry");
    }
    const mapping = (u, v) => ({ x: 90 + 600 * u, y: 100 + 800 * v });
    expect(pageScanQualityFeedback(soft, mapping)).toContain("printing looks blurry");
    expect(pageScanQualityFeedback(sharp, mapping)).toBeNull();
    expect([600, 750, 900].map(t => gate.update(sharp, t, { captureOnly: true }).state))
      .toEqual(["hold", "hold", "ready"]);
  });

  it("asks to center a page with a large unused lower margin, then captures a closer page", () => {
    const high = paper({ x: 105, y: 35, width: 590, height: 710 });
    const close = paper({ x: 55, y: 55, width: 685, height: 890 });
    const gate = createPageCaptureGate();
    for (const t of [0, 150, 300]) {
      const quality = gate.update(high, t, { captureOnly: true });
      expect(quality).toMatchObject({ state: "small", ready: false });
      expect(quality.message).toContain("Center the page");
    }
    expect([450, 600, 750].map(t => gate.update(close, t, { captureOnly: true }).state))
      .toEqual(["hold", "hold", "ready"]);
    expect(pageScanQualityFeedback(high, (u, v) => ({ x: 105 + 590 * u, y: 35 + 710 * v }))).toContain("Center the page");
  });

  it("does not capture an interior printed grid when the sheet fills the entire frame", () => {
    const width = 360, height = 480, data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 35; y < 440; y++) for (let x = 33; x < 325; x++) {
      const ink = (Math.imul(Math.floor(x / 3), 73856093) ^ Math.imul(Math.floor(y / 3), 19349663)) & 16;
      const i = (y * width + x) * 4;
      data.fill(ink ? 164 : 253, i, i + 3);
    }
    // Repeat ink patches through the center of the print, leaving a white border.
    for (let row = 3; row <= 7; row++) for (let col = 3; col <= 7; col++) {
      const cx = Math.round((width - 1) * col / 10), cy = Math.round((height - 1) * row / 10);
      for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
        const i = (y * width + x) * 4;
        data.fill(164, i, i + 3);
      }
    }
    const gate = createPageCaptureGate();
    for (const t of [0, 150, 300, 450])
      expect(gate.update({ width, height, data }, t, { captureOnly: true })).toMatchObject({ state: "framing", ready: false });
  });

  it("guides a dim watermark into better light and captures as soon as exposure recovers", () => {
    const dim = fabricPrint(), bright = fabricPrint(), gate = createPageCaptureGate();
    for (let i = 0; i < dim.data.length; i += 4)
      for (let c = 0; c < 3; c++) dim.data[i+c] = Math.round(.67 * dim.data[i+c]);
    for (const t of [0, 150, 300, 450]) {
      const value = gate.update(dim, t, { captureOnly: true });
      expect(value).toMatchObject({ state: "dark", ready: false });
      expect(value.message).toContain("Add light");
    }
    expect([600, 750, 900].map(t => gate.update(bright, t, { captureOnly: true }).state)).toEqual(["hold", "hold", "ready"]);
    const paperMap = (u,v) => ({ x: (u * .73 + .14) * dim.width, y: (v * .78 + .08) * dim.height });
    expect(pageScanQualityFeedback(dim, paperMap)).toContain("The page looks dim");
    expect(pageScanQualityFeedback(bright, paperMap)).toBeNull();
    expect(pageScanQualityFeedback(dim, null)).toBeNull();
  });

  it("captures a full sheet when a color cast makes only the center look like paper", () => {
    const image = mixedLighting();
    const quality = inspectPageFrame(image, { captureOnly: true });
    expect(quality.state).toBe("clear");
    expect(quality.corners[0].x).toBeCloseTo(.125, 2);
    expect(quality.corners[2].y).toBeCloseTo(.9, 2);
    const gate = createPageCaptureGate();
    const states = [0, 150, 300, 450].map(t => gate.update(image, t, { captureOnly: true }).state);
    expect(states).toEqual(["hold", "hold", "ready", "captured"]);
  });
  it("keeps a genuinely small sheet on a larger contrasting mat below the capture threshold", () => {
    const image = mixedLighting({ smallPage: true }), gate = createPageCaptureGate();
    for (const t of [0, 200, 400, 600, 800])
      expect(gate.update(image, t, { captureOnly: true })).toMatchObject({ state: "small", ready: false });
  });
  it.each([[false, "soft"], [true, "clear"]])("tracks swaying paper over patterned fabric (stripes: %s)", (striped, initialState) => {
    const frames = [0, 12, -2, 12, 0].map(shift => fabricPrint(shift, striped));
    expect(inspectPageFrame(frames[0]).state).toBe(initialState);
    // Sharp fabric stripes can pass focus while pulling the lower-left
    // corner away from the paper. The native-photo guide checks the edge.
    const quality = inspectPageFrame(frames[0], { captureOnly: true });
    expect(quality.corners[3].x).toBeCloseTo(.128, 2);
    const gate = createPageCaptureGate();
    const states = frames.map((image, i) => gate.update(image, i * 150, { captureOnly: true }).state);
    expect(states).toEqual(["hold", "hold", "ready", "captured", "captured"]);
  });
  it.each([[320, 400], [360, 450], [480, 600]])("uses a %i × %i preview for framing, not as the native photo resolution", (width, height) => {
    const source = paper(), data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (Math.floor(y * source.height / height) * source.width + Math.floor(x * source.width / width)) * 4;
      data.set(source.data.subarray(at, at + 4), (y * width + x) * 4);
    }
    const image = { width, height, data };
    // Low-detail video remains unsuitable for decoding, but can guide a
    // separately validated high-resolution native still photograph.
    expect(inspectPageFrame(image).state).toBe("small");
    expect(inspectPageFrame(image, { captureOnly: true }).state).toBe("clear");
    const gate = createPageCaptureGate();
    for (const time of [0, 150]) expect(gate.update(image, time, { captureOnly: true }).ready).toBe(false);
    expect(gate.update(image, 300, { captureOnly: true })).toMatchObject({ state: "ready", ready: true });
  });
  it("still rejects a small native-photo preview page instead of bypassing framing", () => {
    expect(inspectPageFrame(paper({ x: 220, y: 280, width: 360, height: 440 }), { captureOnly: true }).state).toBe("small");
  });
  it("requires three clear readings over at least 300 ms", () => {
    const gate = createPageCaptureGate(), image = paper();
    expect(gate.update(image, 0)).toMatchObject({ state: "hold", ready: false, progress: 0 });
    expect(gate.update(image, 150).ready).toBe(false);
    expect(gate.update(image, 299).ready).toBe(false);
    expect(gate.update(image, 300)).toMatchObject({ state: "ready", ready: true, progress: 1 });
    const slow = createPageCaptureGate();
    expect(slow.update(image, 0).ready).toBe(false);
    expect(slow.update(image, 350).ready).toBe(false);
    expect(slow.update(image, 510).ready).toBe(true);
  });
  it("captures a stationary page once, including after processing, and rearms after movement", () => {
    const gate = createPageCaptureGate(), image = paper();
    for (const time of [0, 150]) gate.update(image, time);
    expect(gate.update(image, 300).ready).toBe(true);
    for (const time of [800, 2400, 10000]) expect(gate.update(image, time)).toMatchObject({ state: "captured", ready: false });
    const next = paper({ x: 120 });
    for (const time of [10200, 10350]) expect(gate.update(next, time).ready).toBe(false);
    expect(gate.update(next, 10500).ready).toBe(true);
  });
  it("completes a steady hold when a visible corner sways across the starting margin", () => {
    const centered = paper({ x: 100, width: 676 }), near = paper({ x: 106, width: 676 });
    const gate = createPageCaptureGate(), options = { captureOnly: true };
    expect(gate.update(near, 0, options)).toMatchObject({ state: "framing", ready: false });
    expect(gate.update(centered, 200, options).state).toBe("hold");
    expect(gate.update(near, 350, options).progress).toBeGreaterThan(0);
    expect(gate.update(near, 500, options).ready).toBe(true);
    expect(gate.update(centered, 650, options).state).toBe("captured");
  });
  it("requires a fresh border after clipping, a scene change, or a gap in preview frames", () => {
    const centered = paper({ x: 100, width: 676 }), near = paper({ x: 106, width: 676 });
    const options = { captureOnly: true };
    for (const [next, when] of [[paper({ x: 128, width: 676 }), 400],
      [paper({ x: 106, width: 676, ink: true }), 400], [near, 2000]]) {
      const gate = createPageCaptureGate();
      gate.update(centered, 0, options);
      gate.update(near, 200, options);
      expect(gate.update(next, when, options)).toMatchObject({ state: "framing", ready: false });
      expect(gate.update(near, when + 200, options).state).toBe("framing");
    }
  });
  it.each([false, true])("recognizes pale printing replaced in exactly the same position (alternating tones: %s)", alternating => {
    const gate = createPageCaptureGate(), first = paper(), second = paper();
    for (let y = 300; y < 600; y++) for (let x = 200; x < 600; x++) {
      const at = (y * second.width + x) * 4;
      const value = alternating ? 235 + 20 * (Math.floor((x - 90) / (600 / 16)) % 2) : 224;
      second.data[at] = second.data[at + 1] = second.data[at + 2] = value;
    }
    const a = inspectPageFrame(first), b = inspectPageFrame(second);
    const difference = a.samples.reduce((sum, value, i) => sum + Math.abs(value - b.samples[i]), 0) / a.samples.length;
    expect(difference).toBeGreaterThan(2); expect(difference).toBeLessThan(9);
    for (const time of [0, 150]) gate.update(first, time);
    expect(gate.update(first, 300).ready).toBe(true);
    for (const time of [500, 650]) expect(gate.update(second, time).ready).toBe(false);
    expect(gate.update(second, 800).ready).toBe(true);
  });
  it.each([{ x: 0 }, { y: 0 }, { width: 800 }, { desk: 245 }])("does not invent a whole-page capture for %j", options => {
    const image = paper(options);
    expect(inspectPageFrame(image).state).toBe("framing");
    const gate = createPageCaptureGate();
    for (const t of [0, 150, 300, 450])
      expect(gate.update(image, t, { captureOnly: true })).toMatchObject({ state: "framing", ready: false });
  });
  it("asks to move closer for a page too small to read", () => {
    expect(inspectPageFrame(paper({ x: 220, y: 280, width: 360, height: 440 })).state).toBe("small");
  });
  it("waits for focus on a blurred photograph", () => {
    expect(inspectPageFrame(paper({ blur: 5 })).state).toBe("soft");
    expect(inspectPageFrame(paper({ blur: 5 }), { captureOnly: true }).state).toBe("soft");
  });
  it("accepts a sharp photograph even with unreadable printing or no text", () => {
    expect(inspectPageFrame(paper({ ink: true })).state).toBe("clear");
    expect(inspectPageFrame(paper()).state).toBe("clear");
  });
  it("captures warm, shadowed paper on a patterned desk without changing the original pixels", () => {
    const width = 800, height = 1000;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inside = x >= 34 && x < 774 && y >= 60 && y < 960;
      const light = inside ? 220 * (1 - y / height * .4) : 170 + (x * 7 + y * 11) % 20;
      const tint = inside ? [1.05, 1, .95] : [1.1, 1, .9];
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) data[at + channel] = Math.min(255, light * tint[channel]);
      data[at + 3] = 255;
    }
    const original = data.slice(), image = { width, height, data };
    const gate = createPageCaptureGate();
    for (const time of [0, 150]) expect(gate.update(image, time).state).toBe("hold");
    expect(gate.update(image, STEADY_CAPTURE_MS)).toMatchObject({ state: "ready", ready: true });
    expect(data.every((value, index) => value === original[index])).toBe(true);
  });
  it("finds a tilted page rather than requiring a perfect rectangle", () => {
    const image = paper(), corners = [{x:110,y:70},{x:720,y:150},{x:650,y:900},{x:90,y:820}];
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const inside = corners.every((a, i) => {
        const b = corners[(i+1)%4];
        return (b.x-a.x)*(y-a.y) - (b.y-a.y)*(x-a.x) >= 0;
      });
      const at = (y * image.width + x) * 4;
      image.data[at] = image.data[at+1] = image.data[at+2] = inside ? 245 : 55;
    }
    const measured = inspectPageFrame(image);
    expect(measured.state).toBe("clear");
    measured.corners.forEach((p, i) => {
      expect(p.x).toBeCloseTo(corners[i].x / image.width, 1);
      expect(p.y).toBeCloseTo(corners[i].y / image.height, 1);
    });
  });
  it("starts the hold again after movement, a scene change, or a long frame gap", () => {
    for (const [image, time] of [[paper({ x: 120 }), 300], [paper({ x: 74, width: 632 }), 300],
      [paper({ ink: true }), 300], [paper(), 2400]]) {
      const gate = createPageCaptureGate();
      gate.update(paper(), 0); gate.update(paper(), 150);
      expect(gate.update(image, time)).toMatchObject({ ready: false, progress: 0 });
    }
  });
  it("rejects a large swing across the starting position even when each endpoint is nearby", () => {
    const gate = createPageCaptureGate(), centered = paper(), left = paper({ x: 73 }), right = paper({ x: 107 });
    const states = [centered, left, right, left, right].map((frame, i) => gate.update(frame, i * 150));
    expect(states.every(s => s.state === "hold" && !s.ready)).toBe(true);
    expect(states[2].progress).toBe(0);
  });
});
