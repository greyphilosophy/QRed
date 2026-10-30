/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { sealPdfInBrowser, prepareAccountPdfSeal } from "./pdfClientSeal.js";
import { beginAccountSignIn, finishAccountSignIn, checkAccountSignInStatus, attestPagesWithAccount } from "./accountSealing.js";
import { AUTH_PROVIDERS } from "./authProviders.js";

vi.mock("./pdfClientSeal.js", () => ({
  sealPdfInBrowser: vi.fn(),
  prepareAccountPdfSeal: vi.fn(),
}));
vi.mock("./accountSealing.js", () => ({
  accountSealingAvailable: true,
  beginAccountSignIn: vi.fn(), finishAccountSignIn: vi.fn(),
  checkAccountSignInStatus: vi.fn(), attestPagesWithAccount: vi.fn(),
}));

const urls = {
  google: "https://accounts.google.com/o/oauth2/v2/auth?state=opaque",
  microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=opaque",
  amazon: "https://www.amazon.com/ap/oa?state=opaque",
};
const session = provider => ({
  id: "server-session-" + provider, secret: "private-session-secret",
  provider, authorize_url: urls[provider], salts: [], commitments: [], startedAt: Date.now(),
});
const pages = [{ content: "private page text", metadata: { pdf: true, page_number: 1, page_count: 1 } }];
const upload = () => fireEvent.change(screen.getByLabelText("Open PDF"), {
  target: { files: [new File(["pdf"], "source.pdf", { type: "application/pdf" })] },
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, json: async () => ({ google: true, microsoft: true, amazon: true }),
  })));
  beginAccountSignIn.mockReset().mockImplementation(async provider => session(provider));
  finishAccountSignIn.mockReset().mockResolvedValue();
  checkAccountSignInStatus.mockReset().mockResolvedValue({ status: "pending" });
  attestPagesWithAccount.mockReset().mockResolvedValue([{}]);
  sealPdfInBrowser.mockReset().mockResolvedValue({ blob: new Blob(["sealed"]), sealResult: {} });
  prepareAccountPdfSeal.mockReset().mockImplementation(async () => ({
    pages,
    finish: vi.fn().mockResolvedValue({
      blob: new Blob(["sealed"]), sealResult: {}, flattenedFieldCount: 1, footerPages: [2],
    }),
  }));
  URL.createObjectURL = vi.fn(() => "blob:sealed");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("shows only essential pre-sign-in disclosures and keeps technical explanations collapsed", async () => {
  render(<PdfSealForm />);
  expect(screen.getByText(/Your PDF stays on this device\. Account sign-in sends page fingerprints/)).toBeTruthy();
  expect(screen.getByText(/Account seals disclose your provider profile name and email/)).toBeTruthy();
  const details = screen.getByText("About seals, privacy and page layouts").closest("details");
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("These commitments are unsalted");
  expect(details.textContent).toContain("does not establish legal identity");
  expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign in with Microsoft" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Login with Amazon" })).toBeTruthy();
  expect(screen.queryByText(/QRed prepares authentication securely/)).toBeNull();
  expect(screen.getByText(/Uses a watermark when readable, otherwise a footer/)).toBeTruthy();
  expect(screen.queryByText(/sign-in provider directly/)).toBeNull();
});

it("does not contact an account service or prepare account signing in offline mode", async () => {
  render(<PdfSealForm />);
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Private Key")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Private key (offline)" }));
  upload();
  expect(screen.getByLabelText("Private Key")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stamp and save PDF" }).disabled).toBe(false);
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
  expect(prepareAccountPdfSeal).not.toHaveBeenCalled();
});

