/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { beginAccountSignIn, finishAccountSignIn, attestPagesWithAccount } from "./accountSealing.js";
import { AUTH_PROVIDERS } from "./authProviders.js";

vi.mock("./pdfClientSeal.js", () => ({ sealPdfInBrowser: vi.fn() }));
vi.mock("./accountSealing.js", () => ({
  accountSealingAvailable: true,
  beginAccountSignIn: vi.fn(), finishAccountSignIn: vi.fn(), attestPagesWithAccount: vi.fn(),
}));

const mockAuthUrl = provider => ({
  google: "https://accounts.google.com/o/oauth2/v2/auth",
  microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  meta: "https://www.facebook.com/v26.0/dialog/oauth",
  amazon: "https://www.amazon.com/ap/oa",
})[provider];
const session = provider => ({
  id: "test-auth-id", secret: "test-secret", provider, authorize_url: mockAuthUrl(provider),
  salts: [], commitments: [], startedAt: Date.now(),
});
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, json: async () => ({ google: true, microsoft: true, meta: true, amazon: true }),
  })));
  beginAccountSignIn.mockImplementation(async provider => session(provider));
  finishAccountSignIn.mockResolvedValue();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const upload = () => fireEvent.change(screen.getByLabelText("Open PDF"), {
  target: { files: [new File(["pdf"], "source.pdf")] },
});
async function prepare(provider, details = AUTH_PROVIDERS[provider]) {
  fireEvent.change(screen.getByLabelText("Sealing method"), { target: { value: provider } });
  upload();
  const prep = await screen.findByRole("button", { name: `Prepare PDF for ${details.label} sign-in` });
  await waitFor(() => expect(prep.disabled).toBe(false));
  fireEvent.click(prep);
  return screen.findByRole("button", { name: details.button });
}

it("does not check account services during private-key/offline sealing", () => {
  render(<PdfSealForm />);
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Private Key")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stamp and save PDF" }).disabled).toBe(false);
});

it("disables an unconfigured provider and recovers from a failed availability check", async () => {
  fetch.mockRejectedValueOnce(new Error("offline"));
  fetch.mockResolvedValueOnce({
    ok: true, json: async () => ({ google: true, microsoft: false, meta: false, amazon: false }),
  });
  const open = vi.spyOn(window, "open");
  render(<PdfSealForm />);
  fireEvent.change(screen.getByLabelText("Sealing method"), { target: { value: "microsoft" } });
  expect(screen.getByRole("button", { name: /Prepare PDF for Microsoft sign-in/ }).disabled).toBe(true);
  fireEvent.click(await screen.findByRole("button", { name: "Retry sign-in availability" }));
  await screen.findByText(/Microsoft sealing is not enabled/);
  expect(screen.getByRole("button", { name: /Prepare PDF for Microsoft sign-in/ }).disabled).toBe(true);
  expect(open).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Sealing method"), { target: { value: "google" } });
  await waitFor(() => expect(screen.getByRole("button", { name: /Prepare PDF for Google sign-in/ }).disabled).toBe(false));
});

it.each(Object.entries(AUTH_PROVIDERS))("prepares %s first, then opens the real sign-in page on a fresh user gesture", async (provider, details) => {
  const popup = { close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(popup);
  URL.createObjectURL = vi.fn(() => "blob:sealed"); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  attestPagesWithAccount.mockImplementation(async (_provider, _pages, options) => {
    options.onIdentity({ email: "example@gmail.com", name: "Profile Name", name_source: provider });
    return [];
  });
  sealPdfInBrowser.mockImplementation(async options => {
    expect(options).not.toHaveProperty("privateKey"); expect(options).not.toHaveProperty("publicKey");
    await options.attestPages([]);
    return { blob: new Blob(["pdf"]), sealResult: { version: "4", timestamp: "2026-10-20T00:00:00Z" } };
  });
  render(<PdfSealForm />);
  const signIn = await prepare(provider, details);
  expect(open).not.toHaveBeenCalled(); // No empty popup during slow PDF prep.
  expect(beginAccountSignIn).toHaveBeenCalledWith(provider, [], expect.objectContaining({ signal: expect.any(AbortSignal) }));
  fireEvent.click(signIn);
  await screen.findByText(/Sealed source.pdf in this browser/);
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(mockAuthUrl(provider), "_blank", expect.any(String));
  expect(open.mock.calls[0][0]).not.toBe("about:blank");
  expect(attestPagesWithAccount).toHaveBeenCalledWith(provider, [], expect.objectContaining({
    popup, preparedSession: expect.objectContaining({ provider }), signal: expect.any(AbortSignal),
  }));
  expect(screen.getByText(new RegExp(details.label.replace(/[()]/g, "\\$&") + " account: example@gmail.com")).textContent)
    .toContain(details.label + " profile");
  expect(popup.close).toHaveBeenCalled();
});

it("never opens a mobile popup during delayed PDF parsing; sign-in begins only on a second tap", async () => {
  let parsed;
  const parsing = new Promise(resolve => { parsed = resolve; });
  const popup = { close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(popup);
  URL.createObjectURL = vi.fn(() => "blob:sealed"); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  sealPdfInBrowser.mockImplementation(async options => {
    await parsing; // Represent a resource-heavy mobile PDF flatten/extraction.
    await options.attestPages([]);
    return { blob: new Blob(["pdf"]), sealResult: {} };
  });
  attestPagesWithAccount.mockResolvedValue([]);
  render(<PdfSealForm />);
  fireEvent.change(screen.getByLabelText("Sealing method"), { target: { value: "meta" } });
  upload();
  await waitFor(() => expect(screen.getByRole("button", { name: "Prepare PDF for Facebook (Meta) sign-in" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Prepare PDF for Facebook (Meta) sign-in" }));
  expect(screen.getByRole("button", { name: "Preparing document..." })).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  parsed();
  const signIn = await screen.findByRole("button", { name: "Continue with Facebook" });
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(signIn);
  await screen.findByText(/Sealed source.pdf in this browser/);
  expect(open).toHaveBeenCalledWith(mockAuthUrl("meta"), "_blank", expect.any(String));
});

it("cancels a prepared but unopened account session, clearing its cookies", async () => {
  const open = vi.spyOn(window, "open");
  sealPdfInBrowser.mockImplementation(options => options.attestPages([]));
  render(<PdfSealForm />);
  await prepare("meta");
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel sealing" }));
  await screen.findByText("Account sealing cancelled.");
  expect(finishAccountSignIn).toHaveBeenCalledWith("meta", expect.objectContaining({ provider: "meta" }));
  expect(open).not.toHaveBeenCalled();
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
  const signIn = await prepare("google");
  fireEvent.click(signIn);
  expect(screen.getByRole("button", { name: "Completing sign-in..." }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel sealing" }));
  await screen.findByText("Account sealing cancelled.");
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(popup.close).toHaveBeenCalled();
});
