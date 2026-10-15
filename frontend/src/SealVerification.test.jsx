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
  const content = "A document with several seals. ".repeat(160).trim();
  const { seals } = await createQRedSeals({ content, issuer: "QA", privateKey, publicKey });
  expect(seals.length).toBeGreaterThan(1);
  render(<App />);
  expect(scanner.props.returnPayload).toBe(true);
  fireEvent.change(screen.getByLabelText("Issuer public key"), { target: { value: publicKey } });
  await act(async () => scanner.props.onSealDetected(seals[0]));
  expect(await screen.findByRole("heading", { name: "INCOMPLETE" })).toBeTruthy();
  await act(async () => seals.slice(1).forEach(scanner.props.onSealDetected));
  expect(await screen.findByRole("heading", { name: "VALID" })).toBeTruthy();
  expect(screen.getByText(content)).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Issuer public key"), { target: { value: "" } });
  expect(await screen.findByRole("heading", { name: "UNVERIFIED" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "VALID" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Issuer public key"), { target: { value: "bad-key" } });
  expect(await screen.findByRole("heading", { name: "INVALID" })).toBeTruthy();
});

it("verifies manual seals, escapes issuer text, and clears previous results", async () => {
  const issuer = '<img src=x onerror="alert(1)">';
  const { seals } = await createQRedSeals({ content: "Manual document", issuer, privateKey, publicKey });
  const { container } = render(<App />);
  fireEvent.change(screen.getByLabelText("Issuer public key"), { target: { value: publicKey } });
  fireEvent.change(screen.getByLabelText("Seal strings, one per line"), { target: { value: seals.join("\n") } });
  fireEvent.click(screen.getByRole("button", { name: "Add seals" }));
  expect(await screen.findByRole("heading", { name: "VALID" })).toBeTruthy();
  expect(container.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear collected seals" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "VALID" })).toBeNull());
});

it("keeps a normal QR visible without treating it as a verified document", async () => {
  render(<App />);
  await act(async () => scanner.props.onSealDetected("https://example.org/ordinary"));
  expect(screen.getByText("Unverified QR content: https://example.org/ordinary")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "VALID" })).toBeNull();
});

it("opens an issuer key locally and rechecks collected seals, preserving the key on invalid imports", async () => {
  const { seals } = await createQRedSeals({ content: "Saved issuer identity", issuer: "QA", privateKey, publicKey });
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
