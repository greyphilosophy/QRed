/* @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import jsQR from "jsqr";
import { applyCameraQualityControls, applyContinuousCameraFocus, decodeCanvasFrame, findPreferredZoomCamera, getPreferredCameraStream, isCameraFrameReady, manualCapturePendingAction, MANUAL_CAPTURE_PENDING_TIMEOUT_MS, QrScanner, qrScanAction, QR_CAMERA_CONSTRAINTS } from "./QrScanner.jsx";

vi.mock("jsqr", () => ({ default: vi.fn() }));

describe("QrScanner camera controls", () => {
  it("requests the rear camera at an efficient resolution for mobile scanning", () => {
    expect(QR_CAMERA_CONSTRAINTS).toEqual({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  });

  it("enables continuous focus, exposure, white balance, and moderate zoom when supported", async () => {
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
        { zoom: 2 },
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

    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ zoom: 2 }] });
  });

  it("only enables the torch when explicitly requested", async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const stream = {
      getVideoTracks: () => [{
        applyConstraints,
        getCapabilities: () => ({ torch: true }),
      }],
    };

    await applyCameraQualityControls(stream, { enableTorch: true });

    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
  });

  it("prefers labeled zoom or telephoto cameras after permission unlocks labels", async () => {
    const firstStop = vi.fn();
    const firstStream = {
      getTracks: () => [{ stop: firstStop }],
      getVideoTracks: () => [{ label: "Back Wide Camera" }],
    };
    const zoomStream = { getTracks: () => [], getVideoTracks: () => [{ label: "Back Telephoto Camera" }] };
    const mediaDevices = {
      getUserMedia: vi.fn()
        .mockResolvedValueOnce(firstStream)
        .mockResolvedValueOnce(zoomStream),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: "videoinput", label: "Back Wide Camera", deviceId: "wide" },
        { kind: "videoinput", label: "Back Telephoto Camera", deviceId: "tele" },
      ]),
    };

    await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(zoomStream);

    expect(firstStop).toHaveBeenCalled();
    expect(mediaDevices.getUserMedia).toHaveBeenNthCalledWith(2, {
      video: {
        ...QR_CAMERA_CONSTRAINTS.video,
        deviceId: { exact: "tele" },
      },
    });
  });

  it("falls back to the initially working camera when the preferred camera cannot open", async () => {
    const firstStop = vi.fn();
    const firstStream = {
      getTracks: () => [{ stop: firstStop }],
      getVideoTracks: () => [{ label: "Back Wide Camera" }],
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

  it("recognizes zoom camera labels", () => {
    expect(findPreferredZoomCamera([
      { kind: "videoinput", label: "Back Wide Camera", deviceId: "wide" },
      { kind: "videoinput", label: "Back 3x Camera", deviceId: "zoom" },
    ])).toEqual({ kind: "videoinput", label: "Back 3x Camera", deviceId: "zoom" });
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

  it("applies torch constraints when the flashlight toggle is enabled during scanning", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: "Flashlight off" }));

    await waitFor(() => expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] }));
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
    const now = vi.spyOn(performance, "now");
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
    // ROI crop: center 50% of 320x240 → draw from video(80,60) at 160x120 onto canvas(0,0)
    expect(ctx.drawImage).toHaveBeenCalledWith(video, 80, 60, 160, 120, 0, 0, 160, 120);
  });

  it("gives manual photo feedback when no QR is found", () => {
    const { canvas, video } = frame();
    vi.mocked(jsQR).mockReturnValue(null);

    expect(decodeCanvasFrame(video, canvas, { manual: true })).toEqual({
      status: "feedback",
      message: "No QR code found in this photo. Center a QR seal in the frame and try again.",
    });
  });

  it("gives manual photo feedback when a bootstrap QR has no hidden QRed payload", () => {
    const { canvas, video } = frame();
    vi.mocked(jsQR).mockReturnValue({ data: "QRED.ORG" });

    expect(decodeCanvasFrame(video, canvas, { manual: true })).toEqual({
      status: "feedback",
      message: "QR code found, but no hidden QRed payload was detected. Move closer, improve lighting, and try again.",
    });
  });
});
