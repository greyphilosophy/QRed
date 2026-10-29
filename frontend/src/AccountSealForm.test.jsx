/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { beginAccountSignIn, finishAccountSignIn, checkAccountSignInStatus, attestPagesWithAccount } from "./accountSealing.js";
import { AUTH_PROVIDERS } from "./authProviders.js";
import { openAuthPendingTab } from "./authPendingTab.js";

vi.mock("./pdfClientSeal.js", () => ({ sealPdfInBrowser: vi.fn() }));
vi.mock("./authPendingTab.js", () => ({ openAuthPendingTab: vi.fn() }));
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
  openAuthPendingTab.mockReset().mockImplementation(() => popupTab());
  beginAccountSignIn.mockImplementation(async provider => session(provider));
  finishAccountSignIn.mockResolvedValue();
  checkAccountSignInStatus.mockReset().mockResolvedValue({ status: "pending" });
  attestPagesWithAccount.mockReset().mockResolvedValue([]);
  sealPdfInBrowser.mockReset().mockImplementation(async options => {
    await options.attestPages([]);
    return { blob: new Blob(["pdf"]), sealResult: {} };
  });
  URL.createObjectURL = vi.fn(() => "blob:sealed");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const upload = () => fireEvent.change(screen.getByLabelText("Open PDF"), {
  target: { files: [new File(["pdf"], "source.pdf")] },
});
function popupTab() {
  return { popup: { opener: null, closed: true, close: vi.fn() },
    authorize: vi.fn().mockResolvedValue(true), cancel: vi.fn(), dispose: vi.fn() };
}
function startProvider(provider) {
  upload();
  fireEvent.click(screen.getByRole("button", { name: AUTH_PROVIDERS[provider].button }));
}


