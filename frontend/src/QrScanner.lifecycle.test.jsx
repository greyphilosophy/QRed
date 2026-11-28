/* @vitest-environment jsdom */
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QrScanner } from "./QrScanner.jsx";
import { createLiveScanWorker, scanPhotoInWorker } from "./qr/photoScanClient.js";

vi.mock("./qr/photoScanClient.js", () => ({
  preparePhotoScanner: vi.fn(),
  scanPhotoInWorker: vi.fn(),
  createLiveScanWorker: vi.fn(() => ({ busy: false, scan: vi.fn(), reset: vi.fn(), stop: vi.fn() })),
}));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("QrScanner route lifecycle", () => {
  let getUserMedia, stream, stop, play, nextFrame;
  beforeEach(() => {
    stop = vi.fn();
    stream = { getTracks: () => [{ stop }], getVideoTracks: () => [] };
    getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => { nextFrame = callback; return 1; });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    });
    vi.mocked(createLiveScanWorker).mockClear();
    vi.mocked(scanPhotoInWorker).mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete navigator.mediaDevices;
  });

  it("starts the camera once on a task mount and does not restart it on a parent rerender", async () => {
    const beforeScan = vi.fn().mockResolvedValue();
    const view = render(<QrScanner autoStart compact beforeScan={beforeScan} />);
    await waitFor(() => expect(document.querySelector("video")?.srcObject).toBe(stream));
    view.rerender(<QrScanner autoStart compact beforeScan={() => beforeScan()} />);
    await act(async () => {});
    expect(beforeScan).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Check document" })).toBeNull();
    expect(document.querySelector(".ar-reticle")).toBeNull();
    expect(screen.getByRole("button", { name: "Capture now" })).toBeTruthy();
  });

  it("prepares only once under Strict Mode and cannot open a camera after unmount", async () => {
    const preparation = deferred(), beforeScan = vi.fn(() => preparation.promise), onScanningChange = vi.fn();
    const view = render(<StrictMode><QrScanner autoStart compact beforeScan={beforeScan} onScanningChange={onScanningChange} /></StrictMode>);
    await screen.findByText("Preparing document check…");
    expect(beforeScan).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => preparation.resolve());
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(onScanningChange).toHaveBeenLastCalledWith(false);
  });

  it.each(["close", "files"])("cancels pending preparation when leaving through %s", async action => {
    const preparation = deferred(), onClose = vi.fn(), onChoosePhoto = vi.fn();
    render(<QrScanner autoStart compact beforeScan={() => preparation.promise} onClose={onClose} onChoosePhoto={onChoosePhoto} />);
    await screen.findByText("Preparing document check…");
    fireEvent.click(screen.getByRole("button", { name: action === "close" ? "Close" : "Browse files" }));
    await act(async () => preparation.resolve());
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start camera" }).disabled).toBe(false);
    if (action === "close") expect(onClose).toHaveBeenCalledTimes(1);
    else expect(onChoosePhoto).toHaveBeenCalledWith(true);
  });

  it("shows a short preparation error with a working retry in the task view", async () => {
    const beforeScan = vi.fn().mockRejectedValueOnce(new Error("Text reader is unavailable."))
      .mockResolvedValueOnce();
    render(<QrScanner autoStart compact beforeScan={beforeScan} onOpenPdfStampTool={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Text reader is unavailable. Try again while connected.");
    expect(screen.getByRole("heading", { name: "Camera" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Seal PDF" })).toBeNull();
    expect(document.querySelector(".ar-reticle")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry camera" }));
    await waitFor(() => expect(document.querySelector("video")?.srcObject).toBe(stream));
    expect(beforeScan).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("releases a camera permission request that finishes after its route unmounts", async () => {
    const camera = deferred(), onScanningChange = vi.fn();
    getUserMedia.mockReturnValue(camera.promise);
    const view = render(<QrScanner autoStart compact onScanningChange={onScanningChange} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    const live = createLiveScanWorker.mock.results.at(-1).value;
    view.unmount();
    expect(live.stop).toHaveBeenCalledTimes(1);
    expect(onScanningChange).toHaveBeenLastCalledWith(false);
    await act(async () => camera.resolve(stream));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();
  });

  it("stops the stream, live worker and frame loop when an active camera route unmounts", async () => {
    const onScanningChange = vi.fn();
    const view = render(<QrScanner autoStart compact onScanningChange={onScanningChange} />);
    await waitFor(() => expect(document.querySelector("video")?.srcObject).toBe(stream));
    const video = document.querySelector("video"), canvas = document.querySelector("canvas");
    const live = createLiveScanWorker.mock.results.at(-1).value, frame = nextFrame;
    expect(onScanningChange).toHaveBeenLastCalledWith(true);
    view.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(live.stop).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(onScanningChange).toHaveBeenLastCalledWith(false);
    act(() => frame());
    expect(live.scan).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it.each(["close", "review"])("releases camera resources and invokes the %s route callback", async action => {
    const onClose = vi.fn(), onReview = vi.fn(), onScanningChange = vi.fn();
    const props = { autoStart: true, compact: true, collectSeals: true, onClose, onReview, onScanningChange };
    const view = render(<QrScanner {...props} collectionProgress={{ pagesCollected: 1 }} />);
    await waitFor(() => expect(document.querySelector("video")?.srcObject).toBe(stream));
    const live = createLiveScanWorker.mock.results.at(-1).value;
    fireEvent.click(screen.getByRole("button", { name: action === "close" ? "Close" : "Check this page now" }));
    expect(action === "close" ? onClose : onReview).toHaveBeenCalledTimes(1);
    expect(action === "close" ? onReview : onClose).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(live.stop).toHaveBeenCalledTimes(1);
    expect(document.querySelector("video")).toBeNull();
    expect(onScanningChange).toHaveBeenLastCalledWith(false);
    // A retained verifier can finish processing just as the user leaves.
    // That update must not issue a second or unwanted navigation request.
    view.rerender(<QrScanner {...props} collectionProgress={{ activeSeal: "complete", finished: true, pagesCollected: 2 }} />);
    expect(onReview).toHaveBeenCalledTimes(action === "review" ? 1 : 0);
    expect(onClose).toHaveBeenCalledTimes(action === "close" ? 1 : 0);
  });

  it("reviews a newly finished collection once, without treating an existing finished collection as new", async () => {
    const onReview = vi.fn(), oldCollection = { activeSeal: "existing", finished: true, pagesCollected: 1 };
    const props = { autoStart: true, compact: true, collectSeals: true, onReview };
    const view = render(<QrScanner {...props} collectionProgress={oldCollection} />);
    await waitFor(() => expect(document.querySelector("video")?.srcObject).toBe(stream));
    view.rerender(<QrScanner {...props} collectionProgress={{ ...oldCollection }} />);
    expect(onReview).not.toHaveBeenCalled();
    expect(document.querySelector("video")).not.toBeNull();

    view.rerender(<QrScanner {...props} collectionProgress={{ activeSeal: "new", finished: false, pagesCollected: 1 }} />);
    const finished = { activeSeal: "new", finished: true, pagesCollected: 2 };
    view.rerender(<QrScanner {...props} collectionProgress={finished} />);
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(document.querySelector("video")).toBeNull();
    const replacementReview = vi.fn();
    view.rerender(<QrScanner {...props} collectionProgress={{ ...finished }} onReview={replacementReview} />);
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(replacementReview).not.toHaveBeenCalled();
  });

  it("aborts a photo decoder and ignores its late result after navigation unmounts the scanner", async () => {
    const decode = deferred(), onSealDetected = vi.fn();
    vi.mocked(scanPhotoInWorker).mockReturnValue(decode.promise);
    const view = render(<QrScanner autoStart compact onSealDetected={onSealDetected} />);
    await waitFor(() => expect(document.querySelector("video")?.srcObject).toBe(stream));
    Object.defineProperties(document.querySelector("video"), {
      readyState: { value: 2 }, videoWidth: { value: 320 }, videoHeight: { value: 240 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
    await waitFor(() => expect(scanPhotoInWorker).toHaveBeenCalledTimes(1));
    const signal = scanPhotoInWorker.mock.calls[0][1].signal;
    const live = createLiveScanWorker.mock.results.at(-1).value;
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(live.stop).toHaveBeenCalledTimes(1);
    await act(async () => decode.resolve({ status: "found", text: "late result" }));
    expect(onSealDetected).not.toHaveBeenCalled();
  });
});
