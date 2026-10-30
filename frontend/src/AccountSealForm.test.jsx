/* @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { beginAccountSignIn, finishAccountSignIn, checkAccountSignInStatus, attestPagesWithAccount } from "./accountSealing.js";
import { navigateToProvider, readPendingAuth, clearPendingAuth } from "./sameTabAuth.js";
import { AUTH_PROVIDERS } from "./authProviders.js";

vi.mock("./pdfClientSeal.js", () => ({ sealPdfInBrowser: vi.fn() }));
vi.mock("./accountSealing.js", () => ({
  accountSealingAvailable: true,
  beginAccountSignIn: vi.fn(),
  finishAccountSignIn: vi.fn(),
  checkAccountSignInStatus: vi.fn(),
  attestPagesWithAccount: vi.fn(),
}));
vi.mock("./sameTabAuth.js", () => ({
  readPendingAuth: vi.fn(),
  navigateToProvider: vi.fn(),
  clearPendingAuth: vi.fn(),
}));
const onePdf = () => new File(["%PDF-1.4"], "example.pdf", { type: "application/pdf" });
const providerUrl = {
  google: "https://accounts.google.com/o/oauth2/v2/auth",
  microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  amazon: "https://www.amazon.com/ap/oa",
};
const session = provider => ({
  provider, id: "a".repeat(43), secret: "b".repeat(43), authorize_url: providerUrl[provider],
  startedAt: Date.now(), salts: [new Uint8Array(32)], commitments: ["c".repeat(43)],
  pageScalingStrategy: "automatic",
});
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  readPendingAuth.mockReset().mockReturnValue(null);
  navigateToProvider.mockReset();
  clearPendingAuth.mockReset();
  finishAccountSignIn.mockReset().mockResolvedValue();
  checkAccountSignInStatus.mockReset().mockResolvedValue({ status: "ready" });
  attestPagesWithAccount.mockReset().mockResolvedValue([{ signature: "test" }]);
  beginAccountSignIn.mockReset().mockImplementation(async provider => session(provider));
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, json: async () => ({ google: true, microsoft: true, amazon: true }),
  })));
  sealPdfInBrowser.mockReset().mockImplementation(async ({ attestPages }) => {
    if (attestPages) await attestPages([{ content: "confidential", metadata: { pdf: true } }]);
    return { blob: new Blob(["sealed"]), sealResult: {} };
  });
  URL.createObjectURL = vi.fn(() => "blob:sealed");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const upload = () => fireEvent.change(screen.getByLabelText("Open PDF"), {
  target: { files: [onePdf()] },
});

it("starts with no provider preselected or third-party scripts", () => {
  render(<PdfSealForm />);
  expect(screen.getByLabelText("Page layout").value).toBe("automatic");
  expect(readPendingAuth).toHaveBeenCalled();
  expect(screen.queryByLabelText("Private Key")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(navigateToProvider).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Private key (offline)" })).toBeTruthy();
});

it.each(Object.keys(AUTH_PROVIDERS))("%s uses the current tab with no QRed popup", async provider => {
  const windowOpen = vi.spyOn(window, "open");
  render(<PdfSealForm />);
  upload();
  fireEvent.click(screen.getByRole("button", { name: AUTH_PROVIDERS[provider].button }));
  await waitFor(() => expect(navigateToProvider).toHaveBeenCalledOnce());
  expect(beginAccountSignIn).toHaveBeenCalledWith(provider, expect.any(Array),
    expect.objectContaining({ mode: "same-tab", signal: expect.any(AbortSignal) }));
  expect(navigateToProvider).toHaveBeenCalledWith(expect.objectContaining({ provider }), "automatic");
  expect(windowOpen).not.toHaveBeenCalled();
  expect(finishAccountSignIn).not.toHaveBeenCalled();
});

it("never stamps a substituted document after returning from login", async () => {
  const pending = session("google");
  readPendingAuth.mockReturnValue(pending);
  render(<PdfSealForm />);
  upload();
  await screen.findByText(/does not match the authenticated document/);
  expect(attestPagesWithAccount).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(clearPendingAuth).not.toHaveBeenCalled();
});

it("checks authentication status and reports failures without stamping", async () => {
  readPendingAuth.mockReturnValue(session("amazon"));
  checkAccountSignInStatus.mockResolvedValue({ status: "failed", error: "provider rejected sign-in" });
  render(<PdfSealForm />);
  upload();
  await screen.findByText(/Sign-in failed: provider rejected sign-in/);
  expect(sealPdfInBrowser).not.toHaveBeenCalled();
  expect(clearPendingAuth).toHaveBeenCalled();
});

it("can cancel a short-lived session without retaining any document", async () => {
  readPendingAuth.mockReturnValue(session("microsoft"));
  render(<PdfSealForm />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() => expect(finishAccountSignIn).toHaveBeenCalled());
  expect(clearPendingAuth).toHaveBeenCalled();
});
