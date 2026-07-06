/* @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App.jsx";
import { sealPdfInBrowser } from "./pdfClientSeal.js";

vi.mock("./pdfClientSeal.js", () => ({
  sealPdfInBrowser: vi.fn(),
}));

const defaultPrivateKey = "default-private-key";
const defaultPublicKey = "default-public-key";

function mockKeyFetch() {
  return vi.fn((url) => {
    if (url === "/api/keys/default") {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve(""),
        json: () => Promise.resolve({ private_key: defaultPrivateKey, public_key: defaultPublicKey, source: "worker-static-demo" }),
      });
    }

    return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
  });
}

describe("App PDF sealing defaults", () => {
  beforeEach(() => {
    globalThis.fetch = mockKeyFetch();
    sealPdfInBrowser.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:sealed-pdf");
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("simplifies the landing page into an AR scanner with a PDF stamping entry point", () => {
    render(React.createElement(App));

    expect(screen.getByRole("heading", { name: "Point at a QRed seal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start scanning" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open PDF stamping tool" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "QRed Verifier" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Demo: Upload and Seal a PDF" })).toBeNull();
  });

  it("loads default keys and seals the PDF in the browser without a backend", async () => {
    sealPdfInBrowser.mockResolvedValue({
      blob: new Blob(["sealed in browser"], { type: "application/pdf" }),
      sealResult: { document_id: "DOC-DEFAULT-KEYS" },
    });
    render(React.createElement(App));
    fireEvent.click(screen.getByRole("button", { name: "Open PDF stamping tool" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Use Default Keys" })).toBeTruthy());

    const privateKeyInput = screen.getByLabelText("Private Key");
    const publicKeyInput = screen.getByLabelText("Public Key");

    expect(privateKeyInput.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show private key" }));
    expect(privateKeyInput.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide private key" }));
    expect(privateKeyInput.type).toBe("password");

    await waitFor(() => expect(privateKeyInput.value).toBe(defaultPrivateKey));
    expect(publicKeyInput.value).toBe(defaultPublicKey);
    expect(screen.getByText("Static demo keys loaded from qred.org. Configure QRED_DEFAULT_PRIVATE_KEY, QRED_DEFAULT_PUBLIC_KEY, and QRED_DEFAULT_KEY_ID on the Worker to use stable custom defaults.")).toBeTruthy();

    const pdf = new File(["%PDF-1.4"], "source.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("PDF file"), { target: { files: [pdf] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF and Stamp QR Seals" }));

    await waitFor(() => expect(sealPdfInBrowser).toHaveBeenCalled());
    expect(sealPdfInBrowser).toHaveBeenCalledWith({
      file: pdf,
      issuer: "QRed Demo Authority",
      privateKey: defaultPrivateKey,
      publicKey: defaultPublicKey,
      bootstrapUrl: "https://qred.org/",
      encodingStrategy: "automatic",
    });
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    expect(screen.getByText(/Sealed source\.pdf in this browser\./)).toBeTruthy();
  });

  it("falls back to bundled demo keys when the static key endpoint is unavailable", async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url === "/api/keys/default") {
        return Promise.reject(new Error("offline"));
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });
    sealPdfInBrowser.mockResolvedValue({
      blob: new Blob(["sealed in browser"], { type: "application/pdf" }),
      sealResult: { document_id: "DOC-BROWSER-FALLBACK" },
    });

    render(React.createElement(App));
    fireEvent.click(screen.getByRole("button", { name: "Open PDF stamping tool" }));

    await waitFor(() => expect(screen.getByLabelText("Private Key").value).toBe("txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes="));
    const pdf = new File(["%PDF-1.4"], "static.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("PDF file"), { target: { files: [pdf] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF and Stamp QR Seals" }));

    await waitFor(() => expect(sealPdfInBrowser).toHaveBeenCalledWith({
      file: pdf,
      issuer: "QRed Demo Authority",
      privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=",
      publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
      bootstrapUrl: "https://qred.org/",
      encodingStrategy: "automatic",
    }));
    expect(await screen.findByText(/Sealed static\.pdf in this browser\./)).toBeTruthy();
  });
});
