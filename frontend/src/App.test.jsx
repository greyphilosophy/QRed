/* @vitest-environment jsdom */
import React from "react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App.jsx";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { createQRedSeals } from "./qredSealer.js";
import { verifyQRedSeals } from "./qredVerifier.js";
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
  await waitFor(() => expect(screen.getByRole("button", { name: "Save public key" }).disabled).toBe(false));
  return {
    privateKey: screen.getByLabelText("Private Key").value,
    publicKey: window.__qredPublicKeys,
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

function keyFile(contents, name) {
  const file = new File([contents], name, { type: "text/plain" });
  // jsdom's File lacks text(); keep a real File and read its actual bytes.
  file.text = () => readBlob(file);
  return file;
}

describe("App PDF signing keys", () => {
  it("does not request or send an issuer name when stamping", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open PDF stamping tool" }));
    expect(screen.queryByLabelText("Issuer", { exact: true })).toBeNull();
  });

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

  it("opens Stamp PDF and scrolls/focuses the stamping section on first and repeated clicks", async () => {
    const scroll = vi.fn(), previous = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<App />);
      const trigger = screen.getByRole("button", { name: "Open PDF stamping tool" });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(trigger);
      const section = document.getElementById("pdf-stamp-tool");
      expect(section).not.toBeNull();
      expect(trigger.getAttribute("aria-controls")).toBe("pdf-stamp-tool");
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      const heading = screen.getByRole("heading", { name: "Stamp a PDF with QRed seals" });
      await waitFor(() => expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" }));
      expect(scroll.mock.instances[0]).toBe(section);
      expect(document.activeElement).toBe(heading);

      scroll.mockClear();
      fireEvent.click(trigger);
      expect(scroll).toHaveBeenCalledOnce();
      expect(scroll.mock.instances[0]).toBe(section);

      fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.getElementById("pdf-stamp-tool")).toBeNull();
    } finally {
      if (previous === undefined) delete HTMLElement.prototype.scrollIntoView;
      else HTMLElement.prototype.scrollIntoView = previous;
    }
  });

  it("starts with empty signing keys and generates a matching pair without a network request", async () => {
    render(React.createElement(PdfSealForm));
    expect(screen.getByLabelText("Private Key").value).toBe("");
    expect(window.__qredPublicKeys).toBe("");
    expect(screen.queryByRole("button", { name: "Use Default Keys" })).toBeNull();
    expect(screen.getByText(/Raw 32-byte Ed25519 seed/)).toBeTruthy();
    const keys = await generateKeys();
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keys.publicKey).toBe(await deriveSigningPublicKey(keys.privateKey));
    expect(screen.getByLabelText("Private Key").type).toBe("password");
    expect(fetch).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("defaults to Automatic layout and verifies the generated pair's real signature using the selected public key", async () => {
    const selectPublicKey = vi.fn();
    render(<PdfSealForm onUsePublicKey={selectPublicKey} />);
    const keys = await generateKeys();
    const pdf = new File(["%PDF-1.4"], "source.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [pdf] } });
    expect(screen.getByLabelText("Page layout").value).toBe("automatic");
    fireEvent.click(screen.getByRole("button", { name: "Stamp and save PDF" }));
    await screen.findByText(/Sealed source\.pdf in this browser\./);
    expect(sealPdfInBrowser).toHaveBeenCalledWith(expect.objectContaining({ file: pdf, ...keys, pageScalingStrategy: "automatic" }));
    fireEvent.click(screen.getByRole("button", { name: "Use public key to verify" }));
    expect(selectPublicKey).toHaveBeenCalledWith(keys.publicKey);
    const { seals } = await createQRedSeals({ content: "Generated key test", ...keys });
    await expect(verifyQRedSeals(seals, selectPublicKey.mock.calls[0][0]))
      .resolves.toMatchObject({ status: "VALID", content: "Generated key test" });
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
    await waitFor(() => expect(window.__qredPublicKeys).toBe(publicKey.replace(/=$/, "")));
    expect(screen.queryByLabelText("Public Key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Derive public key" })).toBeNull();
    expect(screen.getByLabelText("Private Key").value).toBe(privateKey);
    expect(window.__qredPublicKeys).toBe(publicKey.replace(/=$/, ""));
    const pdf = new File(["%PDF-1.4"], "saved-key.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [pdf] } });
    fireEvent.click(screen.getByRole("button", { name: "Stamp and save PDF" }));
    await screen.findByText(/Sealed saved-key\.pdf/);
  });

  it("opens saved key files in a fresh tool and stamps with the same identity without networking", async () => {
    render(<PdfSealForm />);
    const keys = await generateKeys();
    fireEvent.click(screen.getByRole("button", { name: "Save private key" }));
    fireEvent.click(screen.getByRole("button", { name: "Save public key" }));
    const privateFile = keyFile(URL.createObjectURL.mock.calls[0][0], "qred-ed25519-private-key.txt");
    cleanup();
    render(<PdfSealForm />);
    fireEvent.click(screen.getByRole("button", { name: "Show private key" }));
    fireEvent.change(screen.getByLabelText("Open private key file"), { target: { files: [privateFile] } });
    await screen.findByText(/Private key opened\. Matching public key derived/);
    expect(screen.getByLabelText("Private Key").value).toBe(keys.privateKey);
    expect(screen.getByLabelText("Private Key").type).toBe("password");
    expect(window.__qredPublicKeys).toBe(keys.publicKey);
    fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [new File(["pdf"], "imported.pdf")] } });
    fireEvent.click(screen.getByRole("button", { name: "Stamp and save PDF" }));
    await screen.findByText(/Sealed imported\.pdf in this browser/);
    expect(sealPdfInBrowser).toHaveBeenCalledWith(expect.objectContaining(keys));
    expect(fetch).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["private", "not a key", "key.txt", /Private key must be/],
    ["private", publicKey, "qred-ed25519-public-key.txt", /Choose a private key file instead/],
    ["private", "x".repeat(4097), "document.txt", /4 KB or less/],
  ])("keeps the current pair when a %s file is invalid or mismatched (%#)", async (kind, text, name, error) => {
    render(<PdfSealForm />);
    const keys = await generateKeys();
    fireEvent.change(screen.getByLabelText(`Open ${kind} key file`), { target: { files: [keyFile(text, name)] } });
    await screen.findByText(error);
    expect(screen.getByLabelText("Private Key").value).toBe(keys.privateKey);
    expect(window.__qredPublicKeys).toBe(keys.publicKey);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText(`Open ${kind} key file`).value).toBe("");
  });

  it("keeps keys on a file read failure and allows retrying a cancelled replacement", async () => {
    render(<PdfSealForm />);
    const keys = await generateKeys();
    const broken = keyFile(privateKey, "key.txt");
    broken.text = () => Promise.reject(new Error("read failed"));
    fireEvent.change(screen.getByLabelText("Open private key file"), { target: { files: [broken] } });
    await screen.findByText(/Could not read the key file/);
    expect(screen.getByLabelText("Private Key").value).toBe(keys.privateKey);
    expect(window.__qredPublicKeys).toBe(keys.publicKey);
    const saved = keyFile(privateKey, "qred-ed25519-private-key.txt");
    window.confirm.mockReturnValue(false);
    fireEvent.change(screen.getByLabelText("Open private key file"), { target: { files: [saved] } });
    await screen.findByText("Key import cancelled. Current keys kept.");
    expect(screen.getByLabelText("Private Key").value).toBe(keys.privateKey);
    expect(window.__qredPublicKeys).toBe(keys.publicKey);
    window.confirm.mockReturnValue(true);
    fireEvent.change(screen.getByLabelText("Open private key file"), { target: { files: [saved] } });
    await screen.findByText(/Private key opened\. Matching public key derived/);
    expect(screen.getByLabelText("Private Key").value).toBe(privateKey.replace(/=$/, ""));
    expect(window.__qredPublicKeys).toBe(publicKey.replace(/=$/, ""));
  });

  it("rejects an invalid private key before processing a PDF", async () => {
    openStampTool();
    fireEvent.change(screen.getByLabelText("Private Key"), { target: { value: "not-a-key" } });
    fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [new File(["pdf"], "test.pdf")] } });
    fireEvent.click(screen.getByRole("button", { name: "Stamp and save PDF" }));
    expect(await screen.findByText(/Private key must be.*32-byte Ed25519 seed/)).toBeTruthy();
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
    expect(window.__qredPublicKeys).toBe(keys.publicKey);
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
    expect(window.__qredPublicKeys).toBe("");
  });
});
