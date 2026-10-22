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
