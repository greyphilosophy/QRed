/* @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { signAsync } from "@noble/ed25519";
import { attestationMessage, pageCommitment } from "./attestation.js";
import { decodeBase64Url, encodeBase64Url } from "./sealFormat.js";
import { createQRedSeals } from "./qredSealer.js";
import App from "./App.jsx";
import { useSealVerification } from "./SealVerification.jsx";
import { decodeSeal } from "./qredVerifier.js";

vi.mock("./trustedAuthorities.json", () => ({ default: { da522162396ab2d0: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q" } }));

const scanner = vi.hoisted(() => ({ props: null }));
vi.mock("./QrScanner.jsx", () => ({ QrScanner: (props) => { scanner.props = props; return null; } }));
vi.mock("./PdfSealForm.jsx", () => ({ PdfSealForm: () => null }));
const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

function selectKey(text, name = "issuer.txt") {
  fireEvent.change(screen.getByLabelText("Open issuer public key file"), {
    target: { files: [{ name, size: text.length, text: async () => text }] },
  });
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("connects homepage scans to real signature verification and waits for every chunk", async () => {
  const content = Array.from({ length: 700 }, (_, i) => `Record ${i}: ${Math.imul(i + 17, 2654435761) >>> 0}.`).join("\n");
  const { seals } = await createQRedSeals({ content, privateKey, publicKey });
  expect(seals.length).toBeGreaterThan(1);
  render(<App />);
  expect(scanner.props.returnPayload).toBe(true);
  expect(scanner.props.collectSeals).toBe(true);
  expect(screen.queryByLabelText("Issuer public key")).toBeNull();
  expect(screen.queryByLabelText("Open issuer public key file")).toBeNull();
  await act(async () => scanner.props.onSealDetected(seals[0]));
  expect(await screen.findByRole("heading", { name: "INCOMPLETE" })).toBeTruthy();
  expect(scanner.props.collectionProgress).toMatchObject({ collected: 1, total: seals.length, finished: false });
  selectKey(publicKey);
  await screen.findByText(/Public key opened/);
  await act(async () => seals.slice(1).forEach(scanner.props.onSealDetected));
  expect(await screen.findByRole("heading", { name: "VALID" })).toBeTruthy();
  await waitFor(() => expect(scanner.props.collectionProgress.complete).toBe(true));
  expect(document.querySelector(".verification-result pre").textContent).toBe(content);

  selectKey("Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=");
  expect(await screen.findByRole("heading", { name: "INVALID" })).toBeTruthy();
});

it("displays the signed timestamp of scanned seals and clears previous results", async () => {
  const timestamp = "2026-10-20T17:55:14.123Z";
  const { seals } = await createQRedSeals({ content: "Scanned document", timestamp, privateKey, publicKey });
  const { container } = render(<App />);
  await act(async () => seals.forEach(scanner.props.onSealDetected));
  selectKey(publicKey);
  expect(await screen.findByRole("heading", { name: "VALID" })).toBeTruthy();
  expect(container.querySelector("time").textContent).toBe(timestamp);
  expect(container.textContent).not.toContain("Claimed issuer");
  fireEvent.click(screen.getByRole("button", { name: "Clear collected seals" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "VALID" })).toBeNull());
  expect(screen.queryByLabelText("Open issuer public key file")).toBeNull();
});

it("keeps a normal QR visible without treating it as a verified document", async () => {
  render(<App />);
  await act(async () => scanner.props.onSealDetected("https://example.org/ordinary"));
  expect(screen.getByText("Unverified QR content: https://example.org/ordinary")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "VALID" })).toBeNull();
});

it("displays recovered PDF pages in page order when scanned in reverse", async () => {
  const timestamp = "2026-10-20T17:55:14.123Z";
  const pages = await Promise.all([2, 1].map(pageNumber => createQRedSeals({
    content: `Document page ${pageNumber}`, timestamp, privateKey, publicKey,
    pageContext: { pageNumber, pageCount: 2, documentRoot: "a1".repeat(32) },
  })));
  render(<App />);
  await act(async () => pages[0].seals.forEach(scanner.props.onSealDetected));
  expect(await screen.findByText("Page 2 of 2")).toBeTruthy();
  selectKey(publicKey);
  await act(async () => pages[1].seals.forEach(scanner.props.onSealDetected));
  await waitFor(() => expect(screen.getAllByRole("heading", { name: "VALID" })).toHaveLength(2));
  expect([...document.querySelectorAll(".verification-result pre")].map(item => item.textContent))
    .toEqual(["Document page 1", "Document page 2"]);
});

it("opens an issuer key locally and rechecks collected seals, preserving the key on invalid imports", async () => {
  const { seals } = await createQRedSeals({ content: "Saved issuer identity", privateKey, publicKey });
  render(<App />);
  await act(async () => scanner.props.onSealDetected(seals[0]));
  expect(await screen.findByRole("heading", { name: "UNVERIFIED" })).toBeTruthy();
  const requestsBefore = fetch.mock.calls.length;

  selectKey(publicKey);
  expect(await screen.findByRole("heading", { name: "VALID" })).toBeTruthy();
  selectKey(privateKey, "qred-ed25519-private-key.txt");
  await screen.findByText(/Choose a public key file instead/);
  expect(screen.getByRole("heading", { name: "VALID" })).toBeTruthy();
  selectKey("Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=");
  expect(await screen.findByRole("heading", { name: "INVALID" })).toBeTruthy();
  selectKey(publicKey);
  expect(await screen.findByRole("heading", { name: "VALID" })).toBeTruthy();
  expect(fetch.mock.calls.length).toBe(requestsBefore);
});

it("verifies Google seals offline without asking for an issuer key, including multipart scans", async () => {
  const content = "Synthetic Google document. ".repeat(180).trimEnd();
  const metadata = { pdf: false, key_id: "da522162396ab2d0", timestamp: "2026-10-20T12:00:00Z",
    identity: { provider: "google", email: "alice@gmail.com", subject: "123", name: "Alice", name_source: "google" } };
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const signature = await signAsync(attestationMessage(metadata, await pageCommitment(metadata, content, salt)), decodeBase64Url(privateKey));
  const { seals } = await createQRedSeals({ content, encodingStrategy: "plaintext",
    attestation: { ...metadata, salt, public_key: publicKey.replace(/=$/, ""), signature: encodeBase64Url(signature) } });
  expect(seals.length).toBeGreaterThan(1);
  render(<App />);
  await act(async () => scanner.props.onSealDetected(seals.at(-1)));
  expect(await screen.findByRole("heading", { name: "INCOMPLETE" })).toBeTruthy();
  expect(screen.queryByLabelText("Open issuer public key file")).toBeNull();
  await act(async () => seals.slice(0, -1).forEach(scanner.props.onSealDetected));
  expect(await screen.findByRole("heading", { name: "VALID" })).toBeTruthy();
  expect(screen.getByText(/Account authenticated through Google: alice@gmail.com/)).toBeTruthy();
  expect(screen.queryByLabelText("Issuer public key")).toBeNull();
  expect(screen.queryByLabelText("Open issuer public key file")).toBeNull();
});

it("retains scan frames by their signed page IDs and clears them with the collection", async () => {
  const pages = await Promise.all([2, 1].map(pageNumber => createQRedSeals({
    content: `Photo page ${pageNumber}`, privateKey, publicKey, timestamp: "2026-10-22T12:00:00Z",
    pageContext: { pageNumber, pageCount: 2, documentRoot: "b2".repeat(32) },
  })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect() {}, drawImage() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob(["frame"], { type: "image/png" })));
  const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 600;
  const { result } = renderHook(useSealVerification);
  await act(async () => {
    result.current.setPublicKey(publicKey);
    pages.forEach(page => result.current.addSeal(page.seals[0], canvas));
  });
  await waitFor(() => expect(result.current.progress.complete).toBe(true));
  expect(result.current.scanImages.photos.map(image => image.documentId)).toEqual(pages.map(page => decodeSeal(page.seals[0]).document_id));
  expect(result.current.results.map(page => page.page_number)).toEqual([1, 2]);
  act(() => result.current.clear());
  expect(result.current.scanImages.photos).toEqual([]);
});

it("does not collect an uploaded image that finishes opening after the user clears scans", async () => {
  let opened;
  vi.stubGlobal("Image", class { decode() { return new Promise(resolve => { opened = resolve; }); } });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return "blob:pending-qr-image"; }
    static revokeObjectURL() {}
  });
  render(<App />);
  fireEvent.change(screen.getByLabelText("Choose QR image"), {
    target: { files: [new File(["synthetic"], "qr.png", { type: "image/png" })] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Clear collected seals" }));
  await act(async () => opened());
  expect(screen.queryByText(/No QR code found/)).toBeNull();
  expect(scanner.props.collectionProgress).toBeNull();
});
