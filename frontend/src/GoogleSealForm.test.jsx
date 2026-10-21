/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { attestPagesWithGoogle } from "./googleSealing.js";

vi.mock("./pdfClientSeal.js", () => ({ sealPdfInBrowser: vi.fn() }));
vi.mock("./googleSealing.js", () => ({ googleSealingAvailable: true, attestPagesWithGoogle: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("offers Google sealing, hides local key controls and shows the account and name provenance", async () => {
  const popup = { close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup);
  URL.createObjectURL = vi.fn(() => "blob:sealed"); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  attestPagesWithGoogle.mockImplementation(async (_pages, options) => {
    options.onIdentity({ email: "example@gmail.com", name: "Profile Name", name_source: "google" });
    return [];
  });
  sealPdfInBrowser.mockImplementation(async options => {
    expect(options).not.toHaveProperty("privateKey"); expect(options).not.toHaveProperty("publicKey");
    await options.attestPages([]);
    return { blob: new Blob(["pdf"]), sealResult: { version: "4", timestamp: "2026-10-20T00:00:00Z" } };
  });
  render(<PdfSealForm />);
  fireEvent.change(screen.getByLabelText("Sealing method"), { target: { value: "google" } });
  expect(screen.queryByLabelText("Private Key")).toBeNull();
  expect(screen.queryByLabelText("Public Key")).toBeNull();
  fireEvent.change(screen.getByLabelText("Name (used only if Google does not provide one)"), { target: { value: "My fallback" } });
  fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [new File(["pdf"], "source.pdf")] } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in with Google and stamp PDF" }));
  await screen.findByText(/Sealed source.pdf in this browser/);
  expect(attestPagesWithGoogle).toHaveBeenCalledWith([], expect.objectContaining({ name: "My fallback", popup, signal: expect.any(AbortSignal) }));
  expect(screen.getByText(/Google account: example@gmail.com/).textContent).toContain("Google profile");
  expect(popup.close).toHaveBeenCalled();
});

it("cancels an in-progress Google request without saving a document", async () => {
  const popup = { close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup);
  URL.createObjectURL = vi.fn();
  attestPagesWithGoogle.mockImplementation((_pages, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
  }));
  sealPdfInBrowser.mockImplementation(options => options.attestPages([]));
  render(<PdfSealForm />);
  fireEvent.change(screen.getByLabelText("Sealing method"), { target: { value: "google" } });
  fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [new File(["pdf"], "source.pdf")] } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in with Google and stamp PDF" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel sealing" }));
  await screen.findByText("Google sealing cancelled.");
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(popup.close).toHaveBeenCalled();
});
