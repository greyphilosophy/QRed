import { describe, expect, it } from "vitest";
import { getPublicKeyAsync } from "@noble/ed25519";
import { createQRedSeals } from "./qredSealer.js";
import { orderSealResults, sealCollectionProgress, verifySealCollection } from "./sealCollection.js";
import { encodeBase64Url, qrPayloadBytes, sealString } from "./sealFormat.js";

const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" };
const timestamp = "2026-10-20T17:55:14.123Z";
const root = "a1".repeat(32);
const page = (pageNumber, overrides = {}) => createQRedSeals({ ...keys, timestamp, content: "Page text",
  pageContext: { pageNumber, pageCount: 2, documentRoot: root }, ...overrides });
const progress = async (seals, key = keys.publicKey) => sealCollectionProgress(seals, await verifySealCollection(seals, key));

it("knows the QR count from a continuation chunk and ignores repeated pieces", async () => {
  const { seals } = await createQRedSeals({ ...keys, content: "A".repeat(3000), encodingStrategy: "plaintext" });
  expect(seals).toHaveLength(2);
  expect(await progress([seals[1], seals[1]])).toMatchObject({ collected: 1, total: 2, finished: false });
  expect(await progress([seals[1], seals[1], seals[0]])).toMatchObject({ collected: 2, total: 2, complete: true });
  expect(sealCollectionProgress(seals)).toMatchObject({ finished: false, message: "Checking collected seals…" });
});

it("collects out-of-order pages and chunks before completing a PDF", async () => {
  const first = await page(1, { content: "A".repeat(3000), encodingStrategy: "plaintext" });
  const second = await page(2);
  const scans = [first.seals[1], ...second.seals];
  expect(await progress(scans)).toMatchObject({ pagesCollected: 1, pagesTotal: 2, finished: false });
  scans.push(first.seals[0]);
  expect(await progress(scans)).toMatchObject({ pagesCollected: 2, pagesTotal: 2, complete: true });
});

it("orders recovered pages numerically, including a page completed after a later page", async () => {
  const first = await page(1, { content: "A".repeat(3000), encodingStrategy: "plaintext" });
  const second = await page(2);
  const scans = [...second.seals, first.seals[1]];
  expect((await verifySealCollection(scans, keys.publicKey)).map(item => item.status)).toEqual(["VALID", "INCOMPLETE"]);
  scans.push(first.seals[0]);
  expect((await verifySealCollection(scans, keys.publicKey)).map(item => item.page_number)).toEqual([1, 2]);
});

it("keeps documents and signing iterations separate while sorting their pages", () => {
  const result = (number, overrides = {}) => ({ pdf: true, page_number: number, page_count: 12,
    document_root: root, key_id: "key", timestamp, ...overrides });
  const pages = [result(12), result(2, { timestamp: "later" }), result(1, { key_id: "other" }),
    result(2), { status: "INCOMPLETE" }, result(1, { timestamp: "later" }),
    result(1, { document_root: "other" }), result(1, { page_count: 2 })];
  const original = [...pages];
  expect(orderSealResults(pages)).toEqual([pages[3], pages[0], pages[5], pages[1], pages[2], pages[4], pages[6], pages[7]]);
  expect(pages).toEqual(original);
});

it("counts an identical page position only once", async () => {
  const first = await page(1);
  const duplicatePosition = await page(1, { content: "A different signed rendering of page one" });
  expect(await progress([...first.seals, ...duplicatePosition.seals])).toMatchObject({ pagesCollected: 1, finished: false });
});

describe("document membership", () => {
  it.each(["timestamp", "key", "root", "page count"])("does not combine pages with a different %s", async difference => {
    const first = await page(1);
    const options = {};
    if (difference === "timestamp") options.timestamp = "2026-10-20T17:55:15.123Z";
    if (difference === "root") options.pageContext = { pageNumber: 2, pageCount: 2, documentRoot: "b2".repeat(32) };
    if (difference === "page count") options.pageContext = { pageNumber: 2, pageCount: 3, documentRoot: root };
    if (difference === "key") {
      const seed = new Uint8Array(32).fill(42);
      options.privateKey = encodeBase64Url(seed);
      options.publicKey = encodeBase64Url(await getPublicKeyAsync(seed));
    }
    const second = await page(2, options);
    expect(await progress([...first.seals, ...second.seals], "")).toMatchObject({ pagesCollected: 1, finished: false });
  });
});

it("labels unauthenticated counts and never treats a bad signature as completion", async () => {
  const first = await page(1), second = await page(2);
  expect((await progress([...first.seals, ...second.seals], "")).message).toContain("Page counts are unverified");
  const bytes = qrPayloadBytes(second.seals[0]);
  bytes[57] ^= 1; // Multipage signature, without changing the page count.
  const invalid = await progress([...first.seals, sealString(bytes)]);
  expect(invalid).toMatchObject({ complete: false, finished: true });
  expect(invalid.message).toContain("verification failed");
});

it("handles single-page PDFs and ordinary QR content without inventing more pages", async () => {
  const single = await page(1, { pageContext: { pageNumber: 1, pageCount: 1 } });
  expect(await progress(single.seals)).toMatchObject({ complete: true, finished: true });
  expect(sealCollectionProgress([])).toBeNull();
  expect(sealCollectionProgress(["https://example.org"])).toBeNull();
});
