/* @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { beginAccountSignIn, completeAccountSignIn, attestPagesWithAccount, finishAccountSignIn } from "./accountSealing.js";
import { microsoftPopup, amazonPopup } from "./providerSdkAuth.js";

vi.mock("./pdfClientSeal.js", () => ({ sealPdfInBrowser: vi.fn() }));
vi.mock("./accountSealing.js", () => ({
  accountSealingAvailable: true,
  beginAccountSignIn: vi.fn(),
  completeAccountSignIn: vi.fn(),
  attestPagesWithAccount: vi.fn(),
  finishAccountSignIn: vi.fn(),
  checkAccountSignInStatus: vi.fn(),
}));
vi.mock("./providerSdkAuth.js", () => ({
  createSdkNonce: () => "N".repeat(43),
  loadMicrosoftSdk: vi.fn().mockResolvedValue(),
  loadAmazonSdk: vi.fn().mockResolvedValue(),
  prepareMicrosoft: vi.fn().mockResolvedValue({ loginPopup: vi.fn() }),
  prepareAmazon: vi.fn().mockResolvedValue(),
  microsoftPopup: vi.fn(),
  amazonPopup: vi.fn(),
}));
vi.mock("./ProviderSdkButtons.jsx", () => ({
  ProviderSdkButtons: ({ clientIds, onGoogleClick, onGoogleCredential, onMicrosoftClick, onAmazonClick, busy }) =>
    <div data-testid="provider-buttons">
      <button type="button" disabled={busy || !clientIds?.google} onClick={() => {
        onGoogleClick();
        onGoogleCredential({ id_token: "google-jwt" });
      }}>Sign in with Google</button>
      <button type="button" disabled={busy || !clientIds?.microsoft} onClick={onMicrosoftClick}>Sign in with Microsoft</button>
      <button type="button" disabled={busy || !clientIds?.amazon} onClick={onAmazonClick}>Login with Amazon</button>
    </div>,
}));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async request => ({
    ok: true,
    json: async () => request === "/api/auth/client-config"
      ? { google: "google-client", microsoft: "microsoft-client", amazon: "amazon-client" }
      : { google: true, microsoft: true, amazon: true },
  })));
  beginAccountSignIn.mockReset().mockImplementation(async (provider, pages, { nonce }) => ({
    id: "test-document-session", secret: "hidden", provider,
    nonce, startedAt: Date.now(),
    salts: [], commitments: [],
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
  }));
  completeAccountSignIn.mockReset().mockResolvedValue({ status: "ready" });
  attestPagesWithAccount.mockReset().mockResolvedValue([]);
  finishAccountSignIn.mockReset().mockResolvedValue();
  microsoftPopup.mockReset().mockResolvedValue({ id_token: "microsoft-jwt" });
  amazonPopup.mockReset().mockResolvedValue({ access_token: "amazon-token", state: "N".repeat(43) });
  sealPdfInBrowser.mockReset().mockImplementation(async options => {
    if (options.attestPages) await options.attestPages([]);
    return { blob: new Blob(["%PDF-1.4"]), sealResult: { total_seals: 1 } };
  });
  URL.createObjectURL = vi.fn(() => "blob:qred");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function selectPdf() {
  fireEvent.change(screen.getByLabelText("Open PDF"), {
    target: { files: [new File(["%PDF-1.4"], "example.pdf", { type: "application/pdf" })] },
  });
}

it("does not load account services during the private-key offline workflow", () => {
  render(<PdfSealForm />);
  fireEvent.click(screen.getByRole("button", { name: "Private key (offline)" }));
  selectPdf();
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Generate key pair" })).toBeTruthy();
  expect(screen.getByLabelText("Private Key")).toBeTruthy();
});

it("shows official provider choices after PDF and layout, with offline last", async () => {
  const { container } = render(<PdfSealForm />);
  expect(screen.getByLabelText("Page layout").value).toBe("automatic");
  expect(screen.queryByLabelText("Private Key")).toBeNull();
  expect(screen.getByRole("button", { name: "Private key (offline)" }).getAttribute("aria-pressed")).toBe("false");
  expect(container.querySelector(".sdk-signin-grid")).toBeNull(); // Stub retains the same entry position.
  selectPdf();
  await waitFor(() => expect(screen.getByRole("button", { name: "Sign in with Google" }).disabled).toBe(false));
  const google = screen.getByRole("button", { name: "Sign in with Google" });
  const offline = screen.getByRole("button", { name: "Private key (offline)" });
  expect(Boolean(google.compareDocumentPosition(offline) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
});

it.each([
  ["google", "Sign in with Google", { id_token: "google-jwt" }],
  ["microsoft", "Sign in with Microsoft", { id_token: "microsoft-jwt" }],
  ["amazon", "Login with Amazon", { access_token: "amazon-token", state: "N".repeat(43) }],
])("completes %s sealing with a single provider click and no QRed preparation tab", async (provider, name, credential) => {
  const open = vi.spyOn(window, "open");
  render(<PdfSealForm />);
  selectPdf();
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await screen.findByText(/Sealed example.pdf in this browser/);
  expect(beginAccountSignIn).toHaveBeenCalledWith(provider, [], expect.objectContaining({ nonce: "N".repeat(43) }));
  expect(completeAccountSignIn).toHaveBeenCalledWith(provider, expect.objectContaining({ provider }),
    credential, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(attestPagesWithAccount).toHaveBeenCalledWith(provider, [], expect.objectContaining({
    popup: null, preparedSession: expect.objectContaining({ provider }),
  }));
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole("link", { name: /Authenticate with/ })).toBeNull();
});

it("cancels a pending login without saving a PDF", async () => {
  const waiting = new Promise(() => {});
  microsoftPopup.mockReturnValue(waiting);
  render(<PdfSealForm />);
  selectPdf();
  const button = await screen.findByRole("button", { name: "Sign in with Microsoft" });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(beginAccountSignIn).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Cancel sealing" }));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
