/* @vitest-environment jsdom */
import React from "react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App.jsx";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { createQRedSeals } from "./qredSealer.js";
import { deriveSigningPublicKey } from "./signingKeys.js";

vi.mock("./pdfClientSeal.js", () => ({ sealPdfInBrowser: vi.fn() }));

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

function openStampTool() {
  render(React.createElement(App));
  fireEvent.click(screen.getByRole("button", { name: "Open PDF stamping tool" }));
}

async function generateKeys() {
  fireEvent.click(screen.getByRole("button", { name: "Generate key pair" }));
  await screen.findByText(/Key pair generated\./);
  return {
    privateKey: screen.getByLabelText("Private Key").value,
    publicKey: screen.getByLabelText("Public Key").value,
  };
}

function readBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}

describe("App PDF signing keys", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    sealPdfInBrowser.mockReset();
    sealPdfInBrowser.mockResolvedValue({
      blob: new Blob(["sealed in browser"], { type: "application/pdf" }),
      sealResult: { document_id: "DOC-DEFAULT", total_seals: 1 },
    });
    URL.createObjectURL = vi.fn(() => "blob:download");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the scanner as the landing page with a stamping entry point", () => {
    render(React.createElement(App));
    expect(screen.getByRole("heading", { name: "Point at a QRed seal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start scanning" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open PDF stamping tool" })).toBeTruthy();
    expect(screen.queryByLabelText("Private Key")).toBeNull();
  });

  it("starts with empty signing keys and generates a matching pair without a network request", async () => {
    render(React.createElement(PdfSealForm));
    expect(screen.getByLabelText("Private Key").value).toBe("");
    expect(screen.getByLabelText("Public Key").value).toBe("");
    expect(screen.queryByRole("button", { name: "Use Default Keys" })).toBeNull();
    expect(screen.getByText(/Raw 32-byte Ed25519 seed/)).toBeTruthy();
    const keys = await generateKeys();
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keys.publicKey).toBe(await deriveSigningPublicKey(keys.privateKey));
    expect(screen.getByLabelText("Private Key").type).toBe("password");
    expect(fetch).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("stamps with the generated pair and verifies its real signature using the selected public key", async () => {
    openStampTool();
    const keys = await generateKeys();
    const pdf = new File(["%PDF-1.4"], "source.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [pdf] } });
    fireEvent.click(screen.getByRole("button", { name: "Stamp and save PDF" }));
    await screen.findByText(/Sealed source\.pdf in this browser\./);
    expect(sealPdfInBrowser).toHaveBeenCalledWith(expect.objectContaining({ file: pdf, ...keys }));
    fireEvent.click(screen.getByRole("button", { name: "Use public key to verify" }));
    expect(screen.getByLabelText("Issuer public key").value).toBe(keys.publicKey);
    const { seals } = await createQRedSeals({ content: "Generated key test", issuer: "QA", ...keys });
    fireEvent.change(screen.getByLabelText("Seal strings, one per line"), { target: { value: seals.join("\n") } });
    fireEvent.click(screen.getByRole("button", { name: "Add seals" }));
    expect(await screen.findByRole("heading", { name: "VALID" })).toBeTruthy();
    expect(screen.getByText("Generated key test")).toBeTruthy();
  });

  it("downloads reusable raw keys separately, with no private data in the public download", async () => {
    openStampTool();
    const keys = await generateKeys();
    fireEvent.click(screen.getByRole("button", { name: "Save public key" }));
    const publicDownload = await readBlob(URL.createObjectURL.mock.calls[0][0]);
    expect(publicDownload).toBe(keys.publicKey + "\n");
    expect(publicDownload).not.toContain(keys.privateKey);
    fireEvent.click(screen.getByRole("button", { name: "Save private key" }));
    expect(await readBlob(URL.createObjectURL.mock.calls[1][0])).toBe(keys.privateKey + "\n");
    expect(HTMLAnchorElement.prototype.click.mock.instances.map((link) => link.download)).toEqual([
      "qred-ed25519-public-key.txt", "qred-ed25519-private-key.txt",
    ]);
    expect(screen.getByText(/This file is unencrypted/)).toBeTruthy();
  });

  it("restores an existing private key and derives its public key before stamping", async () => {
    openStampTool();
    fireEvent.change(screen.getByLabelText("Private Key"), { target: { value: privateKey } });
    fireEvent.click(screen.getByRole("button", { name: "Derive public key" }));
    await screen.findByText("Matching public key derived from your private key.");
    expect(screen.getByLabelText("Private Key").value).toBe(privateKey);
    expect(screen.getByLabelText("Public Key").value).toBe(publicKey.replace(/=$/, ""));
    const pdf = new File(["%PDF-1.4"], "saved-key.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [pdf] } });
    fireEvent.click(screen.getByRole("button", { name: "Stamp and save PDF" }));
    await screen.findByText(/Sealed saved-key\.pdf/);
  });

  it.each([
    ["not-a-key", publicKey, /Private key must be.*32-byte Ed25519 seed/],
    [privateKey, "bad-public-key", /Public key must be.*32-byte Ed25519 public key/],
    [privateKey, "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=", /does not match/],
  ])("rejects invalid or mismatched keys before processing a PDF (%#)", async (privateValue, publicValue, error) => {
    openStampTool();
    fireEvent.change(screen.getByLabelText("Private Key"), { target: { value: privateValue } });
    fireEvent.change(screen.getByLabelText("Public Key"), { target: { value: publicValue } });
    fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [new File(["pdf"], "test.pdf")] } });
    fireEvent.click(screen.getByRole("button", { name: "Stamp and save PDF" }));
    expect(await screen.findByText(error)).toBeTruthy();
    expect(sealPdfInBrowser).not.toHaveBeenCalled();
  });

  it("keeps existing keys if replacement is cancelled or secure generation fails", async () => {
    openStampTool();
    const keys = await generateKeys();
    window.confirm.mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Generate key pair" }));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Private Key").value).toBe(keys.privateKey);
    window.confirm.mockReturnValue(true);
    vi.stubGlobal("crypto", {});
    fireEvent.click(screen.getByRole("button", { name: "Generate key pair" }));
    await screen.findByText(/Key generation failed:.*HTTPS/);
    expect(screen.getByLabelText("Private Key").value).toBe(keys.privateKey);
    expect(screen.getByLabelText("Public Key").value).toBe(keys.publicKey);
  });

  it("hides private keys by default and does not retain them after closing the tool", async () => {
    openStampTool();
    await generateKeys();
    const input = screen.getByLabelText("Private Key");
    fireEvent.click(screen.getByRole("button", { name: "Show private key" }));
    expect(input.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide private key" }));
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Open PDF stamping tool" }));
    await waitFor(() => expect(screen.getByLabelText("Private Key").value).toBe(""));
    expect(screen.getByLabelText("Public Key").value).toBe("");
  });
});
