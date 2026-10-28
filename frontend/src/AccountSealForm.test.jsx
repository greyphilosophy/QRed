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
  amazon: "https://www.amazon.com/ap/oa",
})[provider];
const session = provider => ({
  id: "test-auth-id", secret: "test-secret", provider, authorize_url: mockAuthUrl(provider),
  salts: [], commitments: [], startedAt: Date.now(),
});
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, json: async () => ({ google: true, microsoft: true, amazon: true }),
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
  return screen.findByRole("link", { name: details.button });
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
    expect(details.button).toMatch(/^Authenticate with (Google|Microsoft|Amazon) login$/);
    const selection = screen.getByRole("button", { name: details.button });
    expect(selection.getAttribute("aria-pressed")).toBe("false");
  }
  fireEvent.click(screen.getByRole("button", { name: AUTH_PROVIDERS.google.button }));
  expect(screen.getByRole("button", { name: AUTH_PROVIDERS.google.button }).getAttribute("aria-pressed")).toBe("true");
  expect(offline.getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByLabelText("Private Key")).toBeNull();
  expect(screen.getByText(/Choose a PDF to begin automatic preparation/)).toBeTruthy();
  fireEvent.click(offline);
  expect(offline.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByLabelText("Private Key")).toBeTruthy();
});

it("disables an unconfigured provider and recovers from a failed availability check", async () => {
  fetch.mockRejectedValueOnce(new Error("offline"));
  fetch.mockResolvedValueOnce({
    ok: true, json: async () => ({ google: true, microsoft: false, amazon: false }),
  });
  const open = vi.spyOn(window, "open");
  render(<PdfSealForm />);
  fireEvent.click(screen.getByRole("button", { name: AUTH_PROVIDERS.microsoft.button }));
  expect(screen.getByText(/Choose a PDF to begin automatic preparation/)).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Retry sign-in availability" }));
  await screen.findByText(/Microsoft sealing is not enabled/);
  expect(screen.getByRole("button", { name: AUTH_PROVIDERS.microsoft.button }).disabled).toBe(true);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: AUTH_PROVIDERS.google.button }));
  await waitFor(() => expect(screen.getByRole("button", { name: AUTH_PROVIDERS.google.button }).getAttribute("aria-pressed")).toBe("true"));
});

it.each(Object.entries(AUTH_PROVIDERS))("auto-prepares %s after file selection, then opens only on an explicit sign-in click", async (provider, details) => {
  const open = vi.spyOn(window, "open");
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
  expect(signIn.tagName).toBe("A");
  expect(signIn.getAttribute("href")).toBe(mockAuthUrl(provider));
  // Only the provider-issued authorization URL is navigated to; the private
  // document-specific QRed session secret is never put in an address bar.
  expect(signIn.getAttribute("href")).not.toContain("test-secret");
  expect(signIn.getAttribute("target")).toBe("_blank");
  expect(signIn.getAttribute("rel")).toContain("noopener");
  expect(signIn.getAttribute("rel")).toContain("noreferrer");
  fireEvent.click(signIn);
  await screen.findByText(/Sealed source.pdf in this browser/);
  expect(open).not.toHaveBeenCalled(); // No JavaScript popup is ever created.
  expect(attestPagesWithAccount).toHaveBeenCalledWith(provider, [], expect.objectContaining({
    popup: null, preparedSession: expect.objectContaining({ provider }), signal: expect.any(AbortSignal),
  }));
  expect(screen.getByText(new RegExp(details.label.replace(/[()]/g, "\\$&") + " account: example@gmail.com")).textContent)
    .toContain(details.label + " profile");
});

it("automatically prepares during delayed mobile PDF parsing but opens no popup until sign-in is tapped", async () => {
  let parsed;
  const parsing = new Promise(resolve => { parsed = resolve; });
  const open = vi.spyOn(window, "open");
  URL.createObjectURL = vi.fn(() => "blob:sealed"); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  sealPdfInBrowser.mockImplementation(async options => {
    await parsing; // Represent a resource-heavy mobile PDF flatten/extraction.
    await options.attestPages([]);
    return { blob: new Blob(["pdf"]), sealResult: {} };
  });
  attestPagesWithAccount.mockResolvedValue([]);
  render(<PdfSealForm />);
  fireEvent.click(screen.getByRole("button", { name: AUTH_PROVIDERS.google.button }));
  upload();
  await waitFor(() => expect(screen.getByRole("button", { name: "Preparing document..." })).toBeTruthy());
  expect(screen.getByRole("button", { name: "Preparing document..." })).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  parsed();
  const signIn = await screen.findByRole("link", { name: AUTH_PROVIDERS.google.button });
  expect(open).not.toHaveBeenCalled();
  expect(signIn.getAttribute("href")).toBe(mockAuthUrl("google"));
  fireEvent.click(signIn);
  await screen.findByText(/Sealed source.pdf in this browser/);
  expect(open).not.toHaveBeenCalled();
});

