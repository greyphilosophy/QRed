/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { attestPagesWithAccount } from "./accountSealing.js";
import { AUTH_PROVIDERS } from "./authProviders.js";

vi.mock("./pdfClientSeal.js", () => ({ sealPdfInBrowser: vi.fn() }));
vi.mock("./accountSealing.js", () => ({ accountSealingAvailable: true, attestPagesWithAccount: vi.fn() }));
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ google: true, microsoft: true, meta: true, amazon: true }) }))));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("does not check account services during private-key/offline sealing", () => {
  render(<PdfSealForm />);
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Private Key")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stamp and save PDF" }).disabled).toBe(false);
});

it("disables an unconfigured provider and recovers from a failed availability check", async () => {
  fetch.mockRejectedValueOnce(new Error("offline"));
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ google: true, microsoft: false, meta: false, amazon: false }) });
  const open = vi.spyOn(window, "open");
  render(<PdfSealForm />);
  fireEvent.change(screen.getByLabelText("Sealing method"), { target: { value: "microsoft" } });
  expect(screen.getByRole("button", { name: "Sign in with Microsoft" }).disabled).toBe(true);
  fireEvent.click(await screen.findByRole("button", { name: "Retry sign-in availability" }));
  await screen.findByText(/Microsoft sealing is not enabled/);
  expect(screen.getByRole("button", { name: "Sign in with Microsoft" }).disabled).toBe(true);
  expect(open).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Sealing method"), { target: { value: "google" } });
  expect(screen.getByRole("button", { name: "Sign in with Google" }).disabled).toBe(false);
});

it.each(Object.entries(AUTH_PROVIDERS))("offers %s sealing without a name field and displays its profile identity", async (provider, details) => {
  const popup = { close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup);
  URL.createObjectURL = vi.fn(() => "blob:sealed"); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  attestPagesWithAccount.mockImplementation(async (_provider, _pages, options) => {
    options.onIdentity({ email: "example@gmail.com", name: "Profile Name", name_source: "google" });
    return [];
  });
  sealPdfInBrowser.mockImplementation(async options => {
    expect(options).not.toHaveProperty("privateKey"); expect(options).not.toHaveProperty("publicKey");
    await options.attestPages([]);
    return { blob: new Blob(["pdf"]), sealResult: { version: "4", timestamp: "2026-10-20T00:00:00Z" } };
  });
  render(<PdfSealForm />);
  fireEvent.change(screen.getByLabelText("Sealing method"), { target: { value: provider } });
  expect(screen.queryByLabelText("Private Key")).toBeNull();
  expect(screen.queryByLabelText("Public Key")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [new File(["pdf"], "source.pdf")] } });
  await waitFor(() => expect(screen.getByRole("button", { name: details.button }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: details.button }));
  await screen.findByText(/Sealed source.pdf in this browser/);
  expect(attestPagesWithAccount).toHaveBeenCalledWith(provider, [], expect.objectContaining({ popup, signal: expect.any(AbortSignal) }));
  expect(attestPagesWithAccount.mock.lastCall[2]).not.toHaveProperty("name");
  expect(screen.getByText(new RegExp(details.label.replace(/[()]/g, "\\$&") + " account: example@gmail.com")).textContent).toContain(details.label + " profile");
  expect(popup.close).toHaveBeenCalled();
});

it("cancels an in-progress account request without saving a document", async () => {
  const popup = { close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup);
  URL.createObjectURL = vi.fn();
  attestPagesWithAccount.mockImplementation((_provider, _pages, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
  }));
  sealPdfInBrowser.mockImplementation(options => options.attestPages([]));
  render(<PdfSealForm />);
  fireEvent.change(screen.getByLabelText("Sealing method"), { target: { value: "google" } });
  fireEvent.change(screen.getByLabelText("Open PDF"), { target: { files: [new File(["pdf"], "source.pdf")] } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Sign in with Google" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
  expect(screen.getByRole("button", { name: "Sign in with Google" }).disabled).toBe(true);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel sealing" }));
  await screen.findByText("Account sealing cancelled.");
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(popup.close).toHaveBeenCalled();
});
