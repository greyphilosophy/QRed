/* @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ExactPdfExperiment from "./ExactPdfExperiment.jsx";
import { sealExactPdf, verifyExactPdf } from "./exactRender/exactPdf.js";
import * as keys from "./signingKeys.js";

vi.mock("./exactRender/exactPdf.js", () => ({ sealExactPdf: vi.fn(), verifyExactPdf: vi.fn() }));
const PRIVATE_KEY = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const PUBLIC_KEY = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
const verified = (overrides = {}) => ({
  profile: "test-only-pinned-profile", scope: "Rendered pixels only.", completeExactRenderedDocument: true,
  pages: [{ pageNumber: 1, signatureStatus: "VALID", exactRender: { status: "exact-render-match" } }], ...overrides,
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const button = name => screen.getByRole("button", { name, exact: true });
const status = () => screen.getByRole("status");
const publicField = () => screen.getByLabelText("Exact-mode public key", { exact: true });
const privateField = () => screen.getByLabelText("Exact-mode private key (for sealing only)", { exact: true });
function choosePdf(name = "synthetic.pdf") {
  fireEvent.change(screen.getByLabelText("Open exact-mode PDF"), {
    target: { files: [new File(["%PDF-generated"], name, { type: "application/pdf" })] },
  });
}
function prepareVerify() { choosePdf(); fireEvent.change(publicField(), { target: { value: PUBLIC_KEY } }); }
async function prepareSeal() {
  choosePdf();
  fireEvent.change(privateField(), { target: { value: PRIVATE_KEY } });
  await waitFor(() => expect(publicField().value).toBe(PUBLIC_KEY));
  await waitFor(() => expect(button("Seal exact appearance and save PDF").disabled).toBe(false));
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  sealExactPdf.mockReset().mockResolvedValue({ blob: new Blob(["%PDF-sealed"], { type: "application/pdf" }), pages: [{ pageNumber: 1 }], profile: "test-only-pinned-profile", scope: "Rendered pixels only." });
  verifyExactPdf.mockReset().mockResolvedValue(verified());
  URL.createObjectURL = vi.fn(() => "blob:exact-download");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("separate experimental exact PDF tool", () => {
  it("states narrow browser-rendered scope and does not request a reference or store documents", () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    render(<ExactPdfExperiment onClose={() => {}} />);
    expect(screen.getByTestId("exact-scope").textContent).toContain("unchanged PDF bytes");
    expect(screen.getByTestId("exact-scope").textContent).toContain("Native canvas rendering can differ");
    expect(screen.getByText(/No original document or source reference is required/)).toBeTruthy();
    expect(screen.getAllByLabelText(/Open exact-mode PDF/)).toHaveLength(1);
    expect(storage).not.toHaveBeenCalled();
  });

  it("uses existing private-key derivation and seals a PDF for download", async () => {
    render(<ExactPdfExperiment />);
    await prepareSeal();
    fireEvent.click(button("Seal exact appearance and save PDF"));
    await screen.findByText(/Exact appearance sealed and PDF download started/);
    expect(sealExactPdf).toHaveBeenCalledTimes(1);
    expect(sealExactPdf.mock.calls[0][0]).toMatchObject({ privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("exact-document-result")).toBeNull();
  });

  it("verifies from sealed PDF and public key only, with separate signature and appearance", async () => {
    render(<ExactPdfExperiment />); prepareVerify();
    fireEvent.click(button("Verify exact rendered appearance"));
    await screen.findByText("Signature: Authenticated");
    expect(screen.getByText("Appearance: Exact rendered appearance matches")).toBeTruthy();
    expect(screen.getByTestId("exact-document-result").className).toBe("exact-match");
    const options = verifyExactPdf.mock.calls[0][0];
    expect(Object.keys(options).sort()).toEqual(["file", "onProgress", "publicKey", "signal"]);
    expect(privateField().value).toBe("");
  });

  it.each([
    ["authenticated appearance mismatch", "VALID", "inconclusive"],
    ["invalid signature", "INVALID", "exact-render-match"],
    ["unsupported profile", "UNSUPPORTED", "inconclusive"],
    ["missing record", "INCOMPLETE", "inconclusive"],
    ["unknown appearance result", "VALID", "future-status"],
  ])("never colors %s green, even with an inconsistent document flag", async (_name, signatureStatus, appearance) => {
    verifyExactPdf.mockResolvedValue(verified({ pages: [{ pageNumber: 1, signatureStatus, exactRender: { status: appearance, reason: "Cannot establish an exact match." } }] }));
    const { container } = render(<ExactPdfExperiment />); prepareVerify();
    fireEvent.click(button("Verify exact rendered appearance"));
    await screen.findByText("Cannot establish an exact match.");
    expect(container.querySelectorAll(".exact-match")).toHaveLength(0);
    expect(screen.getByTestId("exact-document-result").textContent).toContain("not established");
  });

  it("does not declare collection completeness from a page match", async () => {
    verifyExactPdf.mockResolvedValue(verified({ completeExactRenderedDocument: false }));
    render(<ExactPdfExperiment />); prepareVerify();
    fireEvent.click(button("Verify exact rendered appearance"));
    await screen.findByText("Appearance: Exact rendered appearance matches");
    expect(screen.getByTestId("exact-document-result").className).toBe("exact-inconclusive");
  });

  it("refuses photos and oversized PDFs before calling the engine", async () => {
    render(<ExactPdfExperiment />);
    fireEvent.change(screen.getByLabelText("Open exact-mode PDF"), { target: { files: [new File(["png"], "photo.png", { type: "image/png" })] } });
    expect(status().textContent).toContain("Choose a digital PDF");
    const large = new File(["%PDF"], "large.pdf", { type: "application/pdf" });
    Object.defineProperty(large, "size", { value: 32 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText("Open exact-mode PDF"), { target: { files: [large] } });
    expect(status().textContent).toContain("no larger than 32 MiB");
    fireEvent.click(button("Verify exact rendered appearance"));
    expect(status().textContent).toContain("Choose a digital PDF first");
    expect(verifyExactPdf).not.toHaveBeenCalled();
  });

  it("rejects a mismatched signing key before sealing", async () => {
    render(<ExactPdfExperiment />); await prepareSeal();
    const different = await keys.generateSigningKeyPair();
    fireEvent.change(publicField(), { target: { value: different.publicKey } });
    fireEvent.click(button("Seal exact appearance and save PDF"));
    await waitFor(() => expect(status().textContent).toContain("public key does not match"));
    expect(sealExactPdf).not.toHaveBeenCalled();
  });

  it("reports unsupported inputs as failed without leaving an old match", async () => {
    render(<ExactPdfExperiment />); prepareVerify();
    fireEvent.click(button("Verify exact rendered appearance"));
    await screen.findByText("Signature: Authenticated");
    choosePdf("unsupported.pdf");
    expect(screen.queryByTestId("exact-document-result")).toBeNull();
    verifyExactPdf.mockRejectedValue(new Error("Unsupported PDF geometry"));
    fireEvent.click(button("Verify exact rendered appearance"));
    await waitFor(() => expect(status().textContent).toContain("Experimental verification failed: Unsupported PDF geometry"));
    expect(screen.queryByTestId("exact-document-result")).toBeNull();
  });

  it("cancels work and discards late progress/results", async () => {
    const pending = deferred(); verifyExactPdf.mockReturnValue(pending.promise);
    render(<ExactPdfExperiment />); prepareVerify();
    fireEvent.click(button("Verify exact rendered appearance"));
    const options = verifyExactPdf.mock.calls[0][0];
    act(() => options.onProgress({ stage: "Rendering", pageNumber: 1, pageCount: 2 }));
    expect(status().textContent).toBe("Rendering · Page 1 of 2");
    fireEvent.click(button("Cancel exact operation"));
    expect(options.signal.aborted).toBe(true);
    await act(async () => { options.onProgress({ stage: "Late result" }); pending.resolve(verified()); });
    expect(status().textContent).toBe("Experimental operation cancelled.");
    expect(screen.queryByTestId("exact-document-result")).toBeNull();
  });

  it.each(["file", "key"])("changing the %s invalidates a running check", async change => {
    const pending = deferred(); verifyExactPdf.mockReturnValueOnce(pending.promise);
    render(<ExactPdfExperiment />); prepareVerify();
    fireEvent.click(button("Verify exact rendered appearance"));
    const old = verifyExactPdf.mock.calls[0][0];
    if (change === "file") choosePdf("new.pdf");
    else fireEvent.change(publicField(), { target: { value: PUBLIC_KEY + "=" } });
    expect(old.signal.aborted).toBe(true);
    fireEvent.click(button("Verify exact rendered appearance"));
    await screen.findByText("Signature: Authenticated");
    await act(async () => pending.resolve(verified({ completeExactRenderedDocument: false })));
    expect(screen.getByTestId("exact-document-result").textContent).toBe("Complete exact rendered document match");
  });

  it("clears documents, keys, results and outstanding download URLs", async () => {
    render(<ExactPdfExperiment />); await prepareSeal();
    fireEvent.click(button("Seal exact appearance and save PDF"));
    await screen.findByText(/Exact appearance sealed and PDF download started/);
    fireEvent.click(button("Clear experimental documents and keys"));
    expect(privateField().value).toBe(""); expect(publicField().value).toBe("");
    expect(screen.queryByText(/Selected PDF:/)).toBeNull();
    expect(screen.queryByText(/Rendering profile:/)).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:exact-download");
    expect(status().textContent).toContain("Experimental check cleared");
  });

  it("pagehide clears the tool and prevents late sealing downloads", async () => {
    const pending = deferred(); sealExactPdf.mockReturnValue(pending.promise);
    render(<ExactPdfExperiment />); await prepareSeal();
    fireEvent.click(button("Seal exact appearance and save PDF"));
    await waitFor(() => expect(sealExactPdf).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(sealExactPdf.mock.calls[0][0].signal.aborted).toBe(true);
    await act(async () => pending.resolve({ blob: new Blob(["PDF"]), pages: [] }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(privateField().value).toBe(""); expect(publicField().value).toBe("");
  });

  it("unmount aborts a check and repeated clicks start only one operation", async () => {
    const pending = deferred(); verifyExactPdf.mockReturnValue(pending.promise);
    const { unmount } = render(<ExactPdfExperiment />); prepareVerify();
    const run = button("Verify exact rendered appearance");
    fireEvent.click(run); fireEvent.click(run);
    expect(verifyExactPdf).toHaveBeenCalledTimes(1);
    unmount();
    expect(verifyExactPdf.mock.calls[0][0].signal.aborted).toBe(true);
    await act(async () => pending.resolve(verified()));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("late key generation cannot repopulate cleared keys", async () => {
    const pending = deferred(); vi.spyOn(keys, "generateSigningKeyPair").mockReturnValue(pending.promise);
    render(<ExactPdfExperiment />);
    fireEvent.click(button("Generate experimental key pair"));
    fireEvent.click(button("Clear experimental documents and keys"));
    await act(async () => pending.resolve({ privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY }));
    expect(privateField().value).toBe(""); expect(publicField().value).toBe("");
    expect(status().textContent).toContain("Experimental check cleared");
  });

  it("late key-file reads cannot overwrite a newly entered public key", async () => {
    const pending = deferred(); vi.spyOn(keys, "readSigningKeyFile").mockReturnValue(pending.promise);
    render(<ExactPdfExperiment />);
    fireEvent.change(screen.getByLabelText("Open exact-mode public key file"), { target: { files: [new File([PUBLIC_KEY], "key.txt")] } });
    fireEvent.change(publicField(), { target: { value: "newer key" } });
    await act(async () => pending.resolve(PUBLIC_KEY));
    expect(publicField().value).toBe("newer key");
  });
});
