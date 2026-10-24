/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PdfSealInput } from "./PdfSealInput.jsx";
import { scanPdfSeals } from "./scanPdf.js";

vi.mock("./scanPdf.js", async original => ({ ...await original(), scanPdfSeals: vi.fn() }));
const summary = { pageCount: 2, pagesWithSeals: 1, sealCount: 1, missingPages: [2], failedPages: [] };
const frame = { width: 20, height: 30, data: new Uint8ClampedArray(20 * 30 * 4) };
const choose = () => fireEvent.change(screen.getByLabelText("Open PDF to verify"), {
  target: { files: [new File(["synthetic"], "pages.pdf", { type: "application/pdf" })] },
});

beforeEach(() => {
  vi.mocked(scanPdfSeals).mockReset();
  vi.stubGlobal("ImageData", class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("passes full page images to verification and distinguishes unreadable pages from successful scans", async () => {
  const onSeal = vi.fn((_seal, canvas) => { expect(canvas.width).toBe(20); expect(canvas.height).toBe(30); });
  vi.mocked(scanPdfSeals).mockImplementation(async (_file, callbacks) => {
    callbacks.onProgress({ pageNumber: 1, pageCount: 2 });
    await callbacks.onSeal("seal", frame);
    return summary;
  });
  render(<PdfSealInput onSeal={onSeal} />);
  choose();
  await screen.findByText(/No readable seal on PDF page\(s\): 2/);
  expect(onSeal).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Stop reading PDF" })).toBeNull();
});

it("cancels an old PDF when another is selected and ignores its late result", async () => {
  const pending = [];
  vi.mocked(scanPdfSeals).mockImplementation((_file, callbacks) => new Promise(resolve => pending.push({ callbacks, resolve })));
  const onSeal = vi.fn();
  render(<PdfSealInput onSeal={onSeal} />);
  choose(); choose();
  expect(pending[0].callbacks.signal.aborted).toBe(true);
  await expect(pending[0].callbacks.onSeal("stale", frame)).rejects.toMatchObject({ name: "AbortError" });
  await act(async () => pending[0].resolve(summary));
  expect(screen.getByRole("button", { name: "Stop reading PDF" })).toBeTruthy();
  await act(async () => pending[1].resolve(summary));
  expect(onSeal).not.toHaveBeenCalled();
  await screen.findByText(/Found 1 QRed seal/);
});

it("stops and clears pending PDF work with a new collection session", async () => {
  let callbacks;
  vi.mocked(scanPdfSeals).mockImplementation((_file, options) => { callbacks = options; return new Promise(() => {}); });
  const view = render(<PdfSealInput onSeal={vi.fn()} session={0} />);
  choose();
  fireEvent.click(screen.getByRole("button", { name: "Stop reading PDF" }));
  expect(callbacks.signal.aborted).toBe(true);
  expect(screen.getByText(/already found remain collected/)).toBeTruthy();
  choose();
  view.rerender(<PdfSealInput onSeal={vi.fn()} session={1} />);
  await waitFor(() => expect(callbacks.signal.aborted).toBe(true));
  expect(screen.queryByRole("status")).toBeNull();
});

it("shows PDF errors and permits another file", async () => {
  vi.mocked(scanPdfSeals).mockRejectedValue(new Error("Invalid PDF structure"));
  render(<PdfSealInput onSeal={vi.fn()} />);
  choose();
  await screen.findByText("Could not read PDF seals: Invalid PDF structure");
  expect(screen.getByLabelText("Open PDF to verify").disabled).toBe(false);
});