it("starts with no signing method or network check, and only exposes offline keys when selected", () => {
  render(<PdfSealForm />);
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Open PDF")).toBeTruthy();
  expect(screen.getByLabelText("Page layout").value).toBe("automatic");
  expect(screen.queryByLabelText("Private Key")).toBeNull();
  expect(screen.queryByRole("button", { name: "Stamp and save PDF" })).toBeNull();
  const offline = screen.getByRole("button", { name: "Private key (offline)" });
  expect(offline.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(offline);
  expect(fetch).not.toHaveBeenCalled();
  expect(offline.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByLabelText("Private Key")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stamp and save PDF" }).disabled).toBe(false);
});

it("orders PDF, layout and providers, disabling account buttons until a PDF is selected", () => {
  const { container } = render(<PdfSealForm />);
  const pdf = screen.getByLabelText("Open PDF");
  const layout = screen.getByLabelText("Page layout");
  const offline = screen.getByRole("button", { name: "Private key (offline)" });
  const choices = [...container.querySelectorAll(".sealing-method-grid button")];
  expect(choices.at(-1)).toBe(offline);
  expect(choices.map(button => button.textContent.trim())).toEqual([
    ...Object.values(AUTH_PROVIDERS).map(details => details.button),
    "Private key (offline)",
  ]);
  expect(pdf.compareDocumentPosition(layout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(layout.compareDocumentPosition(choices[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(choices.every(button => button.getAttribute("aria-pressed") === "false")).toBe(true);
  expect(choices.slice(0, -1).every(button => button.disabled)).toBe(true);
  expect(offline.disabled).toBe(false);
  upload();
  expect(choices.slice(0, -1).every(button => !button.disabled)).toBe(true);
  expect(sealPdfInBrowser).not.toHaveBeenCalled();
});

it.each(Object.entries(AUTH_PROVIDERS))(
  "one %s button click opens a visible preparation tab and automatically starts OAuth",
  async (provider, details) => {
    const tab = popupTab();
    openAuthPendingTab.mockReturnValue(tab);
    attestPagesWithAccount.mockImplementation(async (_provider, _pages, options) => {
      expect(options.preparedSession.provider).toBe(provider);
      expect(options.popup).toBe(tab.popup);
      options.onIdentity({ email: "test@example.com", name: "Profile", name_source: provider });
      return [];
    });
    sealPdfInBrowser.mockImplementation(async options => {
      expect(options).not.toHaveProperty("privateKey");
      expect(options).not.toHaveProperty("publicKey");
      await options.attestPages([]);
      return { blob: new Blob(["pdf"]), sealResult: {}, flattenedFieldCount: 2, footerPages: [1] };
    });

    render(<PdfSealForm />);
    startProvider(provider);
    expect(openAuthPendingTab).toHaveBeenCalledOnce();
    expect(tab.popup.opener).toBeNull();
    await waitFor(() => expect(tab.authorize).toHaveBeenCalledWith(provider, mockAuthUrl(provider)));
    expect(beginAccountSignIn).toHaveBeenCalledWith(provider, [], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(tab.authorize.mock.calls[0][1]).not.toContain("test-secret");
    expect(attestPagesWithAccount).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Sealed source.pdf in this browser/)).toBeTruthy();
    expect(screen.getByText(/Sealed source.pdf in this browser/).textContent).toContain("Flattened 2 form field(s)");
    expect(tab.popup.close).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: details.button })).toBeTruthy();
  },
);

it("opens the preparation tab immediately even with slow PDF extraction", async () => {
  let continueParsing;
  const parsing = new Promise(resolve => { continueParsing = resolve; });
  const tab = popupTab();
  openAuthPendingTab.mockReturnValue(tab);
  sealPdfInBrowser.mockImplementation(async options => {
    await parsing;
    await options.attestPages([]);
    return { blob: new Blob(["pdf"]), sealResult: {} };
  });

  render(<PdfSealForm />);
  startProvider("google");
  expect(openAuthPendingTab).toHaveBeenCalledOnce();
  expect(tab.authorize).not.toHaveBeenCalled();
  expect(screen.getByText(/Preparing document/)).toBeTruthy();
  continueParsing();
  await waitFor(() => expect(tab.authorize).toHaveBeenCalledWith("google", mockAuthUrl("google")));
  await screen.findByText(/Sealed source.pdf in this browser/);
  expect(openAuthPendingTab).toHaveBeenCalledOnce();
});

it("falls back to a native provider link if a popup is blocked", async () => {
  openAuthPendingTab.mockReturnValue(null);
  let finishSealing;
  attestPagesWithAccount.mockImplementation(() => new Promise(resolve => { finishSealing = resolve; }));
  render(<PdfSealForm />);
  startProvider("google");
  expect(openAuthPendingTab).toHaveBeenCalledOnce();
  const link = await screen.findByRole("link", { name: AUTH_PROVIDERS.google.button });
  expect(link.getAttribute("href")).toBe(mockAuthUrl("google"));
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(link.getAttribute("rel")).toContain("noreferrer");
  expect(link.getAttribute("href")).not.toContain("test-secret");
  expect(attestPagesWithAccount).not.toHaveBeenCalled();
  fireEvent.click(link);
  await waitFor(() => expect(attestPagesWithAccount).toHaveBeenCalledOnce());
  expect(attestPagesWithAccount.mock.calls[0][2].popup).toBeNull();
  finishSealing([]);
  await screen.findByText(/Sealed source.pdf in this browser/);
});

it("reports an unavailable provider and closes its unused preparation tab", async () => {
  const tab = popupTab();
  openAuthPendingTab.mockReturnValue(tab);
  fetch.mockImplementation(async () => ({ ok: true, json: async () =>
    ({ google: false, microsoft: true, amazon: true }) }));
  render(<PdfSealForm />);
  startProvider("google");
  await screen.findByText(/Google sealing is not enabled/);
  expect(tab.authorize).not.toHaveBeenCalled();
  expect(tab.cancel).toHaveBeenCalled();
  expect(beginAccountSignIn).not.toHaveBeenCalled();
});

it("cancels work before signing in and closes the temporary tab", async () => {
  const tab = popupTab();
  openAuthPendingTab.mockReturnValue(tab);
  let rejectParsing;
  sealPdfInBrowser.mockImplementation(() => new Promise((_resolve, reject) => { rejectParsing = reject; }));
  render(<PdfSealForm />);
  startProvider("google");
  await waitFor(() => expect(rejectParsing).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel sealing" }));
  rejectParsing(new Error("Cancelled"));
  await screen.findByText("Account sealing cancelled.");
  expect(tab.cancel).toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("allows mobile account status checks while the prepared provider tab is open", async () => {
  const tab = popupTab();
  openAuthPendingTab.mockReturnValue(tab);
  attestPagesWithAccount.mockImplementation(() => new Promise(() => {}));
  render(<PdfSealForm />);
  startProvider("google");
  await waitFor(() => expect(tab.authorize).toHaveBeenCalledOnce());
  const check = await screen.findByRole("button", { name: "Check sign-in status" });
  fireEvent.click(check);
  await screen.findByText(/QRed has not received a completed sign-in from the provider/);
  expect(checkAccountSignInStatus).toHaveBeenCalledWith("google", expect.objectContaining({
    id: "test-auth-id", secret: "test-secret",
  }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  checkAccountSignInStatus.mockResolvedValueOnce({ status: "failed", error: "Google declined the code exchange" });
  fireEvent.click(check);
  await screen.findByText(/Account sign-in failed: Google declined/);
  checkAccountSignInStatus.mockResolvedValueOnce({ status: "ready" });
  fireEvent.click(check);
  await screen.findByText(/Account sign-in verified by QRed/);
  fireEvent.click(screen.getByRole("button", { name: "Cancel sealing" }));
  expect(tab.cancel).toHaveBeenCalled();
});

it("preserves the provider's error page when a sign-in fails", async () => {
  const tab = popupTab();
  openAuthPendingTab.mockReturnValue(tab);
  attestPagesWithAccount.mockRejectedValue(new Error("Google declined QRed's authorization code exchange"));
  render(<PdfSealForm />);
  startProvider("google");
  await waitFor(() => expect(tab.authorize).toHaveBeenCalledOnce());
  await screen.findByText(/PDF sealing failed: Google declined QRed's authorization code exchange/);
  expect(tab.popup.close).not.toHaveBeenCalled();
});
