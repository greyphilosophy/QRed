/* @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sealPdfInBrowser } from "./pdfClientSeal.js";

vi.mock("./pdfClientSeal.js", () => ({
  sealPdfInBrowser: vi.fn(),
}));

const defaultPublicKey = "default-public-key";

function mockKeyFetch() {
  return vi.fn((url) => {
    if (url === "/api/keys/default") {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve(""),
        json: () => Promise.resolve({
          public_key: defaultPublicKey,
          key_id: "0000000000000000",
          source: "static-demo",
        }),
      });
    }
    return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
  });
}

describe("App PDF sealing defaults", () => {
  beforeEach(() => {
    globalThis.fetch = mockKeyFetch();
    sealPdfInBrowser.mockReset();
    sealPdfInBrowser.mockResolvedValue({
      blob: new Blob(["sealed in browser"], { type: "application/pdf" }),
      sealResult: { document_id: "DOC-DEFAULT", total_seals: 1 },
      pageSealResults: [],
      pageSealStrings: [],
      stampedQrValues: [],
    });
    URL.createObjectURL = vi.fn(() => "blob:sealed-pdf");
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("simplifies the landing page into an AR scanner with a PDF stamping entry point", async () => {
    const { default: App } = await import("./App.jsx");
    render(React.createElement(App));

    expect(screen.getByRole("heading", { name: "Point at a QRed seal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start scanning" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open PDF stamping tool" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "QRed Verifier" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Demo: Upload and Seal a PDF" })).toBeNull();
  });

  it("loads the public key and requires the user to enter the private key", async () => {
    const { default: App } = await import("./App.jsx");
    render(React.createElement(App));
    fireEvent.click(screen.getByRole("button", { name: "Open PDF stamping tool" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Use Default Keys" })).toBeTruthy());
    expect(screen.getByLabelText("Page scaling")).toBeTruthy();

    const privateKeyInput = screen.getByLabelText("Private Key");
    const publicKeyInput = screen.getByLabelText("Public Key");

    expect(privateKeyInput.type).toBe("password");
    expect(privateKeyInput.value).toBe("");
    expect(publicKeyInput.value).toBe(defaultPublicKey);

    expect(screen.getByText("Public key loaded. Please enter your private key before sealing. (The server does not store private keys.)")).toBeTruthy();

    fireEvent.change(privateKeyInput, { target: { value: "user-private-key" } });
    expect(privateKeyInput.value).toBe("user-private-key");

    const pdf = new File(["%PDF-1.4"], "source.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("PDF file"), { target: { files: [pdf] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF and Stamp QR Seals" }));

    await waitFor(() => expect(sealPdfInBrowser).toHaveBeenCalled());
    expect(sealPdfInBrowser).toHaveBeenCalledWith({
      file: pdf,
      issuer: "QRed Demo Authority",
      privateKey: "user-private-key",
      publicKey: defaultPublicKey,
      bootstrapUrl: "https://qred.org/",
      encodingStrategy: "automatic",
      pageScalingStrategy: "automatic",
    });
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    expect(screen.getByText(/Sealed source\.pdf in this browser\./)).toBeTruthy();
  });

  it("falls back to bundled public key when the static key endpoint is unavailable", async () => {
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

    const { default: App } = await import("./App.jsx");
    render(React.createElement(App));
    fireEvent.click(screen.getByRole("button", { name: "Open PDF stamping tool" }));

    const privateKeyInput = screen.getByLabelText("Private Key");
    const publicKeyInput = screen.getByLabelText("Public Key");

    expect(privateKeyInput.value).toBe("");

    await waitFor(() => {
      const key = publicKeyInput.value;
      // fallback key contains bundled constant
      expect(key).toBe("eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=");
    });

    fireEvent.change(privateKeyInput, { target: { value: "user-private-key" } });
    const pdf = new File(["%PDF-1.4"], "static.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("PDF file"), { target: { files: [pdf] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload PDF and Stamp QR Seals" }));

    await waitFor(() => expect(sealPdfInBrowser).toHaveBeenCalled());
    expect(await screen.findByText(/Sealed static\.pdf in this browser\./)).toBeTruthy();
  });

  it("keeps existing user private key after reloading public key", async () => {
    const { default: App } = await import("./App.jsx");
    render(React.createElement(App));
    fireEvent.click(screen.getByRole("button", { name: "Open PDF stamping tool" }));

    const privateKeyInput = screen.getByLabelText("Private Key");
    fireEvent.change(privateKeyInput, { target: { value: "my-secret-key" } });
    expect(privateKeyInput.value).toBe("my-secret-key");

    await waitFor(() => expect(screen.getByRole("button", { name: "Use Default Keys" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Use Default Keys" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Use Default Keys" })).toBeTruthy());

    expect(privateKeyInput.value).toBe("my-secret-key");
    expect(screen.getByText("Public key loaded. Ready to seal with your private key.")).toBeTruthy();
  });

  it("hides/shows private key field", async () => {
    const { default: App } = await import("./App.jsx");
    render(React.createElement(App));
    fireEvent.click(screen.getByRole("button", { name: "Open PDF stamping tool" }));

    const privateKeyInput = screen.getByLabelText("Private Key");

    expect(privateKeyInput.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show private key" }));
    expect(privateKeyInput.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide private key" }));
    expect(privateKeyInput.type).toBe("password");
  });

  it("returns public key only from /api/keys/default — no private key exposed", async () => {
    const mockFetch = vi.fn((url) => {
      if (url === "/api/keys/default") {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          text: () => Promise.resolve(""),
          json: () => Promise.resolve({
            public_key: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
            key_id: "da522162396ab2d0",
            source: "static-demo",
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });
    globalThis.fetch = mockFetch;

    const { default: App } = await import("./App.jsx");
    render(React.createElement(App));
    fireEvent.click(screen.getByRole("button", { name: "Open PDF stamping tool" }));

    await waitFor(() => expect(screen.getByLabelText("Public Key")).toBeTruthy());

    expect(mockFetch).toHaveBeenCalledWith("/api/keys/default");

    const callArgs = mockFetch.mock.calls[0][0];
    const response = await mockFetch(callArgs);
    const data = await response.json();
    expect(data).toHaveProperty("public_key");
    expect(data).not.toHaveProperty("private_key");
  });
});
