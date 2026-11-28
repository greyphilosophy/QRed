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
  fireEvent.click(screen.getByRole("button", { name: "Seal PDF" }));
  chooseOfflineSealing();
}

function chooseOfflineSealing() {
  fireEvent.click(screen.getByRole("button", { name: "Private key (offline)" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Seal PDF" }));
    expect(screen.queryByLabelText("Issuer", { exact: true })).toBeNull();
  });

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("__qredTestMode", true);
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

  it("groups camera and files under Check document with a separate sealing task", () => {
    render(React.createElement(App));
    expect(screen.getByRole("heading", { name: "Check document" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Camera", exact: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "File", exact: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "QRed home" }).textContent).toBe("QRed");
    expect(screen.getByRole("button", { name: "Seal PDF" })).toBeTruthy();
    expect(screen.queryByLabelText("Private Key")).toBeNull();
  });

  it.each([["Mozilla/5.0 (Linux; Android 17) Mobile", true], ["Mozilla/5.0 (X11; Linux x86_64)", false]])(
    "shows the airplane-mode note only for mobile devices (%s)", (agent, mobile) => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
      render(<App />);
      expect(Boolean(screen.queryByText("Use airplane mode for extra security"))).toBe(mobile);
    });

  it("opens direct seal links and uses a safe home fallback for Back", () => {
    window.history.replaceState(null, "", "/#/seal");
    render(<App />);
    expect(screen.getByRole("heading", { name: "Seal PDF" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back", exact: true }));
    expect(screen.getByRole("heading", { name: "Check document" })).toBeTruthy();
  });

  it("keeps the PDF, key and layout when opening About and using app/browser Back", async () => {
    const scroll = vi.fn(), previous = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Seal PDF" }));
      const heading = screen.getByRole("heading", { name: "Seal PDF" });
      expect(window.location.hash).toBe("#/seal");
      expect(document.activeElement).toBe(heading);
      chooseOfflineSealing();
      fireEvent.change(screen.getByLabelText("Private Key"), { target: { value: privateKey } });
      const pdf = new File(["%PDF-1.4"], "keep-me.pdf", { type: "application/pdf" });
      fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [pdf] } });
      fireEvent.click(screen.getByRole("button", { name: "Change layout" }));
      fireEvent.click(screen.getByRole("radio", { name: "Separate seal pages" }));
      fireEvent.click(screen.getByRole("button", { name: "Use this layout" }));
      fireEvent.click(screen.getByRole("button", { name: "About QRed" }));
      expect(screen.getByRole("heading", { name: "What is QRed?" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Seal PDF" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Back", exact: true }));
      await waitFor(() => expect(screen.getByRole("heading", { name: "Seal PDF" })).toBeTruthy());
      expect(screen.getByText("keep-me.pdf")).toBeTruthy();
      expect(screen.getByText("Separate seal pages", { exact: true })).toBeTruthy();
      expect(screen.getByLabelText("Private Key").value).toBe(privateKey);
      window.history.back();
      await waitFor(() => expect(screen.getByRole("heading", { name: "Check document" })).toBeTruthy());
      window.history.forward();
      await waitFor(() => expect(screen.getByRole("heading", { name: "Seal PDF" })).toBeTruthy());
      expect(screen.getByLabelText("Open PDF").files[0]).toBe(pdf);
    } finally {
      if (previous === undefined) delete HTMLElement.prototype.scrollIntoView;
      else HTMLElement.prototype.scrollIntoView = previous;
    }
  });

  it("starts with empty signing keys and generates a matching pair without a network request", async () => {
    render(React.createElement(PdfSealForm));
    chooseOfflineSealing();
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

  it("keeps signing keys out of the test global on normal page loads", async () => {
    vi.stubGlobal("__qredTestMode", undefined);
    const selectPublicKey = vi.fn();
    const { unmount } = render(<PdfSealForm onUsePublicKey={selectPublicKey} />);
    chooseOfflineSealing();
    const keys = await generateKeys();
    fireEvent.click(screen.getByRole("button", { name: "Use public key to verify" }));
    expect(selectPublicKey).toHaveBeenCalledWith(await deriveSigningPublicKey(keys.privateKey));
    expect(Object.hasOwn(window, "__qredPublicKeys")).toBe(false);
    unmount();
    expect(Object.hasOwn(window, "__qredPublicKeys")).toBe(false);
  });

  it("defaults to watermark with appended overflow and verifies the generated pair's real signature using the selected public key", async () => {
    const selectPublicKey = vi.fn();
    render(<PdfSealForm onUsePublicKey={selectPublicKey} />);
    chooseOfflineSealing();
    const keys = await generateKeys();
    const pdf = new File(["%PDF-1.4"], "source.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [pdf] } });
    expect(screen.getByText("Watermarks", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Seal and save PDF" }));
    await screen.findByText(/Sealed source\.pdf in this browser\./);
    expect(sealPdfInBrowser).toHaveBeenCalledWith(expect.objectContaining({ file: pdf, ...keys, pageScalingStrategy: "watermark-sheets" }));
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

  it("restores an existing private key and derives its public key before sealing", async () => {
    openStampTool();
    fireEvent.change(screen.getByLabelText("Private Key"), { target: { value: privateKey } });
    await waitFor(() => expect(window.__qredPublicKeys).toBe(publicKey.replace(/=$/, "")));
    expect(screen.queryByLabelText("Public Key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Derive public key" })).toBeNull();
    expect(screen.getByLabelText("Private Key").value).toBe(privateKey);
    expect(window.__qredPublicKeys).toBe(publicKey.replace(/=$/, ""));
    const pdf = new File(["%PDF-1.4"], "saved-key.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [pdf] } });
    fireEvent.click(screen.getByRole("button", { name: "Seal and save PDF" }));
    await screen.findByText(/Sealed saved-key\.pdf/);
  });

  it("opens saved key files in a fresh tool and stamps with the same identity without networking", async () => {
    render(<PdfSealForm />);
    chooseOfflineSealing();
    const keys = await generateKeys();
    fireEvent.click(screen.getByRole("button", { name: "Save private key" }));
    fireEvent.click(screen.getByRole("button", { name: "Save public key" }));
    const privateFile = keyFile(URL.createObjectURL.mock.calls[0][0], "qred-ed25519-private-key.txt");
    cleanup();
    render(<PdfSealForm />);
    chooseOfflineSealing();
    fireEvent.click(screen.getByRole("button", { name: "Show private key" }));
    fireEvent.change(screen.getByLabelText("Open private key file"), { target: { files: [privateFile] } });
    await screen.findByText(/Private key opened\. Matching public key derived/);
    expect(screen.getByLabelText("Private Key").value).toBe(keys.privateKey);
    expect(screen.getByLabelText("Private Key").type).toBe("password");
    expect(window.__qredPublicKeys).toBe(keys.publicKey);
    fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [new File(["pdf"], "imported.pdf")] } });
    fireEvent.click(screen.getByRole("button", { name: "Seal and save PDF" }));
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
    chooseOfflineSealing();
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
    chooseOfflineSealing();
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
    fireEvent.click(screen.getByRole("button", { name: "Seal and save PDF" }));
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

  it("hides private keys by default and discards them when finishing the sealing session", async () => {
    openStampTool();
    await generateKeys();
    const input = screen.getByLabelText("Private Key");
    fireEvent.click(screen.getByRole("button", { name: "Show private key" }));
    expect(input.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide private key" }));
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Finish & clear", exact: true }));
    expect(Object.hasOwn(window, "__qredPublicKeys")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Seal PDF" }));
    expect(screen.queryByLabelText("Private Key")).toBeNull();
    chooseOfflineSealing();
    await waitFor(() => expect(screen.getByLabelText("Private Key").value).toBe(""));
    expect(window.__qredPublicKeys).toBe("");
  });
});
