/* @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App.jsx";

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
    URL.createObjectURL = vi.fn(() => "blob:sealed-pdf");
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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
  });
});