it("prepares provider authorization URLs after the PDF and layout, without opening tabs", async () => {
  const open = vi.spyOn(window, "open");
  const { container } = render(<PdfSealForm />);
  expect(screen.getByLabelText("Page layout").value).toBe("automatic");
  expect(screen.queryByLabelText("Private Key")).toBeNull();
  const choices = container.querySelectorAll(".sealing-method-grid button");
  expect(choices).toHaveLength(4);
  expect(choices[3].textContent.trim()).toBe("Private key (offline)");
  upload();
  const google = await screen.findByRole("link", { name: AUTH_PROVIDERS.google.button });
  const microsoft = screen.getByRole("link", { name: AUTH_PROVIDERS.microsoft.button });
  const amazon = screen.getByRole("link", { name: AUTH_PROVIDERS.amazon.button });
  for (const [provider, link] of [["google",google],["microsoft",microsoft],["amazon",amazon]]) {
    expect(link.getAttribute("href")).toBe(urls[provider]);
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("href")).not.toContain("private-session-secret");
    expect(beginAccountSignIn).toHaveBeenCalledWith(provider, pages, expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  }
  expect(prepareAccountPdfSeal).toHaveBeenCalledOnce();
  expect(sealPdfInBrowser).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it.each(Object.entries(AUTH_PROVIDERS))("%s opens the prepared provider URL with one native click and seals in memory", async (provider, details) => {
  const open = vi.spyOn(window, "open");
  render(<PdfSealForm />);
  upload();
  const link = await screen.findByRole("link", { name: details.button });
  fireEvent.click(link);
  await screen.findByText(/Sealed source.pdf in this browser/);
  expect(attestPagesWithAccount).toHaveBeenCalledWith(provider, pages,
    expect.objectContaining({
      preparedSession: expect.objectContaining({ provider }), popup: null,
      signal: expect.any(AbortSignal),
    }));
  expect(sealPdfInBrowser).not.toHaveBeenCalled(); // PDF was already prepared locally.
  expect(open).not.toHaveBeenCalled(); // Native anchor opens one direct provider tab.
  expect(screen.getByText(/Sealed source.pdf in this browser/).textContent)
    .toContain("source.qred-sealed.pdf");
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect(finishAccountSignIn).toHaveBeenCalled();
});

it("does not show a link for an unconfigured provider and permits offline sealing", async () => {
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ google: true, microsoft: false, amazon: false }) });
  render(<PdfSealForm />);
  upload();
  await screen.findByRole("link", { name: AUTH_PROVIDERS.google.button });
  expect(screen.queryByRole("link", { name: AUTH_PROVIDERS.amazon.button })).toBeNull();
  expect(screen.getByRole("button", { name: AUTH_PROVIDERS.amazon.button }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Private key (offline)" }));
  expect(screen.getByLabelText("Private Key")).toBeTruthy();
});

it("rejects an expired link without opening a popup or stamping", async () => {
  beginAccountSignIn.mockImplementation(async provider => ({ ...session(provider),
    startedAt: Date.now() - 600000 }));
  render(<PdfSealForm />);
  upload();
  await waitFor(() => expect(prepareAccountPdfSeal).toHaveBeenCalledOnce());
  expect(screen.queryByRole("link", { name: AUTH_PROVIDERS.google.button })).toBeNull();
  expect(attestPagesWithAccount).not.toHaveBeenCalled();
});

it("does not start an additional login while one is already processing", async () => {
  let finishPolling;
  attestPagesWithAccount.mockImplementation(() => new Promise(resolve => { finishPolling = resolve; }));
  render(<PdfSealForm />);
  upload();
  const link = await screen.findByRole("link", { name: AUTH_PROVIDERS.google.button });
  fireEvent.click(link);
  await waitFor(() => expect(attestPagesWithAccount).toHaveBeenCalledOnce());
  expect(screen.queryByRole("link", { name: AUTH_PROVIDERS.amazon.button })).toBeNull();
  finishPolling([{}]);
  await screen.findByText(/Sealed source.pdf in this browser/);
});

it("keeps private PDF page content out of the provider link and all third-party network requests", async () => {
  render(<PdfSealForm />);
  upload();
  const link = await screen.findByRole("link", { name: AUTH_PROVIDERS.amazon.button });
  expect(link.href).not.toContain("private page text");
  expect(fetch).toHaveBeenCalledWith("/api/auth/config", expect.any(Object));
  expect(fetch).toHaveBeenCalledTimes(1); // Only QRed configuration; commitments are handled by mock.
});
