/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { beginAccountSignIn, finishAccountSignIn, checkAccountSignInStatus, attestPagesWithAccount } from "./accountSealing.js";
import { AUTH_PROVIDERS } from "./authProviders.js";

vi.mock("./pdfClientSeal.js", () => ({ sealPdfInBrowser: vi.fn() }));
vi.mock("./accountSealing.js", () => ({
  accountSealingAvailable: true,
  beginAccountSignIn: vi.fn(), finishAccountSignIn: vi.fn(), checkAccountSignInStatus: vi.fn(), attestPagesWithAccount: vi.fn(),
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
  checkAccountSignInStatus.mockResolvedValue({ status: "pending" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const upload = () => fireEvent.change(screen.getByLabelText("Open PDF"), {
  target: { files: [new File(["pdf"], "source.pdf")] },
});
async function prepare(provider, details = AUTH_PROVIDERS[provider]) {
  fireEvent.click(screen.getByRole("button", { name: details.button }));
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

it("presents each account provider as a separate, consistently labelled, selectable button", async () => {
  render(<PdfSealForm />);
  expect(screen.queryByLabelText("Sealing method")).toBeNull();
  const offline = screen.getByRole("button", { name: "Private key (offline)" });
  expect(offline.getAttribute("aria-pressed")).toBe("true");
  for (const details of Object.values(AUTH_PROVIDERS)) {
    expect(details.button).toMatch(/^Authenticate with (Google|Microsoft|Facebook|Amazon) login$/);
    const selection = screen.getByRole("button", { name: details.button });
    expect(selection.getAttribute("aria-pressed")).toBe("false");
  }
  fireEvent.click(screen.getByRole("button", { name: AUTH_PROVIDERS.meta.button }));
  expect(screen.getByRole("button", { name: AUTH_PROVIDERS.meta.button }).getAttribute("aria-pressed")).toBe("true");
  expect(offline.getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByLabelText("Private Key")).toBeNull();
  expect(screen.getByRole("button", { name: "Prepare PDF for Facebook (Meta) sign-in" })).toBeTruthy();
  fireEvent.click(offline);
  expect(offline.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByLabelText("Private Key")).toBeTruthy();
});

it("disables an unconfigured provider and recovers from a failed availability check", async () => {
  fetch.mockRejectedValueOnce(new Error("offline"));
  fetch.mockResolvedValueOnce({
    ok: true, json: async () => ({ google: true, microsoft: false, meta: false, amazon: false }),
  });
  const open = vi.spyOn(window, "open");
  render(<PdfSealForm />);
  fireEvent.click(screen.getByRole("button", { name: AUTH_PROVIDERS.microsoft.button }));
  expect(screen.getByRole("button", { name: /Prepare PDF for Microsoft sign-in/ }).disabled).toBe(true);
  fireEvent.click(await screen.findByRole("button", { name: "Retry sign-in availability" }));
  await screen.findByText(/Microsoft sealing is not enabled/);
  expect(screen.getByRole("button", { name: /Prepare PDF for Microsoft sign-in/ }).disabled).toBe(true);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: AUTH_PROVIDERS.google.button }));
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
  fireEvent.click(screen.getByRole("button", { name: AUTH_PROVIDERS.meta.button }));
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
    // Cancellation may happen before this continuation runs. Match the real
    // polling code, which checks signal.aborted as well as listening for abort.
    if (signal.aborted) { reject(new Error("Aborted")); return; }
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


it("lets a phone user recheck pending, rejected and completed provider status without reopening Facebook", async () => {
  const popup = { close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(popup);
  // Keep the original QRed account flow waiting after the popup closes; a
  // status recheck must not issue a new authorization or upload the PDF.
  attestPagesWithAccount.mockImplementation(() => new Promise(() => {}));
  sealPdfInBrowser.mockImplementation(options => options.attestPages([]));
  render(<PdfSealForm />);
  const signIn = await prepare("meta");
  fireEvent.click(signIn);
  const check = await screen.findByRole("button", { name: "Check sign-in status" });
  fireEvent.click(check);
  await screen.findByText(/QRed has not received a completed sign-in from the provider/);
  expect(checkAccountSignInStatus).toHaveBeenCalledWith("meta", expect.objectContaining({
    id: "test-auth-id", secret: "test-secret", provider: "meta",
  }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(open).toHaveBeenCalledTimes(1);
  expect(beginAccountSignIn).toHaveBeenCalledTimes(1);

  checkAccountSignInStatus.mockResolvedValueOnce({ status: "failed",
    error: "Facebook rejected QRed's login code exchange (HTTP 400; Meta error 100)" });
  fireEvent.click(check);
  await screen.findByText(/Account sign-in failed: Facebook rejected QRed's login code exchange/);

  checkAccountSignInStatus.mockResolvedValueOnce({ status: "ready" });
  fireEvent.click(check);
  await screen.findByText(/Account sign-in verified by QRed. Finishing your PDF locally/);
  expect(open).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel sealing" }));
});

it("reports missing or expired browser session on an explicit status check without exposing secrets", async () => {
  const popup = { close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup);
  attestPagesWithAccount.mockImplementation(() => new Promise(() => {}));
  sealPdfInBrowser.mockImplementation(options => options.attestPages([]));
  checkAccountSignInStatus.mockRejectedValue(new Error("Sign-in request expired or belongs to another browser"));
  render(<PdfSealForm />);
  fireEvent.click(await prepare("meta"));
  fireEvent.click(await screen.findByRole("button", { name: "Check sign-in status" }));
  const message = await screen.findByText(/Could not confirm account sign-in:/);
  expect(message.textContent).toContain("Sign-in request expired or belongs to another browser");
  expect(message.textContent).not.toContain("test-secret");
  fireEvent.click(screen.getByRole("button", { name: "Cancel sealing" }));
});


it("leaves the provider tab visible after a failed OAuth exchange, rather than silently closing it", async () => {
  const popup = { close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup);
  attestPagesWithAccount.mockRejectedValue(new Error("Facebook rejected QRed's login code exchange (HTTP 400; Meta error 100)"));
  sealPdfInBrowser.mockImplementation(options => options.attestPages([]));
  render(<PdfSealForm />);
  fireEvent.click(await prepare("meta"));
  const message = await screen.findByText(/PDF sealing failed: Facebook rejected QRed's login code exchange/);
  expect(message.textContent).toContain("Meta error 100");
  expect(popup.close).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Check sign-in status" })).toBeNull();
});
