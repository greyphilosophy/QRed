/* @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyTextRetries } from "./photoOcrRetry.js";
import { cropBounds } from "./ReviewReading.jsx";
import { PhotoTextVerification } from "./PhotoTextVerification.jsx";

const ocr = vi.hoisted(() => ({ prepare: vi.fn(), read: vi.fn(), dispose: vi.fn(), open: vi.fn() }));
vi.mock("./photoOcr.js", () => ({ createPhotoOcrReader: () => ocr, openPagePhoto: ocr.open, photoPreviewUrl: vi.fn() }));
const retakeCamera = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("./PageCameraCapture.jsx", () => ({ PageCameraCapture: ({ pageLabel, onClose }) => {
  React.useEffect(() => { retakeCamera.start(); return () => retakeCamera.stop(); }, []);
  return <div role="dialog" aria-label={`Retake ${pageLabel}`}><button type="button" onClick={onClose}>Cancel retake</button></div>;
} }));
const page = { status: "VALID", signature_valid: true, document_id: "first", key_id: "trusted", content: "Friday", pdf: true, page_number: 1, page_count: 2 };
const other = { ...page, document_id: "second", page_number: 2 };
const capture = (id, documentId, text) => ({ id, documentId, file: { text } });
const word = text => ({ text, confidence: 99, bbox: { x0: 10, y0: 10, x1: 90, y1: 30 } });
beforeEach(() => {
  vi.clearAllMocks(); ocr.prepare.mockResolvedValue();
  ocr.read.mockImplementation(async canvas => [word(canvas.text)]);
  ocr.open.mockImplementation(async file => ({ width: 200, height: 100, text: file.text }));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  URL.createObjectURL = vi.fn(() => "blob:page-photo"); URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);
const currentCard = container => container.querySelector(".photo-differences > ol > li");
function readAllCards(container) {
  const total = Number(container.querySelector(".photo-differences").dataset.count), cards = [];
  for (let index = 0; index < total; index++) {
    cards.push(currentCard(container).textContent);
    if (index + 1 < total) fireEvent.click(screen.getByRole("button", { name: "Next reading", exact: true }));
  }
  return cards;
}

it.each(["2017", "2012"])("drops a resolved page number from the review and summary alongside year %s", async year => {
  const signed = { ...page, page_count: 1, content: "1 of 2\nYear 2017" };
  const at = (text, x0, x1, y0, confidence = 98) => ({ text, confidence, bbox: { x0, x1, y0, y1: y0 + 10 } });
  const two = at("2", 55, 64, 10);
  const firstPass = [at("‘dof", 10, 47, 10, 45), two, at("Year", 10, 47, 50), at(year, 55, 95, 50)];
  ocr.read.mockResolvedValue(applyTextRetries(firstPass, [{
    candidate: { indices: [0, 1], signedLine: true, signedText: "1 of 2", bbox: { x0: 8, x1: 66, y0: 8, y1: 22 } },
    words: [at("1", 10, 18, 10), at("of", 26, 47, 10), two],
  }]));
  const view = render(<PhotoTextVerification results={[signed]} scanPhotos={[capture(1, "first", "unused")]} />);
  const count = year === "2017" ? 0 : 1;
  await waitFor(() => expect(view.container.querySelector(".photo-differences")?.dataset.count).toBe(String(count)));
  expect(view.container.textContent).not.toMatch(/explained readings|‘dof/i);
  if (count) {
    expect(currentCard(view.container).textContent).toContain("2012");
    expect(screen.getByText("Reading 1 of 1")).toBeTruthy();
  } else {
    expect(currentCard(view.container)).toBeNull();
    expect(view.container.querySelector(".photo-summary.matches")).toBeTruthy();
  }
  fireEvent.click(screen.getByRole("button", { name: "Review summary", exact: true }));
  if (count) {
    expect(screen.getByText("0 of 1 review decisions recorded.")).toBeTruthy();
  } else {
    expect(screen.getByText("No flagged readings to review")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revisit readings" })).toBeNull();
    expect(screen.queryByText(/review decisions recorded/)).toBeNull();
  }
});

it("includes conflicting dates and other rereads in one navigable queue", async () => {
  const signed = { ...page, content: "03-14-27" };
  const first = word("03-14-29");
  ocr.read.mockResolvedValue({ words: [first], retryReviews: [
    { dateField: true, signedDate: signed.content, original: first.text, observed: signed.content,
      boxes: [first.bbox], lowConfidence: true },
    { original: "Tota", observed: "Total", boxes: [first.bbox] },
  ] });
  const view = render(<PhotoTextVerification results={[signed]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByText("Conflicting date readings");
  const dates = currentCard(view.container);
  expect(dates.textContent).toContain("Sealed text: 03-14-27");
  expect(dates.textContent).toContain("First reading: 03-14-29");
  expect(dates.textContent).toContain("Closer reading: 03-14-27 (uncertain)");
  expect(dates.querySelector("image").getAttribute("href")).toBe("blob:page-photo");
  fireEvent.click(screen.getByRole("button", { name: "Next reading", exact: true }));
  expect(currentCard(view.container).textContent).toContain("Closer reading: Total");
  expect(view.container.querySelector(".photo-summary.differences")).toBeNull();
  expect(view.container.querySelector(".review-progress")).toBeTruthy();
});

it("prioritizes doubtful numbers and keeps other weak readings reachable", async () => {
  const signed = { ...page, content: "Top\nAmount 17\nStatus Y\nEnd" };
  signed.evidence = { width: 200, height: 100, text: signed.content, layout: { mode: 3,
    lines: [.05, .3, .55, .8].map(y => ({ x: .05, y, width: .85, height: .14 })) } };
  const located = (text, x, y, confidence = 99) => ({ text, confidence, bbox: { x0: x, y0: y, x1: x + 21, y1: y + 10 } });
  const words = [located("Top", 10, 6), located("Amount", 10, 31), located("I7", 70, 31, 35),
    located("Status", 10, 56), located("X", 70, 56, 35), located("End", 10, 81)];
  const corners = [{x:0,y:0},{x:200,y:0},{x:200,y:100},{x:0,y:100}];
  ocr.read.mockResolvedValue({ words, originalReading: words, corners });
  const view = render(<PhotoTextVerification results={[signed]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByText("Number or date");
  const numeric = currentCard(view.container);
  expect(numeric.querySelector(".review-sealed-text").textContent).toContain("Sealed text: Amount 17");
  expect(numeric.textContent).toContain("Photo reading: I7");
  expect(numeric.querySelector("rect.uncertain")).toBeTruthy();
  const cards = readAllCards(view.container);
  expect(cards.some(card => card.includes("Photo reading: X"))).toBe(true);
  expect(view.container.querySelector(".photo-summary.uncertain")).toBeNull();
  expect(view.container.querySelector(".review-progress")).toBeTruthy();
});

it("shows a faint addition from the first reading when contrast-assisted text agrees", async () => {
  ocr.read.mockResolvedValue({ words: [word("Friday")], originalReading: [word("Friday"),
    { ...word("Paid"), confidence: 40, bbox: {x0:10,y0:50,x1:90,y1:70} }], contrastAssisted: true });
  const view = render(<PhotoTextVerification results={[page]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByText("Possible extra text");
  expect(view.container.querySelector(".photo-summary.uncertain")).toBeNull();
  expect(view.container.querySelector(".review-progress")).toBeTruthy();
  const original = currentCard(view.container);
  expect(original.textContent).toContain("Paid");
  expect(within(original).getByRole("img", { name: "Magnified photo difference" })).toBeTruthy();
  expect(original.textContent).toContain("The first reading found this");
  fireEvent.click(screen.getByRole("button", { name: "Next reading", exact: true }));
  expect(currentCard(view.container).textContent).toContain("Pale text and marks");
  expect(view.container.querySelector(".photo-summary.matches")).toBeNull();
});

it("keeps spacing and conflicting rereads in the same queue after substantive changes", async () => {
  const signed = { ...page, content: "Account 123456 Pay 100" };
  ocr.read.mockResolvedValue({ words: [word("Account123456"), word("Pay"), word("900")],
    retryReviews: [{ original: "900", observed: "100", boxes: [{x0:10,y0:10,x1:90,y1:30}] }] });
  const view = render(<PhotoTextVerification results={[signed]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByText("Number or date");
  const cards = readAllCards(view.container);
  expect(cards[0]).toContain("Photo reading: 900");
  expect(cards.some(card => card.includes("Word spacing"))).toBe(true);
  expect(cards.some(card => card.includes("Closer reading: 100"))).toBe(true);
});

it("reviews changed numbers before typography without hiding either", async () => {
  const signed = { ...page, content: "‘Pay’ 100" };
  ocr.read.mockResolvedValue([word("'Pay'"), { ...word("900"), bbox: { x0: 100, y0: 10, x1: 150, y1: 30 } }]);
  const view = render(<PhotoTextVerification results={[signed]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByText("Number or date");
  expect(view.container.querySelectorAll(".photo-differences > ol > li")).toHaveLength(1);
  const cards = readAllCards(view.container);
  expect(cards[0]).toContain("900");
  expect(cards.filter(card => card.includes("Typography"))).toHaveLength(2);
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
  expect(view.container.querySelector(".review-sealed-text").textContent).toContain("The invoice is not approved for payment");
  expect(view.container.querySelector(".photo-summary.differences")).toBeNull();
  expect(view.container.querySelector(".review-progress")).toBeTruthy();
  expect(view.container.querySelector(".photo-differences .difference-thumbnail")).toBeNull();
  expect(view.container.querySelector(".photo-differences").textContent).toContain("No reliable photo location");
});

it("checks all captured pages without extra clicks and opens page 2's changed word", async () => {
  render(<PhotoTextVerification results={[page, other]} scanPhotos={[capture(2, "second", "Monday"), capture(1, "first", "Friday")]} />);
  const review = await screen.findByRole("region", { name: "Review Page 2 of 2" });
  expect(currentCard(review).textContent).toContain("Monday");
  expect(currentCard(review).textContent).toContain("Friday");
  expect(within(review).getByRole("img", { name: "Magnified photo difference" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("heading", { name: /Page 2/ })));
  expect(screen.getByRole("button", { name: /Page 1 of 2.*Recognized text matches/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load text recognition" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Page 1 of 2.*Recognized text matches/ }));
  expect(screen.getByRole("region", { name: "Review Page 1 of 2" })).toBeTruthy();
  expect(ocr.read).toHaveBeenCalledTimes(2);
});

it("reviews the wording and crop before navigation, links full-page highlights, and remembers each page’s position", async () => {
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
  expect(await within(first).findByText("Reading 1 of 2")).toBeTruthy();
  const card = first.querySelector(".photo-differences > ol");
  const thumbnail = within(card).getByRole("img", { name: "Page thumbnail showing text location" });
  const crop = within(card).getByRole("img", { name: "Magnified photo difference" });
  const boxes = (element, selector) => [...element.querySelectorAll(selector)].map(rect =>
    ["x", "y", "width", "height"].map(attribute => rect.getAttribute(attribute)));
  const thumbnailBoxes = () => boxes(thumbnail, ".difference-location-mark");
  const cropBoxes = () => boxes(crop, "rect");
  expect(thumbnail.getAttribute("viewBox")).toBe("0 0 200 100");
  expect(thumbnail.querySelector("image").getAttribute("href")).toBe(photo.getAttribute("src"));
  const missingLocation = thumbnailBoxes();
  expect(missingLocation).toHaveLength(1);
  expect(missingLocation).toEqual(cropBoxes());
  const navigation = within(first).getByRole("group", { name: "Reading navigation" });
  expect(card.compareDocumentPosition(navigation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(navigation.compareDocumentPosition(photo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(first.querySelector(".photo-differences > ol").textContent).toContain("Header");
  fireEvent.click(within(first).getByRole("button", { name: "Next reading" }));
  expect(first.querySelector(".photo-differences > ol").textContent).toContain("Wrong");
  expect(thumbnailBoxes()).not.toEqual(missingLocation);
  expect(thumbnailBoxes()).toHaveLength(1);
  expect(thumbnailBoxes()).toEqual(cropBoxes());
  expect(within(first).getByRole("button", { name: "Review summary" }).disabled).toBe(false);
  // The replacement word must be the only hit target at its location; a
  // duplicate region above it intercepts real pointer clicks in the browser.
  const wordTarget = within(first).getByRole("button", { name: "Different or extra text: Wrong" });
  const wordBox = boxes(wordTarget.parentElement, 'rect[aria-label="Different or extra text: Wrong"]')[0];
  expect(boxes(wordTarget.parentElement, 'rect[role="button"]').filter(box =>
    JSON.stringify(box) === JSON.stringify(wordBox))).toHaveLength(1);
  fireEvent.keyDown(within(first).getByRole("button", { name: "Reading 1: Header" }), { key: "Enter" });
  expect(first.querySelector(".photo-differences > ol").textContent).toContain("Header");
  expect(thumbnailBoxes()).toEqual(missingLocation);
  expect(document.activeElement).toBe(within(first).getByRole("heading", { name: "Reading 1 of 2" }));
  fireEvent.click(within(first).getByRole("button", { name: "Different or extra text: Wrong" }));
  expect(within(first).getByText("Reading 2 of 2")).toBeTruthy();
  fireEvent.click(within(first).getByRole("button", { name: "Previous reading" }));
  expect(card.textContent).toContain("Header");
  fireEvent.click(within(first).getByRole("button", { name: "All page highlights" }));
  expect(document.activeElement).toBe(within(first).getByRole("heading", { name: "Full page" }));
  fireEvent.click(within(first).getByRole("button", { name: "Back to reading" }));
  expect(document.activeElement).toBe(within(first).getByRole("heading", { name: "Reading 1 of 2" }));
  fireEvent.click(within(first).getByRole("button", { name: "Next reading" }));
  fireEvent.click(within(first).getByRole("button", { name: "Printed text differs" }));
  fireEvent.click(within(first).getByRole("button", { name: "200%" }));
  fireEvent.click(screen.getByRole("button", { name: /Page 2 of 2 · Seal authenticated/ }));
  const second = screen.getByRole("region", { name: "Review Page 2 of 2" });
  expect(within(second).getByRole("button", { name: "Fit", exact: true }).getAttribute("aria-pressed")).toBe("true");
  expect(within(second).queryByText("Reading 2 of 2")).toBeNull();
  expect(within(second).queryByRole("img", { name: "Page thumbnail showing text location" })).toBeNull();
  expect(view.container.querySelector(".photo-scroll.zoomed")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Page 1 of 2 · Seal authenticated/ }));
  expect(screen.getByText("Reading 2 of 2")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Printed text differs" }).getAttribute("aria-pressed")).toBe("true");
  expect(boxes(screen.getByRole("img", { name: "Page thumbnail showing text location" }), ".difference-location-mark")).not.toEqual(missingLocation);
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
  expect(screen.queryByText(/1 reading to review/)).toBeNull();
  expect(screen.getByText("Reading 1 of 1")).toBeTruthy();
  expect(screen.getByRole("group", { name: "Does the photo or paper match the sealed text?" })).toBeTruthy();
});
it("opens a later difference ahead of an earlier uncertain reading", async () => {
  ocr.read.mockImplementation(async canvas => [{ ...word(canvas.text), confidence: canvas.text === "Friday" ? 70 : 99 }]);
  render(<PhotoTextVerification results={[page, other]} scanPhotos={[capture(1, "first", "Friday"), capture(2, "second", "Monday")]} />);
  const review = await screen.findByRole("region", { name: "Review Page 2 of 2" });
  await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("heading", { name: /Page 2/ })));
  expect(currentCard(review).textContent).toContain("Monday");
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

it("releases a retake when leaving the task while preserving decisions and the reading position", async () => {
  const props = { results: [{ ...page, page_count: 1, content: "Pay 100 Due Friday" }],
    scanPhotos: [capture(1, "first", "two")], onReplacePhoto: vi.fn() };
  ocr.read.mockResolvedValue([word("Pay"), word("900"), word("Due"), word("Monday")]);
  const view = render(<PhotoTextVerification {...props} />);
  await screen.findByText("Reading 1 of 2");
  fireEvent.click(screen.getByRole("button", { name: "Next reading", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Matches sealed text", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Retake this page", exact: true }));
  expect(screen.getByRole("dialog", { name: "Retake Page 1 of 1" })).toBeTruthy();
  expect(retakeCamera.start).toHaveBeenCalledTimes(1);

  view.rerender(<PhotoTextVerification {...props} active={false} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(retakeCamera.stop).toHaveBeenCalledTimes(1);
  view.rerender(<PhotoTextVerification {...props} active />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(retakeCamera.start).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Reading 2 of 2")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Matches sealed text", exact: true }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Retake this page", exact: true }));
  expect(retakeCamera.start).toHaveBeenCalledTimes(2);
});

it("closes the enlarged viewer and restores scrolling when the task becomes inactive", async () => {
  const props = { results: [page], scanPhotos: [capture(1, "first", "Monday")] };
  const view = render(<PhotoTextVerification {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Printed text differs", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Enlarge close-up", exact: true }));
  expect(screen.getByRole("dialog", { name: "Enlarged close-up" })).toBeTruthy();
  expect(document.body.style.overflow).toBe("hidden");
  view.rerender(<PhotoTextVerification {...props} active={false} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.style.overflow).toBe("");
  view.rerender(<PhotoTextVerification {...props} active />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Printed text differs", exact: true }).getAttribute("aria-pressed")).toBe("true");
});

it("finishes OCR in an inactive task without moving focus or scrolling the visible view", async () => {
  let finishRead;
  ocr.read.mockImplementation(() => new Promise(resolve => { finishRead = resolve; }));
  const props = { results: [page], scanPhotos: [capture(1, "first", "Monday")] };
  function Views({ active }) {
    return <><button type="button">About QRed</button><div hidden={!active}><PhotoTextVerification {...props} active={active} /></div></>;
  }
  const previousScroll = HTMLElement.prototype.scrollIntoView, scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    const view = render(<Views active />);
    await waitFor(() => expect(ocr.read).toHaveBeenCalledTimes(1));
    view.rerender(<Views active={false} />);
    const about = screen.getByRole("button", { name: "About QRed" });
    about.focus(); scroll.mockClear();
    await act(async () => finishRead([word("Monday")]));
    await waitFor(() => expect(view.container.querySelector(".photo-differences")?.dataset.count).toBe("1"));
    expect(document.activeElement).toBe(about);
    expect(scroll).not.toHaveBeenCalled();
    view.rerender(<Views active />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: /Page 1 of 2/ })));
  } finally {
    if (previousScroll === undefined) delete HTMLElement.prototype.scrollIntoView;
    else HTMLElement.prototype.scrollIntoView = previousScroll;
  }
});

it("tracks decisions across pages, leaves skipped readings pending, and allows corrections from the summary", async () => {
  const first = { ...page, content: "Pay 100 Due Friday" };
  ocr.read.mockImplementation(async canvas => canvas.text === "two" ? [word("Pay"), word("900"), word("Due"), word("Monday")] : [word("Monday")]);
  const view = render(<PhotoTextVerification results={[first, other]}
    scanPhotos={[capture(1, "first", "two"), capture(2, "second", "one")]} />);
  await screen.findByText("Reading 1 of 2");
  fireEvent.click(screen.getByRole("button", { name: "Next reading", exact: true }));
  expect(view.container.querySelector(".review-progress").textContent).toContain("0/2 reviewed");
  fireEvent.click(screen.getByRole("button", { name: "Can't tell", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Next page to review", exact: true }));
  expect(screen.getByRole("region", { name: "Review Page 2 of 2" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Matches sealed text", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Review summary", exact: true }));
  const summary = screen.getByRole("region", { name: "Review summary", exact: true });
  expect(summary.textContent).toContain("2 of 3 review decisions recorded");
  expect(summary.textContent).toContain("Review in progress");
  expect(within(summary).getByText("Can't tell").nextElementSibling.textContent).toBe("1");
  expect(within(summary).getByText("No decision yet").nextElementSibling.textContent).toBe("1");
  expect(document.activeElement).toBe(within(summary).getByRole("heading", { name: "Review summary" }));
  fireEvent.click(within(summary).getByRole("button", { name: "Continue review" }));
  expect(screen.getByText("Reading 1 of 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Printed text differs", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Next reading", exact: true }));
  expect(screen.getByRole("button", { name: "Can't tell", exact: true }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Matches sealed text", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Review summary", exact: true }));
  expect(screen.getByText("Review finished — discrepancies recorded")).toBeTruthy();
  expect(screen.getByText("3 of 3 review decisions recorded.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Page 1 of 2.*2\/2 reviewed/ }));
  expect(screen.getByText("Reading 2 of 2")).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: /Page 1 of 2/ }));
  fireEvent.click(screen.getByRole("button", { name: "Previous reading", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Matches sealed text", exact: true }));
  expect(view.container.querySelector(".photo-summary.differences")).toBeNull();
  expect(view.container.querySelector(".review-progress")).toBeTruthy();
  expect(view.container.querySelector(".page-check-status.differences")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review summary", exact: true }));
  expect(screen.getByText("All flagged readings reviewed")).toBeTruthy();
  expect(screen.queryByText(/document verified/i)).toBeNull();
});

it("reports unclear decisions and incomplete documents honestly", async () => {
  const props = { results: [page], scanPhotos: [capture(1, "first", "Monday")] };
  const view = render(<PhotoTextVerification {...props} />);
  await screen.findByRole("button", { name: "Can't tell", exact: true });
  fireEvent.click(screen.getByRole("button", { name: "Can't tell", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Review summary", exact: true }));
  expect(screen.getByText("Document check incomplete")).toBeTruthy();
  expect(screen.getByText("1 of 1 review decisions recorded.")).toBeTruthy();
  view.rerender(<PhotoTextVerification results={[{ ...page, page_count: 1 }]} scanPhotos={props.scanPhotos} />);
  // The signed contents and photo are unchanged, so the decision survives a
  // collection metadata refresh. It still cannot become a successful verdict.
  expect(await screen.findByText("Review finished with unclear readings")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue review", exact: true }));
  expect(screen.getByRole("button", { name: "Can't tell", exact: true }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Can't tell", exact: true }));
  expect(view.container.querySelector(".review-progress").textContent).toContain("0/1 reviewed");
});

it("clears only the retaken page's decisions and clears all decisions in a new session", async () => {
  const results = [page, other], firstCapture = capture(1, "first", "Monday"), secondCapture = capture(2, "second", "Monday");
  const view = render(<PhotoTextVerification results={results} scanPhotos={[firstCapture, secondCapture]} />);
  await screen.findByRole("button", { name: "Matches sealed text", exact: true });
  fireEvent.click(screen.getByRole("button", { name: "Matches sealed text", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: /Page 2 of 2 · Seal authenticated/ }));
  fireEvent.click(screen.getByRole("button", { name: "Printed text differs", exact: true }));
  view.rerender(<PhotoTextVerification results={results} scanPhotos={[capture(3, "first", "Saturday"), secondCapture]} />);
  await waitFor(() => expect(ocr.read).toHaveBeenCalledTimes(3));
  expect(screen.getByRole("button", { name: "Printed text differs", exact: true }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /Page 1 of 2 · Seal authenticated/ }));
  expect(view.container.querySelector(".review-progress").textContent).toContain("0/1 reviewed");
  expect(currentCard(view.container).textContent).toContain("Saturday");
  expect(screen.getByRole("button", { name: "Matches sealed text", exact: true }).getAttribute("aria-pressed")).toBe("false");
  view.rerender(<PhotoTextVerification session={1} results={results} scanPhotos={[firstCapture, secondCapture]} />);
  await screen.findByRole("button", { name: "Matches sealed text", exact: true });
  expect(view.container.querySelector(".review-progress").textContent).toContain("0/1 reviewed");
});

it("enlarges the current evidence, lets the user hide the marker, and restores focus on Escape", async () => {
  const view = render(<PhotoTextVerification results={[page]} scanPhotos={[capture(1, "first", "Monday")]} />);
  const opener = await screen.findByRole("button", { name: "Enlarge close-up", exact: true });
  const marks = view.container.querySelectorAll(".review-wording mark");
  expect([...marks].map(mark => mark.textContent).join(" ")).toContain("Mon");
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Enlarged close-up" });
  expect(dialog.querySelector("image").getAttribute("href")).toBe("blob:page-photo");
  expect(dialog.querySelectorAll(".difference-location-mark")).toHaveLength(1);
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Show highlight" }));
  expect(dialog.querySelectorAll(".difference-location-mark")).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: "200%" }));
  expect(dialog.querySelector("svg").style.width).toBe("200%");
  fireEvent.click(within(dialog).getByRole("button", { name: "Show full page" }));
  expect(dialog.querySelector("svg").getAttribute("viewBox")).toBe("0 0 200 100");
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Enlarge page location" }));
  expect(screen.getByRole("dialog", { name: "Page location" }).querySelector("svg").getAttribute("viewBox")).toBe("0 0 200 100");
  fireEvent.click(screen.getByRole("button", { name: "Back to review" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Enlarge page location" }));
});

it("adds missing pages from review or summary while retaining existing decisions", async () => {
  const onScanMore = vi.fn(), onChooseMore = vi.fn();
  const props = { results: [page], scanPhotos: [capture(1, "first", "Monday")], onScanMore, onChooseMore };
  const view = render(<PhotoTextVerification {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Printed text differs", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Scan next page" }));
  expect(onScanMore).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Review summary", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Choose next page" }));
  expect(onChooseMore).toHaveBeenCalledTimes(1);
  view.rerender(<PhotoTextVerification {...props} results={[page, other]} scanPhotos={[...props.scanPhotos, capture(2, "second", "Friday")]} />);
  await screen.findByText("Review finished — discrepancies recorded");
  expect(screen.queryByRole("group", { name: "Add missing pages" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Revisit readings" }));
  expect(screen.getByRole("button", { name: "Printed text differs", exact: true }).getAttribute("aria-pressed")).toBe("true");
});

it("opens the nearest reading from beside a small highlight at fit and enlarged sizes", async () => {
  const signed = { ...page, content: "Friday 100" };
  ocr.read.mockResolvedValue([word("Monday"), { ...word("900"), bbox: { x0: 100, y0: 40, x1: 140, y1: 50 } }]);
  const view = render(<PhotoTextVerification results={[signed]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByText("Number or date");
  const stage = view.container.querySelector(".photo-stage");
  // At half scale the targets are 40×10 and 20×5 CSS pixels, separated by 5 px.
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 50 });
  fireEvent.click(stage, { clientX: 51, clientY: 16 });
  expect(currentCard(view.container).textContent).toContain("900");
  fireEvent.click(stage, { clientX: 25, clientY: 35 });
  expect(currentCard(view.container).textContent).toContain("Monday");
  // Empty space is not a target, even when an item is already selected.
  fireEvent.click(stage, { clientX: 99, clientY: 49 });
  expect(currentCard(view.container).textContent).toContain("Monday");
  fireEvent.click(within(screen.getByRole("group", { name: "Page zoom" })).getByRole("button", { name: "200%" }));
  stage.getBoundingClientRect = () => ({ left: -100, top: -20, width: 400, height: 200 });
  fireEvent.click(stage, { clientX: 145, clientY: 100 });
  expect(currentCard(view.container).textContent).toContain("900");
  // The exact word stays keyboard accessible, with no duplicate overlay.
  fireEvent.keyDown(screen.getByRole("button", { name: "Different or extra text: Monday" }), { key: "Enter" });
  expect(currentCard(view.container).textContent).toContain("Monday");
});


it("keeps double-spaced neighboring lines in the crop at different photo resolutions", () => {
  for (const scale of [1, 3]) {
    const size = { width: 1200 * scale, height: 1600 * scale };
    const selected = { x0: 400 * scale, y0: 500 * scale, x1: 580 * scale, y1: 530 * scale };
    const crop = cropBounds(size, [selected]);
    // Thirty-pixel glyphs on a 100-pixel baseline: include the full line above
    // and below, while the marker remains tied to the selected text.
    expect(crop.top).toBeLessThanOrEqual(400 * scale);
    expect(crop.top + crop.height).toBeGreaterThanOrEqual(630 * scale);
    const normalized = Object.fromEntries(Object.entries(crop).map(([key, value]) => [key, value / scale]));
    expect(normalized).toEqual(cropBounds({ width: 1200, height: 1600 },
      [{ x0: 400, y0: 500, x1: 580, y1: 530 }]));
  }
});

it("keeps contextual crops inside all page edges and uses the full photo without a location", () => {
  const size = { width: 1200, height: 1600 };
  for (const box of [{ x0: 0, y0: 0, x1: 180, y1: 40 }, { x0: 1020, y0: 1560, x1: 1200, y1: 1600 }]) {
    const crop = cropBounds(size, [box]);
    expect(crop.left).toBeGreaterThanOrEqual(0);
    expect(crop.top).toBeGreaterThanOrEqual(0);
    expect(crop.left + crop.width).toBeLessThanOrEqual(size.width);
    expect(crop.top + crop.height).toBeLessThanOrEqual(size.height);
    expect(crop.left).toBeLessThanOrEqual(box.x0);
    expect(crop.top).toBeLessThanOrEqual(box.y0);
    expect(crop.left + crop.width).toBeGreaterThanOrEqual(box.x1);
    expect(crop.top + crop.height).toBeGreaterThanOrEqual(box.y1);
  }
  expect(cropBounds(size, [])).toEqual({ left: 0, top: 0, width: 1200, height: 1600 });
});


it("makes the sealed line and photo primary and keeps raw OCR behind a closed disclosure", async () => {
  const signed = { ...page, content: "Approved total 123.45\nPayment due Friday" };
  ocr.read.mockResolvedValue([word("Approved"), word("total"), word("923.45"), word("Payment"), word("due"), word("Monday")]);
  const view = render(<PhotoTextVerification results={[signed]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByText("Number or date");
  const card = currentCard(view.container), reference = card.querySelector(".review-sealed-text");
  expect(reference.textContent).toBe("Sealed text: Approved total 123.45");
  expect([...reference.querySelectorAll("mark")].map(mark => mark.textContent)).toEqual(["1"]);
  const details = card.querySelector(".review-machine-reading");
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("Photo reading: 923.45");
  expect(reference.textContent).not.toContain("923.45");
  expect(card.querySelector(".review-decisions").compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(within(details).getByText("Why this was flagged"));
  expect(details.open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Next reading", exact: true }));
  expect(currentCard(view.container).querySelector(".review-machine-reading").open).toBe(false);
  expect(currentCard(view.container).querySelector(".review-sealed-text").textContent).toBe("Sealed text: Payment due Friday");
});

it("keeps the unreadable-page warning visible even when missing text creates review items", async () => {
  ocr.read.mockResolvedValue([]);
  const view = render(<PhotoTextVerification results={[page]} scanPhotos={[capture(1, "first", "unused")]} />);
  await screen.findByRole("button", { name: "Read page again" });
  expect(currentCard(view.container)).toBeTruthy();
  expect(view.container.querySelector(".photo-result > .photo-summary.unreadable").textContent)
    .toContain("No text could be read — retake this page");
});

it("includes the photographed line without moving the selected word or unrelated rows", () => {
  const selected = { x0: 800, y0: 500, x1: 980, y1: 530 };
  const neighbor = { x0: 100, y0: 495, x1: 650, y1: 530 };
  const distant = { x0: 0, y0: 1000, x1: 1200, y1: 1030 };
  const size = { width: 1200, height: 1600, comparison: { words: [{ bbox: selected }, { bbox: neighbor }, { bbox: distant }] } };
  const crop = cropBounds(size, [selected]);
  expect(crop.left).toBeLessThan(neighbor.x0);
  expect(crop.left + crop.width).toBeGreaterThan(selected.x1);
  expect(crop.top + crop.height).toBeLessThan(distant.y0);
  expect(selected).toEqual({ x0: 800, y0: 500, x1: 980, y1: 530 });
});
