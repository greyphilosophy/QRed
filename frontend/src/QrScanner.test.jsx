/* @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import jsQR from "jsqr";
import { applyCameraQualityControls, applyContinuousCameraFocus, decodeCanvasFrame, findPreferredZoomCamera, getPreferredCameraStream, isCameraFrameReady, QrScanner, qrScanAction, QR_CAMERA_CONSTRAINTS } from "./QrScanner.jsx";

vi.mock("jsqr", () => ({ default: vi.fn() }));

describe("QrScanner camera controls", () => {
  it("requests the rear camera at a high ideal resolution", () => {
    expect(QR_CAMERA_CONSTRAINTS).toEqual({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
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

  it("accepts camera frames once current frame data is available", () => {
    const { canvas, ctx, video } = frame({ readyState: 2 });
    vi.mocked(jsQR).mockReturnValue({ data: "https://example.test" });

    expect(decodeCanvasFrame(video, canvas)).toEqual({ status: "found", text: "https://example.test" });
    expect(ctx.drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 240);
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
