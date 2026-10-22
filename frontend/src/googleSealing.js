import { MAX_ATTESTATION_PAGES, pageCommitment } from "./attestation.js";
import { encodeBase64Url } from "./sealFormat.js";
import trustedAuthorities from "./trustedAuthorities.json";

export const googleSealingAvailable = Object.keys(trustedAuthorities).length > 0;

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(new Error("Google sealing cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, milliseconds);
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
}

export async function attestPagesWithGoogle(pages, { popup, name = "", signal, onStatus = () => {},
  onIdentity = () => {}, fetchImpl = (...args) => fetch(...args), trusted = trustedAuthorities } = {}) {
  if (!pages.length || pages.length > MAX_ATTESTATION_PAGES) throw new Error("Google sealing supports documents with 1–100 pages. Use a private key file for larger documents.");
  if (!popup) throw new Error("Allow the Google sign-in window, then try again.");
  let session;
  const post = async (path, body) => {
    const response = await fetchImpl(path, { method: "POST", credentials: "same-origin", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Google sealing could not be completed");
    return result;
  };
  try {
    const salts = pages.map(() => crypto.getRandomValues(new Uint8Array(32)));
    const commitments = await Promise.all(pages.map(async (page, index) =>
      encodeBase64Url(await pageCommitment(page.metadata, page.content, salts[index]))));
    onStatus("Opening Google sign-in. Your PDF and its text stay on this device.");
    session = await post("/api/auth/google/start", { commitments, name });
    const authorization = new URL(session.authorize_url);
    if (authorization.origin !== "https://accounts.google.com" || authorization.pathname !== "/o/oauth2/v2/auth") throw new Error("Unexpected Google sign-in address");
    popup.location.href = authorization.href;
    const credentials = { id: session.id, secret: session.secret };
    const deadline = Date.now() + 10 * 60 * 1000;
    let identity;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Google sealing cancelled");
      const status = await post("/api/auth/google/status", credentials);
      if (status.status === "ready") { identity = status.identity; break; }
      if (status.status === "failed") throw new Error(status.error || "Google sign-in failed");
      // Browser opener isolation can make a live Google window appear closed.
      // Completion comes from the server; the form's Cancel button aborts polling.
      await delay(1500, signal);
    }
    if (!identity) throw new Error("Google sign-in expired. Please try again.");
    onIdentity(identity);
    onStatus("Google sign-in completed. Obtaining document attestations…");
    const receipts = [];
    // One native signature per request keeps work bounded on the Workers Free tier.
    for (let index = 0; index < pages.length; index += 1) {
      const receipt = await post("/api/attest/google", { ...credentials, index });
      if (!trusted[receipt.key_id]) throw new Error("This QRed authority key is not trusted by this copy of the app. Reload QRed and try again.");
      if (JSON.stringify(receipt.identity) !== JSON.stringify(identity) ||
          (index && receipt.timestamp !== receipts[0].timestamp)) throw new Error("Inconsistent document attestation");
      receipts.push({ ...receipt, public_key: trusted[receipt.key_id], salt: salts[index] });
    }
    return receipts;
  } finally {
    try { popup.close(); } catch { /* The provider may isolate the popup. */ }
    if (session?.id && session?.secret) {
      // Remove transient identity records even when a later step fails. No tokens
      // are written to localStorage/sessionStorage or placed in navigation URLs.
      await fetchImpl("/api/auth/google/finish", { method: "POST", credentials: "same-origin", keepalive: true,
        signal: AbortSignal.timeout(5000), headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: session.id, secret: session.secret }) }).catch(() => {});
    }
  }
}
