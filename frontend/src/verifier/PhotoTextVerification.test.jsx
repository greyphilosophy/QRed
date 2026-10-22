/* @vitest-environment jsdom */
/* eslint-disable no-unused-vars */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PhotoTextVerification } from "./PhotoTextVerification.jsx";

const ocr = vi.hoisted(() => ({ prepare: vi.fn(), read: vi.fn(), dispose: vi.fn(), open: vi.fn() }));
vi.mock("./photoOcr.js", () => ({
  createPhotoOcrReader: () => ocr,
  openPagePhoto: ocr.open,
  photoPreviewUrl: async () => "blob:page-photo",
}));
const page = { status: "VALID", signature_valid: true, document_id: "first", key_id: "trusted", content: "Account 123456", pdf: true, page_number: 1, page_count: 2 };
const other = { ...page, document_id: "second", content: "Different page", page_number: 2 };
const word = (text, x0) => ({ text, confidence: 99, bbox: { x0, y0: 10, x1: x0 + 50, y1: 30 } });

beforeEach(() => {
  vi.clearAllMocks();
  ocr.prepare.mockResolvedValue({});
  ocr.read.mockResolvedValue([word("Account", 10), word("123457", 80)]);
  ocr.open.mockResolvedValue({ width: 200, height: 100 });
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

async function choose() {
  fireEvent.click(screen.getByRole("button", { name: "Load text recognition" }));
  await screen.findByRole("button", { name: "Text recognition ready" });
  fireEvent.change(screen.getByLabelText("Choose page photo"), { target: { files: [new File(["photo"], "page.png", { type: "image/png" })] } });
}

it("marks a changed account number in photo coordinates and preserves the signed reference", async () => {
  render(<PhotoTextVerification results={[page]} />);
  await choose();
  await screen.findByText(/Differences found/);
  expect(screen.getByRole("button", { name: "Different or extra text: 123457" }).getAttribute("x")).toBe("80");
  expect(screen.getByText("123456", { exact: false })).toBeTruthy();
  expect(ocr.read.mock.calls[0][0]).toEqual({ width: 200, height: 100 });
  // Recognition gets the image and progress callback, never the signed text.
  expect(ocr.read.mock.calls[0]).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Clear photo" }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByText(/Differences found/)).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:page-photo");
});

it.each(["INVALID", "UNVERIFIED", "INCOMPLETE", "ERROR"])("does not compare a photo against %s text", status => {
  render(<PhotoTextVerification results={[{ ...page, status }]} />);
  expect(screen.queryByLabelText("Choose page photo")).toBeNull();
});

it("discards an OCR result that arrives after changing pages", async () => {
  let resolve;
  ocr.read.mockReturnValue(new Promise(done => { resolve = done; }));
  render(<PhotoTextVerification results={[page, other]} />);
  await choose();
  await waitFor(() => expect(ocr.read).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Signed page to compare"), { target: { value: "second" } });
  await act(async () => resolve([word("Account", 10), word("123456", 80)]));
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByText(/Recognized text matches/)).toBeNull();
  expect(ocr.dispose).toHaveBeenCalled();
});

it("removes photo evidence when the seal becomes invalid or a collection is cleared", async () => {
  const view = render(<PhotoTextVerification results={[page]} />);
  await choose();
  await screen.findByText(/Differences found/);
  view.rerender(<PhotoTextVerification results={[{ ...page, status: "INVALID" }]} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByLabelText("Choose page photo")).toBeNull();
});

it("reports a failed engine load without a matching result and permits retry", async () => {
  ocr.prepare.mockRejectedValueOnce(new Error("Offline resource unavailable"));
  render(<PhotoTextVerification results={[page]} />);
  fireEvent.click(screen.getByRole("button", { name: "Load text recognition" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Offline resource unavailable");
  expect(screen.getByLabelText("Choose page photo").disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Load text recognition" }));
  await screen.findByRole("button", { name: "Text recognition ready" });
  expect(screen.queryByRole("alert")).toBeNull();
});

const capture = (id, documentId = page.document_id, chunkNumber = 0) => ({
  id, documentId, chunkNumber, file: new File([`scan ${id}`], `scan-${id}.png`, { type: "image/png" }),
});

it("keeps a scan image before OCR loads and compares it automatically after loading", async () => {
  const image = capture(1);
  render(<PhotoTextVerification results={[page]} scanPhotos={[image]} />);
  await screen.findByRole("img");
  expect(ocr.open).toHaveBeenCalledWith(image.file);
  expect(ocr.read).not.toHaveBeenCalled();
  expect(screen.getByText(/The image is ready/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load text recognition" }));
  await screen.findByText(/Differences found/);
  expect(ocr.read).toHaveBeenCalledTimes(1);
});

it("waits for seal collection before automatic OCR and accepts a late scan image", async () => {
  const view = render(<PhotoTextVerification results={[page]} collecting />);
  fireEvent.click(screen.getByRole("button", { name: "Load text recognition" }));
  await screen.findByRole("button", { name: "Text recognition ready" });
  const images = [capture(1)];
  view.rerender(<PhotoTextVerification results={[page]} collecting scanPhotos={images} />);
  await screen.findByRole("img");
  expect(ocr.read).not.toHaveBeenCalled();
  view.rerender(<PhotoTextVerification results={[page]} scanPhotos={images} />);
  await screen.findByText(/Differences found/);
  expect(ocr.read).toHaveBeenCalledTimes(1);
});

it("uses the right image for out-of-order pages and never opens unverified captures", async () => {
  const first = capture(1), second = capture(2, other.document_id);
  const images = [second, first];
  const view = render(<PhotoTextVerification results={[{ ...page, status: "UNVERIFIED" }]} scanPhotos={images} />);
  expect(ocr.open).not.toHaveBeenCalled();
  view.rerender(<PhotoTextVerification results={[page, other]} scanPhotos={images} />);
  await screen.findByRole("img");
  expect(ocr.open).toHaveBeenLastCalledWith(first.file);
  fireEvent.change(screen.getByLabelText("Signed page to compare"), { target: { value: other.document_id } });
  await waitFor(() => expect(ocr.open).toHaveBeenLastCalledWith(second.file));
  await screen.findByRole("img");
  view.rerender(<PhotoTextVerification results={[]} session={1} scanPhotos={[]} />);
  expect(screen.queryByRole("img")).toBeNull();
});

it("keeps the reviewed image when another seal arrives and can select another capture after clearing", async () => {
  const first = capture(1), second = capture(2, page.document_id, 1);
  const view = render(<PhotoTextVerification results={[page]} scanPhotos={[first]} />);
  await screen.findByRole("img");
  view.rerender(<PhotoTextVerification results={[page]} scanPhotos={[first, second]} />);
  expect(ocr.open).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Captured scan image").value).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Clear photo" }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(ocr.open).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("Captured scan image"), { target: { value: "2" } });
  await screen.findByRole("img");
  expect(ocr.open).toHaveBeenLastCalledWith(second.file);
});

it("does not let a slow image load replace the newly selected page", async () => {
  let resolveOld;
  ocr.open.mockReturnValueOnce(new Promise(done => { resolveOld = done; }));
  render(<PhotoTextVerification results={[page, other]} scanPhotos={[capture(1), capture(2, other.document_id)]} />);
  await waitFor(() => expect(ocr.open).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText("Signed page to compare"), { target: { value: other.document_id } });
  await screen.findByRole("img");
  expect(screen.getByLabelText("Captured scan image").value).toBe("2");
  await act(async () => resolveOld({ width: 300, height: 200 }));
  expect(screen.getByLabelText("Captured scan image").value).toBe("2");
});

it("finishes preloading when a verified seal and its image arrive during loading", async () => {
  let prepared;
  ocr.prepare.mockReturnValueOnce(new Promise(done => { prepared = done; }));
  const view = render(<PhotoTextVerification />);
  fireEvent.click(screen.getByRole("button", { name: "Load text recognition" }));
  const disposals = ocr.dispose.mock.calls.length;
  view.rerender(<PhotoTextVerification results={[page]} scanPhotos={[capture(1)]} />);
  expect(ocr.dispose).toHaveBeenCalledTimes(disposals);
  expect(ocr.open).not.toHaveBeenCalled();
  await act(async () => prepared({}));
  await screen.findByText(/Differences found/);
  expect(ocr.prepare).toHaveBeenCalledTimes(1);
  expect(ocr.read).toHaveBeenCalledTimes(1);
});
