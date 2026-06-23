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

function mockSuccessfulPdfSeal() {
  return vi.fn((url) => {
    if (url === "/api/keys/default") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ private_key: defaultPrivateKey, public_key: defaultPublicKey, source: "environment" }),
      });
    }

    if (url === "/api/pdf/upload-seal") {
      return Promise.resolve({
        ok: true,
        blob: () => Promise.resolve(new Blob(["sealed pdf"], { type: "application/pdf" })),
        headers: { get: (name) => (name === "X-QRed-Document-Id" ? "DOC-DEFAULT-KEYS" : null) },
      });
    }

    return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
  });
}

describe("App PDF sealing defaults", () => {
  beforeEach(() => {
    globalThis.fetch = mockSuccessfulPdfSeal();
    sealPdfInBrowser.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:sealed-pdf");
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });


  it("puts the verifier first and removes the standalone seal generator from the landing page", async () => {
    render(React.createElement(App));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Verify QRed Document" })).toBeTruthy());

    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Verify QRed Document", "Demo: Upload and Seal a PDF"]);
    expect(screen.queryByRole("heading", { name: "Generate QRed Seals" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open mobile verifier" })).toBeNull();
    expect(screen.getByText("QR bootstrap target: https://qred.org/")).toBeTruthy();
  });

  it("loads default keys, obfuscates the private key, and submits them with the PDF seal request", async () => {
    render(React.createElement(App));

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
    expect(screen.getByText("Default keys loaded from server environment.")).toBeTruthy();

    const pdf = new File(["%PDF-1.4"], "source.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("PDF file"), { target: { files: [pdf] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF and Stamp QR Seals" }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/pdf/upload-seal",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    ));

    const uploadCall = globalThis.fetch.mock.calls.find(([url]) => url === "/api/pdf/upload-seal");
    const form = uploadCall[1].body;
    expect(form.get("private_key")).toBe(defaultPrivateKey);
    expect(form.get("public_key")).toBe(defaultPublicKey);
    expect(form.get("issuer")).toBe("QRed Demo Authority");
    expect(form.get("bootstrap_url")).toBe("https://qred.org/");
  });

  it("falls back to browser-side PDF sealing when the static Worker has no backend origin", async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url === "/api/keys/default") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ private_key: defaultPrivateKey, public_key: defaultPublicKey, source: "worker-static-demo" }),
        });
      }

      if (url === "/api/pdf/upload-seal") {
        return Promise.resolve({
          ok: false,
          text: () => Promise.resolve(JSON.stringify({
            message: "The static verifier is available, but API-backed demo endpoints require a separate QRed backend origin.",
          })),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });
    sealPdfInBrowser.mockResolvedValue({
      blob: new Blob(["sealed in browser"], { type: "application/pdf" }),
      sealResult: { document_id: "DOC-BROWSER-FALLBACK" },
    });

    render(React.createElement(App));

    await waitFor(() => expect(screen.getByLabelText("Private Key").value).toBe(defaultPrivateKey));
    const pdf = new File(["%PDF-1.4"], "static.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("PDF file"), { target: { files: [pdf] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF and Stamp QR Seals" }));

    await waitFor(() => expect(sealPdfInBrowser).toHaveBeenCalledWith({
      file: pdf,
      issuer: "QRed Demo Authority",
      privateKey: defaultPrivateKey,
      publicKey: defaultPublicKey,
      bootstrapUrl: "https://qred.org/",
    }));
    expect(await screen.findByText("Sealed static.pdf in this browser. Document ID: DOC-BROWSER-FALLBACK")).toBeTruthy();
  });
});
