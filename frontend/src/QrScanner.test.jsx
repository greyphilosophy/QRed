/* @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import jsQR from "jsqr";
import { createQrFrameScanner } from "./qr/scanQrImage.js";
import { scanPhotoInWorker } from "./qr/photoScanClient.js";
import { scanPageAlignedImage } from "./qr/pageAlignedScan.js";
import { createQRedSeals } from "./qredSealer.js";
import { createQRedQrData } from "./qredQr.js";
import { applyCameraQualityControls, applyContinuousCameraFocus, decodeCanvasFrame, findPreferredMainCamera, getPreferredCameraStream, isCameraFrameReady, manualCapturePendingAction, MANUAL_CAPTURE_PENDING_TIMEOUT_MS, QrScanner, qrScanAction, QR_CAMERA_CONSTRAINTS } from "./QrScanner.jsx";

vi.mock("./qr/photoScanClient.js", () => ({ preparePhotoScanner: vi.fn(), scanPhotoInWorker: vi.fn() }));
vi.mock("jsqr", () => ({ default: vi.fn() }));
vi.mock("./qr/pageAlignedScan.js", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, scanPageAlignedImage: vi.fn(() => []) };
});

describe("QrScanner camera controls", () => {
  it("requests the rear camera at an efficient resolution for mobile scanning", () => {
    expect(QR_CAMERA_CONSTRAINTS).toEqual({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  });

  it("enables continuous focus, exposure, white balance, and resets to 1× zoom when supported", async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const stream = {
      getVideoTracks: () => [{
        applyConstraints,
        getCapabilities: () => ({
          focusMode: ["manual", "continuous"],
          exposureMode: ["continuous"],
          whiteBalanceMode: ["none", "continuous"],
          torch: true,
          zoom: { min: 1, max: 3, step: 0.1 },
        }),
      }],
    };

    await applyCameraQualityControls(stream);

    expect(applyConstraints).toHaveBeenCalledWith({
      advanced: [
        { focusMode: "continuous" },
        { exposureMode: "continuous" },
        { whiteBalanceMode: "continuous" },
        { zoom: 1 },
      ],
    });
  });

  it("keeps the old focus helper wired to non-surprising quality controls", async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const stream = {
      getVideoTracks: () => [{
        applyConstraints,
        getCapabilities: () => ({ zoom: { min: 1, max: 3 } }),
      }],
    };

    await applyContinuousCameraFocus(stream);

    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ zoom: 1 }] });
  });

  it("does not enable an advertised torch", async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const stream = {
      getVideoTracks: () => [{
        applyConstraints,
        getCapabilities: () => ({ torch: true }),
      }],
    };

    await applyCameraQualityControls(stream);

    expect(applyConstraints).not.toHaveBeenCalled();
  });

  it("prefers the main wide camera over a telephoto camera after permission unlocks labels", async () => {
    const firstStop = vi.fn();
    const firstStream = {
      getTracks: () => [{ stop: firstStop }],
      getVideoTracks: () => [{ label: "Back Telephoto Camera" }],
    };
    const mainStream = { getTracks: () => [], getVideoTracks: () => [{ label: "Back Wide Camera" }] };
    const mediaDevices = {
      getUserMedia: vi.fn()
        .mockResolvedValueOnce(firstStream)
        .mockResolvedValueOnce(mainStream),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: "videoinput", label: "Back Wide Camera", deviceId: "wide" },
        { kind: "videoinput", label: "Back Telephoto Camera", deviceId: "tele" },
      ]),
    };

    await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(mainStream);

    expect(firstStop).toHaveBeenCalled();
    expect(mediaDevices.getUserMedia).toHaveBeenNthCalledWith(2, {
      video: {
        ...QR_CAMERA_CONSTRAINTS.video,
        deviceId: { exact: "wide" },
      },
    });
  });

  it("falls back to the initially working camera when the preferred camera cannot open", async () => {
    const firstStop = vi.fn();
    const firstStream = {
      getTracks: () => [{ stop: firstStop }],
      getVideoTracks: () => [{ label: "Back Telephoto Camera" }],
    };
    const mediaDevices = {
      getUserMedia: vi.fn()
        .mockResolvedValueOnce(firstStream)
        .mockRejectedValueOnce(new Error("exact device unavailable")),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: "videoinput", label: "Back Wide Camera", deviceId: "wide" },
        { kind: "videoinput", label: "Back Telephoto Camera", deviceId: "tele" },
      ]),
    };

    await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(firstStream);

    expect(firstStop).not.toHaveBeenCalled();
  });

  it("chooses a rear main lens without selecting front, ultrawide, or zoom lenses", () => {
    const wide = { kind: "videoinput", label: "Back Wide Camera", deviceId: "wide" };
    const main = { kind: "videoinput", label: "Rear Main Camera 1x", deviceId: "main" };
    const alternatives = ["Front Main Camera", "Back Ultra Wide Camera", "Back 3x Camera", "Back Telephoto Camera"]
      .map(label => ({ kind: "videoinput", label, deviceId: label }));
    expect(findPreferredMainCamera([...alternatives, wide, main])).toBe(main);
    expect(findPreferredMainCamera([...alternatives, wide])).toBe(wide);
    expect(findPreferredMainCamera(alternatives)).toBeNull();
    expect(findPreferredMainCamera([{ kind: "videoinput", label: "", deviceId: "unknown" }])).toBeNull();
  });

  it("keeps the current main camera without reopening it", async () => {
    const stream = { getVideoTracks: () => [{ getSettings: () => ({ deviceId: "main" }) }] };
    const mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: "videoinput", label: "Rear Main Camera", deviceId: "main" },
      ]),
    };
    await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(stream);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("keeps scanning when browsers reject advertised focus controls", async () => {
    const applyConstraints = vi.fn().mockRejectedValue(new Error("not supported"));
    const stream = {
      getVideoTracks: () => [{
        applyConstraints,
        getCapabilities: () => ({ focusMode: ["continuous"] }),
      }],
    };

    await expect(applyContinuousCameraFocus(stream)).resolves.toBeUndefined();
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: "continuous" }] });
  });
});


describe("QrScanner scan loop decisions", () => {
  it("continues scanning when a QRed QR only decodes to the public QRED.ORG marker", () => {
    expect(qrScanAction(new Uint8ClampedArray(), 0, 0, { data: "QRED.ORG" })).toEqual({ status: "continue" });
  });

  it("stops scanning when jsQR exposes a framed hidden QRed payload", () => {
    const payload = "https://qred.org/#QRED1?doc=DOC&i=0&n=1&txt=HELLO";
    const payloadBytes = new TextEncoder().encode(payload);
    const binaryData = new Uint8Array([
      0x20, 0x3d, 0x44, 0x44, 0xad, 0x4f, 0x50, 0x40,
      (payloadBytes.length >> 8) & 0xff,
      payloadBytes.length & 0xff,
      ...payloadBytes,
      0xec,
      0x11,
    ]);

    expect(qrScanAction(new Uint8ClampedArray(), 0, 0, { data: "QRED.ORG", binaryData, version: 1 })).toEqual({
      status: "found",
      text: payload,
    });
    expect(qrScanAction(new Uint8ClampedArray(), 0, 0, { data: "https://qred.org/#QRED1?sig?garbled", binaryData, version: 1 })).toEqual({
      status: "found",
      text: payload,
    });
  });

  it("stops scanning on ordinary non-QRed QR content", () => {
    expect(qrScanAction(new Uint8ClampedArray(), 0, 0, { data: "https://example.test" })).toEqual({
      status: "found",
      text: "https://example.test",
    });
  });
});


describe("QrScanner manual photo capture", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete navigator.mediaDevices;
  });

  it("turns the primary scanner button into a photo capture button once the camera starts", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new Error("denied")),
      },
    });

    render(React.createElement(QrScanner, { onOpenPdfStampTool: vi.fn() }));

    fireEvent.click(screen.getByRole("button", { name: "Start scanning" }));

    expect(screen.getByRole("button", { name: "Scan photo" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Camera access needed: denied/)).toBeTruthy());
  });

  it("has no flashlight control even when the camera advertises a torch", async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
      getVideoTracks: () => [{
        applyConstraints,
        getCapabilities: () => ({ torch: true }),
      }],
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
      },
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);

    render(React.createElement(QrScanner, { onOpenPdfStampTool: vi.fn() }));

    fireEvent.click(screen.getByRole("button", { name: "Start scanning" }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Flashlight/ })).toBeNull();
    expect(applyConstraints).not.toHaveBeenCalled();
    play.mockRestore();
  });


  it("keeps the stalled-frame guidance visible after a manual capture timeout", async () => {
    let animationFrameCallback = null;
    const requestAnimationFrameSpy = vi.spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback) => {
        animationFrameCallback = callback;
        return 1;
      });
    const cancelAnimationFrameSpy = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    // Set the clock before the first frame; moving it backwards after mount
    // can leave the scanner waiting for a throttle timer from the real clock.
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
      getVideoTracks: () => [{ getCapabilities: () => ({}) }],
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
      },
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);

    render(React.createElement(QrScanner, { onOpenPdfStampTool: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: "Start scanning" }));
    await act(async () => {
      await Promise.resolve();
    });

    now.mockReturnValue(1000);
    fireEvent.click(screen.getByRole("button", { name: "Scan photo" }));
    expect(screen.getByRole("status", { name: /Camera is preparing the photo/ })).toBeTruthy();

    now.mockReturnValue(1000 + MANUAL_CAPTURE_PENDING_TIMEOUT_MS);
    await act(async () => {
      animationFrameCallback(performance.now());
    });

    expect(screen.getByRole("status", { name: /not delivering photo frames yet/ })).toBeTruthy();

    now.mockReturnValue(1000 + MANUAL_CAPTURE_PENDING_TIMEOUT_MS + 500);
    await act(async () => {
      animationFrameCallback(performance.now());
    });

    expect(screen.getByRole("status", { name: /not delivering photo frames yet/ })).toBeTruthy();
    expect(screen.queryByRole("status", { name: /Camera is preparing the photo/ })).toBeNull();

    play.mockRestore();
    now.mockRestore();
    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
  });

  it("shows a loading indicator while the camera is starting", () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(() => new Promise(() => {})),
      },
    });

    render(React.createElement(QrScanner, { onOpenPdfStampTool: vi.fn() }));

    fireEvent.click(screen.getByRole("button", { name: "Start scanning" }));

    expect(screen.getByRole("status", { name: /Starting camera/ })).toBeTruthy();
  });

  it.each([false, true])("preserves the manual frame while decoding and handles cancellation=%s", async cancel => {
    let nextFrame, finish;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => { nextFrame = callback; return 1; });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }], getVideoTracks: () => [] }),
    } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const context = { drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(320 * 240 * 4) }) };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.mocked(jsQR).mockReturnValue(null);
    vi.mocked(scanPhotoInWorker).mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onSealDetected = vi.fn();
    render(<QrScanner onSealDetected={onSealDetected} returnPayload />);
    fireEvent.click(screen.getByRole("button", { name: "Start scanning" }));
    await waitFor(() => expect(nextFrame).toBeTypeOf("function"));
    Object.defineProperties(document.querySelector("video"), {
      readyState: { value: 2 }, videoWidth: { value: 320 }, videoHeight: { value: 240 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Scan photo" }));
    expect(screen.getByRole("button", { name: "Reading photo…" }).disabled).toBe(true);
    const canvas = document.querySelector("canvas");
    const draws = context.drawImage.mock.calls.length;
    act(() => { now += 500; nextFrame(); });
    expect(context.drawImage).toHaveBeenCalledTimes(draws);
    const signal = scanPhotoInWorker.mock.calls[0][1].signal;
    if (cancel) {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(signal.aborted).toBe(true);
      expect(screen.getByRole("button", { name: "Start scanning" }).disabled).toBe(false);
    }
    await act(async () => finish({ status: "found", text: "https://example.test" }));
    if (cancel) {
      expect(onSealDetected).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Start scanning" }));
      expect(scanPhotoInWorker).toHaveBeenCalledTimes(1);
    } else {
      expect(onSealDetected).toHaveBeenCalledWith("https://example.test", canvas);
      expect(screen.getByRole("button", { name: "Scan again" }).disabled).toBe(false);
    }
    expect(stop).toHaveBeenCalledTimes(1);
  });
});


describe("decodeCanvasFrame", () => {
  afterEach(() => {
    vi.mocked(jsQR).mockReset();
  });

  function frame({ readyState = 2, width = 320, height = 240 } = {}) {
    const imageData = { data: new Uint8ClampedArray(width * height * 4) };
    const ctx = { drawImage: vi.fn(), getImageData: vi.fn(() => imageData) };
    const canvas = { width, height, getContext: vi.fn(() => ctx) };
    const video = { readyState, videoWidth: width, videoHeight: height };
    return { canvas, ctx, video };
  }

  it("reports manual captures as pending until a camera frame is available", () => {
    const { canvas, video } = frame({ readyState: 1 });
    video.videoWidth = 0;
    video.videoHeight = 0;

    expect(isCameraFrameReady(video, canvas)).toBe(false);
    expect(decodeCanvasFrame(video, canvas, { manual: true })).toEqual({
      status: "pending",
      message: "Camera is preparing the photo. Hold steady…",
    });
    expect(jsQR).not.toHaveBeenCalled();
  });

  it("explains when a manual capture waits too long for camera frames", () => {
    const startedAt = 1000;

    expect(manualCapturePendingAction(startedAt, startedAt + MANUAL_CAPTURE_PENDING_TIMEOUT_MS - 1)).toBeNull();
    expect(manualCapturePendingAction(startedAt, startedAt + MANUAL_CAPTURE_PENDING_TIMEOUT_MS)).toEqual({
      status: "feedback",
      message: "The camera is open, but this browser is not delivering photo frames yet. Wait a moment, then try Scan photo again; if this keeps happening, close and reopen the scanner or check camera permissions.",
    });
  });

  it("accepts camera frames once current frame data is available", () => {
    const { canvas, ctx, video } = frame({ readyState: 2 });
    vi.mocked(jsQR).mockReturnValue({ data: "https://example.test" });

    expect(decodeCanvasFrame(video, canvas)).toEqual({ status: "found", text: "https://example.test" });
    expect(ctx.drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 240);
    expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, 320, 240);
    expect(jsQR).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 320, 240, expect.any(Object));
  });

  it("returns all four page-aligned watermark chunks from one manual camera capture", () => {
    const { canvas, video } = frame();
    const texts = ["chunk-1", "chunk-2", "chunk-3", "chunk-4"];
    vi.mocked(scanPageAlignedImage).mockReturnValueOnce(texts.map(seal => ({ seal })));
    expect(decodeCanvasFrame(video, canvas, { manual: true, returnPayload: true }))
      .toEqual({ status: "found-multiple", texts });
    expect(scanPageAlignedImage).toHaveBeenCalledTimes(1);
    expect(jsQR).not.toHaveBeenCalled();
  });

  it("delivers every live-page chunk before a different camera frame replaces its photo", async () => {
    const { seals } = await createQRedSeals({
      privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes",
      publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q",
      content: "Camera frame ownership. ".repeat(180), encodingStrategy: "plaintext",
      timestamp: "2026-10-31T12:00:00Z",
      pageContext: { pageNumber: 1, pageCount: 1 }, preferFourQrPage: true,
    });
    expect(seals).toHaveLength(4);
    const { canvas, ctx, video } = frame();
    vi.mocked(jsQR).mockReturnValue(null);
    vi.mocked(scanPageAlignedImage).mockClear().mockReturnValueOnce(seals.map(seal => {
      const { bytes, version } = createQRedQrData(seal);
      return { seal, code: { data: "QRED.ORG", correctedData: bytes, version, pageAligned: true } };
    }));
    const scanQrFrame = createQrFrameScanner();
    let action;
    for (let i = 0; i < 20; i++) {
      action = decodeCanvasFrame(video, canvas, { scanQrFrame, returnPayload: true });
      if (action.status !== "continue") break;
    }
    expect(action).toEqual({ status: "found-multiple", texts: seals });
    // The next video frame is unrelated. No payload from the old frame may
    // be emitted against this canvas and offered as its comparison photo.
    ctx.getImageData.mockReturnValue({ data: new Uint8ClampedArray(320 * 240 * 4).fill(255) });
    expect(decodeCanvasFrame(video, canvas, { scanQrFrame, returnPayload: true }))
      .toEqual({ status: "continue" });
    expect(scanPageAlignedImage).toHaveBeenCalledTimes(1);
  });

  it("gives manual photo feedback when no QR is found", () => {
    const { canvas, video } = frame();
    vi.mocked(jsQR).mockReturnValue(null);

    expect(decodeCanvasFrame(video, canvas, { manual: true })).toEqual({
      status: "feedback",
      message: "No readable seal found. Include all four page corners against a contrasting background, hold steady, and avoid glare. For older seals, try framing the individual QR instead.",
    });
    expect(jsQR.mock.calls.length).toBeGreaterThan(1);
    expect(jsQR.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("runs only one decode per automatic frame while keeping manual capture independent", () => {
    const { canvas, video } = frame();
    const scanQrFrame = createQrFrameScanner();
    vi.mocked(jsQR).mockReturnValue(null);
    for (let index = 0; index < 4; index += 1) {
      expect(decodeCanvasFrame(video, canvas, { scanQrFrame })).toEqual({ status: "continue" });
      expect(jsQR).toHaveBeenCalledTimes(index + 1);
    }
    const liveScanner = vi.fn(scanQrFrame);
    vi.mocked(jsQR).mockClear();
    decodeCanvasFrame(video, canvas, { manual: true, scanQrFrame: liveScanner });
    expect(liveScanner).not.toHaveBeenCalled();
    expect(jsQR.mock.calls.length).toBeGreaterThan(1);
    expect(jsQR.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("gives manual photo feedback when a bootstrap QR has no hidden QRed payload", () => {
    const { canvas, video } = frame();
    vi.mocked(jsQR).mockReturnValue({ data: "QRED.ORG" });

    expect(decodeCanvasFrame(video, canvas, { manual: true })).toEqual({
      status: "feedback",
      message: "QR code found, but no hidden QRed payload was detected. Move closer, improve lighting, and try again.",
    });
  });

  it.each(["https://qred.org/", "HTTPS://QRED.ORG"])(
    "keeps looking for a watermark after seeing navigation code %s", url => {
      const { canvas, video } = frame();
      vi.mocked(jsQR).mockReturnValue({ data: url });
      expect(decodeCanvasFrame(video, canvas)).toEqual({ status: "continue" });
      expect(decodeCanvasFrame(video, canvas, { manual: true })).toMatchObject({
        status: "feedback", message: expect.stringContaining("pale watermark"),
      });
    },
  );
});
