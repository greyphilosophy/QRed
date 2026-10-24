/* @vitest-environment jsdom */
/* eslint-disable no-unused-vars */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageEvidenceVerification } from "./PageEvidenceVerification.jsx";

const photo = vi.hoisted(() => ({ open: vi.fn(), preview: vi.fn() }));
vi.mock("./photoOcr.js", () => ({ openPagePhoto: photo.open, photoPreviewUrl: photo.preview }));
const evidence = { text: "Account 123456", width: 612, height: 792, blank: false,
  layout: { mode: 1, lines: [{ x: 0.25, y: 0.125, width: 0.0625, height: 0.0625 }] },
  visual: { codebook: 1, columns: 2, rows: 2, indices: new Uint8Array([0, 15, 10, 5]) } };
const page = { document_id: "first", page_hash: "hash", page_number: 1, page_count: 2,
  status: "VALID", signature_valid: true, evidence };
const other = { ...page, document_id: "second", page_number: 2 };
const capture = { documentId: "first", id: 1, chunkNumber: 0, file: new File(["fake"], "capture.png") };

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData: vi.fn(),
  });
  URL.revokeObjectURL = vi.fn();
  photo.open.mockResolvedValue({ width: 100, height: 200 });
  photo.preview.mockResolvedValue("blob:reference-photo");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it("shows offline reconstructed pixels and a signed line location", () => {
  render(<PageEvidenceVerification results={[page]} />);
  expect(screen.getByRole("img", { name: "Signed grayscale visual reference" }).width).toBe(8);
  fireEvent.change(screen.getByLabelText("Locate signed text"), { target: { value: "0" } });
  const marker = screen.getByLabelText("Signed line location").querySelector("rect");
  expect(marker.getAttribute("x")).toBe("0.25");
  expect(marker.getAttribute("y")).toBe("0.125");
  expect(screen.getByText(/does not give an automatic image-match verdict/)).toBeTruthy();
});
it.each(["INVALID", "UNVERIFIED", "INCOMPLETE", "ERROR"])("never labels %s image data as a signed reference", status => {
  render(<PageEvidenceVerification results={[{ ...page, status }]} scanPhotos={[capture]} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByLabelText("Choose visual comparison photo")).toBeNull();
  expect(photo.open).not.toHaveBeenCalled();
});
it("allows image-only and blank references without loading text recognition", async () => {
  const view = render(<PageEvidenceVerification results={[{ ...page, evidence: { ...evidence, text: "", layout: null } }]} scanPhotos={[capture]} />);
  expect(screen.getByLabelText("Choose visual comparison photo").disabled).toBe(false);
  await screen.findByRole("img", { name: "Page photo beside the signed visual reference" });
  expect(photo.open).toHaveBeenCalledWith(capture.file);
  view.rerender(<PageEvidenceVerification results={[{ ...other, evidence: { text: "", width: 612, height: 792, blank: true } }]} />);
  expect(screen.getByText(/signer recorded this page as blank/)).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:reference-photo");
});
it("orders pages and discards late photos after changing the selected page", async () => {
  let resolve;
  photo.open.mockReturnValue(new Promise(done => { resolve = done; }));
  render(<PageEvidenceVerification results={[other, page]} scanPhotos={[capture]} />);
  expect(screen.getByLabelText("Reference page").value).toBe("first");
  await waitFor(() => expect(photo.open).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Reference page"), { target: { value: "second" } });
  await act(async () => resolve({ width: 100, height: 200 }));
  expect(screen.queryByRole("img", { name: "Page photo beside the signed visual reference" })).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:reference-photo");
});
it("removes the complete comparison when verification becomes invalid", async () => {
  const view = render(<PageEvidenceVerification results={[page]} scanPhotos={[capture]} />);
  await screen.findByRole("img", { name: "Page photo beside the signed visual reference" });
  view.rerender(<PageEvidenceVerification results={[{ ...page, status: "INVALID" }]} scanPhotos={[capture]} />);
  expect(screen.queryByRole("region")).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:reference-photo");
});
