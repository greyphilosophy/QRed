import { describe, expect, it } from "vitest";
import { createPageCaptureGate, inspectPageFrame, STEADY_CAPTURE_MS } from "./pageCaptureQuality.js";

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

describe("automatic whole-page capture", () => {
  it("waits for several steady frames and a real hold interval", () => {
    const gate = createPageCaptureGate(), image = paper();
    expect(gate.update(image, 0)).toMatchObject({ state: "hold", ready: false, progress: 0 });
    expect(gate.update(image, 200).ready).toBe(false);
    expect(gate.update(image, 400).ready).toBe(false);
    expect(gate.update(image, STEADY_CAPTURE_MS)).toMatchObject({ state: "ready", ready: true, progress: 1 });
  });
  it("captures a stationary page once, including after processing, and rearms after movement", () => {
    const gate = createPageCaptureGate(), image = paper();
    for (const time of [0, 200, 400]) gate.update(image, time);
    expect(gate.update(image, 600).ready).toBe(true);
    for (const time of [800, 2400, 10000]) expect(gate.update(image, time)).toMatchObject({ state: "captured", ready: false });
    const next = paper({ x: 120 });
    for (const time of [10200, 10400, 10600]) expect(gate.update(next, time).ready).toBe(false);
    expect(gate.update(next, 10800).ready).toBe(true);
  });
  it("recognizes a pale content change on a new page held in exactly the same position", () => {
    const gate = createPageCaptureGate(), first = paper(), second = paper();
    for (let y = 300; y < 600; y++) for (let x = 200; x < 600; x++) {
      const at = (y * second.width + x) * 4;
      second.data[at] = second.data[at + 1] = second.data[at + 2] = 224;
    }
    const a = inspectPageFrame(first), b = inspectPageFrame(second);
    const difference = a.samples.reduce((sum, value, i) => sum + Math.abs(value - b.samples[i]), 0) / a.samples.length;
    expect(difference).toBeGreaterThan(2); expect(difference).toBeLessThan(9);
    for (const time of [0, 200, 400]) gate.update(first, time);
    expect(gate.update(first, 600).ready).toBe(true);
    for (const time of [2000, 2200, 2400]) expect(gate.update(second, time).ready).toBe(false);
    expect(gate.update(second, 2600).ready).toBe(true);
  });
  it.each([{ x: 0 }, { y: 0 }, { width: 800 }, { desk: 245 }])("does not invent a whole-page capture for %j", options => {
    expect(inspectPageFrame(paper(options)).state).toBe("framing");
  });
  it("asks to move closer for a page too small to read", () => {
    expect(inspectPageFrame(paper({ x: 220, y: 280, width: 360, height: 440 })).state).toBe("small");
  });
  it("waits for focus on a blurred photograph", () => {
    expect(inspectPageFrame(paper({ blur: 5 })).state).toBe("soft");
  });
  it("accepts a sharp photograph even with unreadable printing or no text", () => {
    expect(inspectPageFrame(paper({ ink: true })).state).toBe("clear");
    expect(inspectPageFrame(paper()).state).toBe("clear");
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
    for (const [image, time] of [[paper({ x: 120 }), 600], [paper({ ink: true }), 600], [paper(), 2400]]) {
      const gate = createPageCaptureGate();
      gate.update(paper(), 0); gate.update(paper(), 200); gate.update(paper(), 400);
      expect(gate.update(image, time)).toMatchObject({ ready: false, progress: 0 });
    }
  });
});
