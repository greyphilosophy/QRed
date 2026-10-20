/* @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import App from "./App.jsx";

const scanner = vi.hoisted(() => ({ props: null }));
vi.mock("./QrScanner.jsx", () => ({ QrScanner: (props) => { scanner.props = props; return null; } }));
vi.mock("./PdfSealForm.jsx", () => ({ PdfSealForm: () => null }));
const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("connects homepage scans to real signature verification and waits for every chunk", async () => {
  const content = Array.from({ length: 700 }, (_, i) => `Record ${i}: ${Math.imul(i + 17, 2654435761) >>> 0}.`).join("\n");
  const { seals } = await createQRedSeals({ content, privateKey, publicKey });
  expect(seals.length).toBeGreaterThan(1);
  render(<App />);
  expect(scanner.props.returnPayload).toBe(true);
  expect(scanner.props.collectSeals).toBe(true);
  fireEvent.change(screen.getByLabelText("Issuer public key"), { target: { value: publicKey } });
  await act(async () => scanner.props.onSealDetected(seals[0]));
  expect(await screen.findByRole("heading", { name: "INCOMPLETE" })).toBeTruthy();
  expect(scanner.props.collectionProgress).toMatchObject({ collected: 1, total: seals.length, finished: false });
  await act(async () => seals.slice(1).forEach(scanner.props.onSealDetected));
  expect(await screen.findByRole("heading", { name: "VALID" })).toBeTruthy();
  await waitFor(() => expect(scanner.props.collectionProgress.complete).toBe(true));
  expect(document.querySelector(".verification-result pre").textContent).toBe(content);

  fireEvent.change(screen.getByLabelText("Issuer public key"), { target: { value: "" } });
  expect(await screen.findByRole("heading", { name: "UNVERIFIED" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "VALID" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Issuer public key"), { target: { value: "bad-key" } });
  expect(await screen.findByRole("heading", { name: "INVALID" })).toBeTruthy();
});

it("displays the signed timestamp of scanned seals and clears previous results", async () => {
  const timestamp = "2026-10-20T17:55:14.123Z";
  const { seals } = await createQRedSeals({ content: "Scanned document", timestamp, privateKey, publicKey });
  const { container } = render(<App />);
  fireEvent.change(screen.getByLabelText("Issuer public key"), { target: { value: publicKey } });
  await act(async () => seals.forEach(scanner.props.onSealDetected));
  expect(await screen.findByRole("heading", { name: "VALID" })).toBeTruthy();
  expect(container.querySelector("time").textContent).toBe(timestamp);
  expect(container.textContent).not.toContain("Claimed issuer");
  fireEvent.click(screen.getByRole("button", { name: "Clear collected seals" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "VALID" })).toBeNull());
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
  fireEvent.change(screen.getByLabelText("Issuer public key"), { target: { value: publicKey } });
  await act(async () => pages[0].seals.forEach(scanner.props.onSealDetected));
  expect(await screen.findByText("Page 2 of 2")).toBeTruthy();
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
  const select = (text, name = "issuer.txt") => fireEvent.change(screen.getByLabelText("Open issuer public key file"), {
    target: { files: [{ name, size: text.length, text: async () => text }] },
  });
  select(publicKey);
  expect(await screen.findByRole("heading", { name: "VALID" })).toBeTruthy();
  const imported = screen.getByLabelText("Issuer public key").value;
  select(privateKey, "qred-ed25519-private-key.txt");
  await screen.findByText(/Choose a public key file instead/);
  expect(screen.getByLabelText("Issuer public key").value).toBe(imported);
  expect(screen.getByRole("heading", { name: "VALID" })).toBeTruthy();
  select("Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=");
  expect(await screen.findByRole("heading", { name: "INVALID" })).toBeTruthy();
  select(publicKey);
  expect(await screen.findByRole("heading", { name: "VALID" })).toBeTruthy();
  expect(fetch.mock.calls.length).toBe(requestsBefore);
});