it("auto-prepares an already selected PDF after choosing an account method", async () => {
  sealPdfInBrowser.mockImplementation(options => options.attestPages([]));
  const open = vi.spyOn(window, "open");
  render(<PdfSealForm />);
  upload();
  expect(beginAccountSignIn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: AUTH_PROVIDERS.google.button }));
  const signIn = await screen.findByRole("link", { name: AUTH_PROVIDERS.google.button });
  expect(signIn.getAttribute("href")).toBe(mockAuthUrl("google"));
  expect(beginAccountSignIn).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel sealing" }));
  await screen.findByText("Account sealing cancelled.");
  expect(finishAccountSignIn).toHaveBeenCalledTimes(1);
});

it("cancels a prepared but unopened account session, clearing its cookies", async () => {
  const open = vi.spyOn(window, "open");
  sealPdfInBrowser.mockImplementation(options => options.attestPages([]));
  render(<PdfSealForm />);
  await prepare("google");
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel sealing" }));
  await screen.findByText("Account sealing cancelled.");
  expect(finishAccountSignIn).toHaveBeenCalledWith("google", expect.objectContaining({ provider: "google" }));
  expect(open).not.toHaveBeenCalled();
});

it("cancels an in-progress account request without saving a document", async () => {
  const open = vi.spyOn(window, "open");
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
  await waitFor(() => expect(screen.getByRole("button", { name: "Completing sign-in..." }).disabled).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Cancel sealing" }));
  await screen.findByText("Account sealing cancelled.");
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});


it("lets a phone user recheck pending, rejected and completed provider status without reopening provider", async () => {
  const open = vi.spyOn(window, "open");
  // Keep the original QRed account flow waiting after the popup closes; a
  // status recheck must not issue a new authorization or upload the PDF.
  attestPagesWithAccount.mockImplementation(() => new Promise(() => {}));
  sealPdfInBrowser.mockImplementation(options => options.attestPages([]));
  render(<PdfSealForm />);
  const signIn = await prepare("google");
  fireEvent.click(signIn);
  const check = await screen.findByRole("button", { name: "Check sign-in status" });
  fireEvent.click(check);
  await screen.findByText(/QRed has not received a completed sign-in from the provider/);
  expect(checkAccountSignInStatus).toHaveBeenCalledWith("google", expect.objectContaining({
    id: "test-auth-id", secret: "test-secret", provider: "google",
  }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(open).not.toHaveBeenCalled();
  expect(beginAccountSignIn).toHaveBeenCalledTimes(1);

  checkAccountSignInStatus.mockResolvedValueOnce({ status: "failed",
    error: "Google declined QRed's authorization code exchange (HTTP 400; OAuth invalid_grant)" });
  fireEvent.click(check);
  await screen.findByText(/Account sign-in failed: Google declined QRed's authorization code exchange/);

  checkAccountSignInStatus.mockResolvedValueOnce({ status: "ready" });
  fireEvent.click(check);
  await screen.findByText(/Account sign-in verified by QRed. Finishing your PDF locally/);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel sealing" }));
});

it("reports missing or expired browser session on an explicit status check without exposing secrets", async () => {
  const open = vi.spyOn(window, "open");
  attestPagesWithAccount.mockImplementation(() => new Promise(() => {}));
  sealPdfInBrowser.mockImplementation(options => options.attestPages([]));
  checkAccountSignInStatus.mockRejectedValue(new Error("Sign-in request expired or belongs to another browser"));
  render(<PdfSealForm />);
  fireEvent.click(await prepare("google"));
  fireEvent.click(await screen.findByRole("button", { name: "Check sign-in status" }));
  const message = await screen.findByText(/Could not confirm account sign-in:/);
  expect(message.textContent).toContain("Sign-in request expired or belongs to another browser");
  expect(message.textContent).not.toContain("test-secret");
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel sealing" }));
});


it("leaves the provider tab visible after a failed OAuth exchange, rather than silently closing it", async () => {
  const open = vi.spyOn(window, "open");
  attestPagesWithAccount.mockRejectedValue(new Error("Google declined QRed's authorization code exchange (HTTP 400; OAuth invalid_grant)"));
  sealPdfInBrowser.mockImplementation(options => options.attestPages([]));
  render(<PdfSealForm />);
  fireEvent.click(await prepare("google"));
  const message = await screen.findByText(/PDF sealing failed: Google declined QRed's authorization code exchange/);
  expect(message.textContent).toContain("OAuth invalid_grant");
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Check sign-in status" })).toBeNull();
});
