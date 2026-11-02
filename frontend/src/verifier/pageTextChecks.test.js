import { expect, it, vi } from "vitest";
import { createPageTextChecks } from "./pageTextChecks.js";

const word = text => ({ text, confidence: 99, bbox: { x0: 5, y0: 5, x1: 95, y1: 25 } });
const page = (id, number, content = "Friday") => ({ document_id: id, key_id: "key", page_hash: id,
  status: "VALID", signature_valid: true, content, pdf: true, page_number: number, page_count: 2 });
const photo = (id, documentId, text = "Friday") => ({ id, documentId, file: { text } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
function setup() {
  const reader = { prepare: vi.fn().mockResolvedValue(), read: vi.fn(async canvas => [word(canvas.text)]), dispose: vi.fn() };
  const open = vi.fn(async file => ({ width: 100, height: 100, text: file.text }));
  const createUrl = vi.fn(() => "blob:test"), revokeUrl = vi.fn();
  const checks = createPageTextChecks({ reader, open, createUrl, revokeUrl });
  return { reader, open, createUrl, revokeUrl, checks };
}

it("automatically checks all pages in order and keeps page 2's changed word", async () => {
  const { checks, reader, open } = setup();
  checks.update([page("one", 1), page("two", 2)], [photo(2, "two", "Monday"), photo(1, "one")]);
  await vi.waitFor(() => expect(checks.getSnapshot().pages.map(p => p.state)).toEqual(["matches", "differences"]));
  expect(reader.prepare).toHaveBeenCalledTimes(1);
  expect(reader.read.mock.calls.every(call => call.length === 2)).toBe(true);
  expect(checks.getSnapshot().pages[1].comparison.differences[0]).toMatchObject({ expected: "Friday", observed: "Monday" });
  expect((await open.mock.results[0].value).width).toBe(0);
  checks.dispose();
});

it("pauses during live scanning but checks a single captured page when scanning stops", async () => {
  const { checks, reader } = setup();
  const pages = [page("two", 2)], photos = [photo(1, "two", "Monday")];
  await checks.prepare();
  checks.update(pages, photos, { scanning: true });
  expect(reader.read).not.toHaveBeenCalled();
  checks.update(pages, photos);
  await vi.waitFor(() => expect(checks.getSnapshot().pages[0].state).toBe("differences"));
  checks.dispose();
});

it("never compares unverified text and revokes evidence after an invalid key check", async () => {
  const { checks, reader, revokeUrl } = setup();
  const p = page("one", 1), photos = [photo(1, "one")];
  checks.update([{ ...p, status: "UNVERIFIED" }], photos);
  expect(reader.read).not.toHaveBeenCalled();
  checks.update([p], photos);
  await vi.waitFor(() => expect(checks.getSnapshot().pages[0].state).toBe("matches"));
  checks.update([{ ...p, status: "INVALID" }], photos);
  expect(checks.getSnapshot().pages).toEqual([]);
  expect(revokeUrl).toHaveBeenCalledWith("blob:test");
  checks.dispose();
});

it("preserves completed checks across verification of another page and only reads the new page", async () => {
  const { checks, reader } = setup();
  const first = page("one", 1), photos = [photo(1, "one"), photo(2, "two")];
  checks.update([first], photos);
  await vi.waitFor(() => expect(checks.getSnapshot().pages[0].state).toBe("matches"));
  checks.update([], photos, { verifying: true });
  checks.update([first, page("two", 2)], photos);
  await vi.waitFor(() => expect(checks.getSnapshot().pages[1].state).toBe("matches"));
  expect(reader.read).toHaveBeenCalledTimes(2);
  checks.dispose();
});

it.each(["opening", "reading"])("discards a late %s result after clear and permits a new session", async stage => {
  const { checks, reader, open, createUrl } = setup();
  const late = deferred();
  if (stage === "opening") open.mockReturnValueOnce(late.promise);
  else reader.read.mockReturnValueOnce(late.promise);
  checks.update([page("one", 1)], [photo(1, "one")]);
  await vi.waitFor(() => expect((stage === "opening" ? open : reader.read)).toHaveBeenCalled());
  checks.clear();
  late.resolve(stage === "opening" ? { width: 100, height: 100 } : [word("Friday")]);
  await late.promise;
  expect(checks.getSnapshot().pages).toEqual([]);
  expect(createUrl).not.toHaveBeenCalled();
  checks.update([page("two", 2)], [photo(2, "two", "Monday")]);
  await vi.waitFor(() => expect(checks.getSnapshot().pages[0].state).toBe("differences"));
  checks.dispose();
});

it("invalidates a superseded retake even when its previous OCR finishes late", async () => {
  const { checks, reader, revokeUrl } = setup(), late = deferred(), p = page("one", 1);
  reader.read.mockReturnValueOnce(late.promise);
  checks.update([p], [photo(1, "one")]);
  await vi.waitFor(() => expect(reader.read).toHaveBeenCalled());
  checks.update([p], [photo(2, "one", "Monday")]);
  await vi.waitFor(() => expect(checks.getSnapshot().pages[0].state).toBe("differences"));
  late.resolve([word("Friday")]); await late.promise;
  expect(checks.getSnapshot().pages[0].state).toBe("differences");
  checks.update([p], []);
  expect(checks.getSnapshot().pages[0].state).toBe("missing");
  expect(revokeUrl).toHaveBeenCalledWith("blob:test");
  checks.dispose();
});

it("discards progress from a cancelled reading", async () => {
  const { checks, reader } = setup(), pending = deferred();
  reader.read.mockReturnValueOnce(pending.promise);
  checks.update([page("one", 1)], [photo(1, "one")]);
  await vi.waitFor(() => expect(reader.read).toHaveBeenCalled());
  const report = reader.read.mock.calls[0][1];
  report({ status: "recognizing text", progress: .3 });
  expect(checks.getSnapshot().pages[0].progress).toBe(.3);
  checks.clear();
  report({ status: "recognizing text", progress: .8 });
  expect(checks.getSnapshot().pages).toEqual([]);
  pending.resolve([word("Friday")]);
  await pending.promise;
  checks.dispose();
});

it("stops on a failed engine load and retries only when requested", async () => {
  const { checks, reader } = setup();
  reader.prepare.mockRejectedValueOnce(new Error("Offline"));
  checks.update([page("one", 1)], [photo(1, "one")]);
  await vi.waitFor(() => expect(checks.getSnapshot().error).toContain("Offline"));
  expect(reader.prepare).toHaveBeenCalledTimes(1);
  await checks.prepare();
  await vi.waitFor(() => expect(checks.getSnapshot().pages[0].state).toBe("matches"));
  checks.dispose();
});

it("does not restore readiness when preloading finishes after Finish & clear", async () => {
  const { checks, reader } = setup(), late = deferred();
  reader.prepare.mockReturnValueOnce(late.promise);
  const preparing = checks.prepare();
  await vi.waitFor(() => expect(reader.prepare).toHaveBeenCalled());
  checks.clear(); late.resolve();
  await expect(preparing).rejects.toThrow(/ended/);
  expect(checks.getSnapshot()).toMatchObject({ pages: [], ready: false, preparing: false });
});
