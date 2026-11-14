/* @vitest-environment jsdom */
/* eslint-disable no-unused-vars */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PhotoTextVerification } from "./PhotoTextVerification.jsx";

const ocr = vi.hoisted(() => ({ prepare: vi.fn(), read: vi.fn(), dispose: vi.fn(), open: vi.fn() }));
vi.mock("./photoOcr.js", () => ({ createPhotoOcrReader: () => ocr, openPagePhoto: ocr.open, photoPreviewUrl: vi.fn() }));
const page = { status: "VALID", signature_valid: true, document_id: "first", key_id: "trusted", content: "Friday", pdf: true, page_number: 1, page_count: 2 };
const other = { ...page, document_id: "second", page_number: 2 };
const capture = (id, documentId, text) => ({ id, documentId, file: { text } });
const word = text => ({ text, confidence: 99, bbox: { x0: 10, y0: 10, x1: 90, y1: 30 } });
beforeEach(() => {
  vi.clearAllMocks(); ocr.prepare.mockResolvedValue();
  ocr.read.mockImplementation(async canvas => [word(canvas.text)]);
  ocr.open.mockImplementation(async file => ({ width: 200, height: 100, text: file.text }));
  URL.createObjectURL = vi.fn(() => "blob:page-photo"); URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

it("opens conflicting dates alongside the original photo and keeps other rereads separate", async () => {
  const signed = { ...page, content: "03-14-27" };
  const first = word("03-14-29");
  ocr.read.mockResolvedValue({ words: [first], retryReviews: [
    { dateField: true, signedDate: signed.content, original: first.text, observed: signed.content,
      boxes: [first.bbox], lowConfidence: true },
    { original: "Tota", observed: "Total", boxes: [first.bbox] },
  ] });
  const view = render(<PhotoTextVerification results={[signed]} scanPhotos={[capture(1, "first", "unused")]} />);
  const dates = (await screen.findByText("Dates to check (1)")).closest("details");
  expect(dates.open).toBe(true);
  expect(dates.textContent).toContain("Signed date: 03-14-27");
  expect(dates.textContent).toContain("First reading: 03-14-29");
  expect(dates.textContent).toContain("Closer reading: 03-14-27 (low confidence)");
  expect(dates.querySelector("image").getAttribute("href")).toBe("blob:page-photo");
  expect(screen.getByText("Reread text to review (1)").closest("details").open).toBe(false);
  expect(view.container.querySelector(".photo-summary.differences")).toBeTruthy();
});

it("opens doubtful numbers for inspection and keeps other weak readings out of the change list", async () => {
  const signed = { ...page, content: "Top\nAmount 17\nStatus Y\nEnd" };
  signed.evidence = { width: 200, height: 100, text: signed.content, layout: { mode: 3,
    lines: [.05, .3, .55, .8].map(y => ({ x: .05, y, width: .85, height: .14 })) } };
  const located = (text, x, y, confidence = 99) => ({ text, confidence, bbox: { x0: x, y0: y, x1: x + 21, y1: y + 10 } });
  const words = [located("Top", 10, 6), located("Amount", 10, 31), located("I7", 70, 31, 35),
    located("Status", 10, 56), located("X", 70, 56, 35), located("End", 10, 81)];
  const corners = [{x:0,y:0},{x:200,y:0},{x:200,y:100},{x:0,y:100}];
  ocr.read.mockResolvedValue({ words, originalReading: words, corners });
  const view = render(<PhotoTextVerification results={[signed]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByText("Numbers to check (1)");
  const numeric = view.container.querySelector(".photo-number-review");
  expect(numeric.open).toBe(true);
  expect(numeric.textContent).toContain("Signed text: 17");
  expect(numeric.textContent).toContain("Photo reading: I7");
  expect(numeric.querySelector("rect.uncertain")).toBeTruthy();
  expect(view.container.querySelector(".photo-reading-review:not(.photo-number-review)").open).toBe(false);
  expect(view.container.querySelector(".photo-differences > ol")).toBeNull();
  expect(view.container.querySelector(".photo-summary.uncertain")).toBeTruthy();
});

it("shows a faint addition from the first reading when contrast-assisted text agrees", async () => {
  ocr.read.mockResolvedValue({ words: [word("Friday")], originalReading: [word("Friday"),
    { ...word("Paid"), confidence: 40, bbox: {x0:10,y0:50,x1:90,y1:70} }], contrastAssisted: true });
  const view = render(<PhotoTextVerification results={[page]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByText("First reading to review (1)");
  expect(view.container.querySelector(".photo-summary.uncertain")).toBeTruthy();
  const original = view.container.querySelector(".photo-original-reading");
  expect(original.textContent).toContain("Paid");
  expect(within(original).getByRole("img", { name: "Magnified photo difference", hidden: true })).toBeTruthy();
  expect(view.container.querySelector(".photo-summary.matches")).toBeNull();
});

it("separates word spacing and conflicting rereads without hiding substantive differences", async () => {
  const signed = { ...page, content: "Account 123456 Pay 100" };
  ocr.read.mockResolvedValue({ words: [word("Account123456"), word("Pay"), word("900")],
    retryReviews: [{ original: "900", observed: "100", boxes: [{x0:10,y0:10,x1:90,y1:30}] }] });
  const view = render(<PhotoTextVerification results={[signed]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByText("Word spacing to review (1)");
  expect(view.container.querySelector(".photo-spacing").open).toBe(false);
  expect(await screen.findByText("Reread text to review (1)")).toBeTruthy();
  expect(view.container.querySelector(".photo-differences > ol").textContent).toContain("900");
});

it("groups typography readings quietly while keeping a changed number prominent", async () => {
  const signed = { ...page, content: "‘Pay’ 100" };
  ocr.read.mockResolvedValue([word("'Pay'"), { ...word("900"), bbox: { x0: 100, y0: 10, x1: 150, y1: 30 } }]);
  const view = render(<PhotoTextVerification results={[signed]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByText("Typography to review (2)");
  const group = view.container.querySelector(".photo-typography");
  expect(group.open).toBe(false);
  expect(view.container.querySelectorAll(".photo-differences > ol > li")).toHaveLength(1);
  expect(view.container.querySelector(".photo-differences > ol").textContent).toContain("900");
  expect(screen.getByRole("button", { name: "Uncertain reading: 'Pay'" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Different or extra text: 900" })).toBeTruthy();
});

it("reports that every page is present rather than requesting another page", () => {
  render(<PhotoTextVerification results={[page, other]} scanning collectionProgress={{
    complete: true, finished: true, message: "All 2 pages collected.",
  }} />);
  expect(screen.getByText("All 2 pages collected.")).toBeTruthy();
  expect(screen.queryByText("Show the next page, or review the pages captured so far.")).toBeNull();
});

it("explains an unreliable reading without hiding missing signed wording", async () => {
  const signed = { ...page, content: "The invoice is not approved for payment" };
  ocr.read.mockResolvedValue("The invoice is approved for payment".split(" ").map(text => ({ ...word(text), confidence: 40 })));
  const view = render(<PhotoTextVerification results={[signed]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByText(/Many characters could not be read reliably/);
  expect(view.container.querySelector(".photo-differences").textContent).toContain("Signed text: not");
  expect(view.container.querySelector(".photo-summary.differences")).toBeTruthy();
});

it("checks all captured pages without extra clicks and opens page 2's changed word", async () => {
  render(<PhotoTextVerification results={[page, other]} scanPhotos={[capture(2, "second", "Monday"), capture(1, "first", "Friday")]} />);
  const review = await screen.findByRole("region", { name: "Review Page 2 of 2" });
  expect(within(review).getAllByText("Monday", { exact: false }).length).toBeGreaterThan(0);
  expect(within(review).getAllByText("Friday", { exact: false }).length).toBeGreaterThan(0);
  expect(within(review).getByRole("img", { name: "Magnified photo difference" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("heading", { name: /Page 2/ })));
  expect(screen.getByRole("button", { name: /Page 1 of 2.*Recognized text matches/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load text recognition" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Page 1 of 2.*Recognized text matches/ }));
  expect(screen.getByRole("region", { name: "Review Page 1 of 2" })).toBeTruthy();
  expect(ocr.read).toHaveBeenCalledTimes(2);
});

it("fits the page first, links its missing regions and words to difference cards, and resets on a page change", async () => {
  const content = "Top\nHeader\nRoom No\nEnd";
  const evidence = { width: 200, height: 100, text: content, layout: { mode: 3,
    lines: [.05, .3, .55, .8].map(y => ({ x: .05, y, width: .85, height: .14 })) } };
  const at = (text, y, x = 12) => ({ text, confidence: 99, bbox: { x0: x, x1: x + 28, y0: y, y1: y + 9 } });
  ocr.read.mockImplementation(async c => c.text === "second" ? [word("Friday")] : ({
    words: [at("Top", 6), at("Wrong", 56), at("No", 56, 70), at("End", 81)],
    corners: [{x:0,y:0},{x:200,y:0},{x:200,y:100},{x:0,y:100}],
  }));
  const view = render(<PhotoTextVerification results={[other, { ...page, content, evidence }]}
    scanPhotos={[capture(2, "second", "second"), capture(1, "first", "first")]} />);
  const first = await screen.findByRole("region", { name: "Review Page 1 of 2" });
  const photo = await within(first).findByRole("img", { name: "Page photo being compared with signed text" });
  expect(await within(first).findByText("Difference 1 of 2")).toBeTruthy();
  expect(photo.compareDocumentPosition(first.querySelector(".photo-differences")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(first.querySelector(".photo-differences > ol").textContent).toContain("Header");
  fireEvent.click(within(first).getByRole("button", { name: "Next difference" }));
  expect(first.querySelector(".photo-differences > ol").textContent).toContain("Wrong");
  expect(within(first).getByRole("button", { name: "Next difference" }).disabled).toBe(true);
  fireEvent.keyDown(within(first).getByRole("button", { name: "Difference 1: Header" }), { key: "Enter" });
  expect(first.querySelector(".photo-differences > ol").textContent).toContain("Header");
  fireEvent.click(within(first).getByRole("button", { name: "Different or extra text: Wrong" }));
  expect(within(first).getByText("Difference 2 of 2")).toBeTruthy();
  fireEvent.change(within(first).getByRole("combobox", { name: "Zoom" }), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: /Page 2 of 2 · Seal authenticated/ }));
  const second = screen.getByRole("region", { name: "Review Page 2 of 2" });
  expect(within(second).getByRole("combobox", { name: "Zoom" }).value).toBe("1");
  expect(within(second).queryByText("Difference 2 of 2")).toBeNull();
  expect(view.container.querySelector(".photo-scroll.zoomed")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Page 1 of 2 · Seal authenticated/ }));
  expect(screen.getByText("Difference 1 of 2")).toBeTruthy();
});

it("shows reported processing progress without claiming completion before the comparison", async () => {
  let report, finish;
  ocr.read.mockImplementation((_, onProgress) => {
    report = onProgress;
    return new Promise(resolve => { finish = resolve; });
  });
  render(<PhotoTextVerification results={[page]} scanPhotos={[capture(1, "first", "Monday")]} />);
  await waitFor(() => expect(report).toBeTypeOf("function"));
  expect(screen.getByText("Photo captured — processing…")).toBeTruthy();
  act(() => report({ status: "recognizing text", progress: .03 }));
  expect(screen.getByText("Photo captured — processing 3% completed")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Printed-text recognition" }).value).toBe(.03);
  act(() => report({ status: "recognizing text", progress: 1 }));
  expect(screen.getByText("Photo captured — processing…")).toBeTruthy();
  expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
  await act(async () => finish([word("Monday")]));
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getAllByText("Differences found — review the marked text").length).toBeGreaterThan(0);
});
it("opens a later difference ahead of an earlier uncertain reading", async () => {
  ocr.read.mockImplementation(async canvas => [{ ...word(canvas.text), confidence: canvas.text === "Friday" ? 70 : 99 }]);
  render(<PhotoTextVerification results={[page, other]} scanPhotos={[capture(1, "first", "Friday"), capture(2, "second", "Monday")]} />);
  const review = await screen.findByRole("region", { name: "Review Page 2 of 2" });
  await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("heading", { name: /Page 2/ })));
  expect(within(review).getAllByText("Monday", { exact: false }).length).toBeGreaterThan(0);
});
it.each(["INVALID", "UNVERIFIED", "INCOMPLETE", "ERROR"])("does not compare %s reference text", status => {
  render(<PhotoTextVerification results={[{ ...page, status }]} scanPhotos={[capture(1, "first", "Friday")]} />);
  expect(ocr.read).not.toHaveBeenCalled(); expect(screen.queryByRole("img")).toBeNull();
});
it("allows a partial document check when the camera stops and marks missing pages", async () => {
  const props = { results: [other], scanPhotos: [capture(2, "second", "Monday")] };
  const view = render(<PhotoTextVerification {...props} scanning />);
  expect(ocr.read).not.toHaveBeenCalled();
  view.rerender(<PhotoTextVerification {...props} />);
  await screen.findByRole("button", { name: /Different or extra text: Monday/ });
  expect(screen.getByText(/Other pages have not been checked/)).toBeTruthy();
});
it("clears images and text when a new session starts", async () => {
  const view = render(<PhotoTextVerification results={[page]} scanPhotos={[capture(1, "first", "Monday")]} />);
  await screen.findByRole("button", { name: /Different or extra text: Monday/ });
  view.rerender(<PhotoTextVerification session={1} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByText("Monday", { exact: false })).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:page-photo");
  expect(ocr.dispose).toHaveBeenCalled();
});
it("does not offer a file-capture handoff and makes retakes available without loading OCR manually", async () => {
  const view = render(<PhotoTextVerification results={[page]} onReplacePhoto={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Retake this page" })).toBeTruthy();
  expect(view.container.querySelector("input[capture]")).toBeNull();
  expect(view.container.querySelector("input[type=file]")).toBeNull();
});
