import { encodeIdentity, MAX_ATTESTATION_PAGES, pageCommitment } from "./attestation.js";
import { encodeBase64Url } from "./sealFormat.js";
import { authProvider, allowedAuthorizationUrl } from "./authProviders.js";
import trustedAuthorities from "./trustedAuthorities.json";

export const accountSealingAvailable = Object.keys(trustedAuthorities).length > 0;
const SESSION_MILLISECONDS = 10 * 60 * 1000;
const apiFetch = (...args) => fetch(...args);

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(new Error("Account sealing cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, milliseconds);
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
}

function ensurePages(provider, pages) {
  const label = authProvider(provider)?.label;
  if (!label) throw new Error("Unsupported sign-in provider");
  if (!pages.length || pages.length > MAX_ATTESTATION_PAGES) {
    throw new Error(label + " sealing supports documents with 1–100 pages. Use a private key file for larger documents.");
  }
  return label;
}

async function postJson(path, body, fetchImpl, signal, label) {
  const response = await fetchImpl(path, { method: "POST", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || label + " sealing could not be completed");
  return result;
}

// Prepare the document-bound session while the original tab has the foreground.
// No OAuth popup has been opened at this point. This is important on phones:
// opening about:blank before CPU-intensive PDF parsing can suspend the opener.
export async function beginAccountSignIn(provider, pages, { signal, fetchImpl = apiFetch } = {}) {
  const label = ensurePages(provider, pages);
  const salts = pages.map(() => crypto.getRandomValues(new Uint8Array(32)));
  const commitments = await Promise.all(pages.map(async (page, index) =>
    encodeBase64Url(await pageCommitment(page.metadata, page.content, salts[index]))));
  if (signal?.aborted) throw new Error("Account sealing cancelled");
  const startedAt = Date.now();
  const authPath = "/api/auth/" + provider;
  const response = await postJson(authPath + "/start", { commitments }, fetchImpl, signal, label);
  const session = { ...response, provider, salts, commitments, startedAt };
  if (signal?.aborted || !allowedAuthorizationUrl(provider, response.authorize_url)) {
    await finishAccountSignIn(provider, session, { fetchImpl });
    throw new Error(signal?.aborted ? "Account sealing cancelled" : "Unexpected sign-in address");
  }
  return session;
}

// A user-initiated resync is helpful on mobile after the provider tab closes
// and the original tab returns from suspension. The server, not the tab-close
// event or a provider postMessage, remains the only source of sign-in truth.
export async function checkAccountSignInStatus(provider, session, { fetchImpl = apiFetch, signal } = {}) {
  const label = authProvider(provider)?.label;
  if (!label || session?.provider !== provider || !session.id || !session.secret) {
    throw new Error("No matching account sign-in session. Prepare the PDF again.");
  }
  return postJson("/api/auth/" + provider + "/status",
    { id: session.id, secret: session.secret }, fetchImpl, signal, label);
}

export async function finishAccountSignIn(provider, session, { fetchImpl = apiFetch } = {}) {
  if (!session?.id || !session?.secret) return;
  // Do not use the cancelled request's signal: clearing cookies must still work
  // after a cancellation or failed photo/PDF render.
  await fetchImpl("/api/auth/" + provider + "/finish", {
    method: "POST", credentials: "same-origin", keepalive: true,
    signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: session.id, secret: session.secret }),
  }).catch(() => {});
}

export async function attestPagesWithAccount(provider, pages, { popup, signal, onStatus = () => {},
  onIdentity = () => {}, fetchImpl = apiFetch, trusted = trustedAuthorities, preparedSession = null } = {}) {
  const label = ensurePages(provider, pages);
  if (!popup) throw new Error("Allow the " + label + " sign-in window, then try again.");
  const authPath = "/api/auth/" + provider;
  let session = preparedSession;
  const post = (path, body) => postJson(path, body, fetchImpl, signal, label);
  try {
    if (session) {
      if (session.provider !== provider || !Array.isArray(session.salts) ||
          session.salts.length !== pages.length || !Array.isArray(session.commitments) ||
          session.commitments.length !== pages.length ||
          !allowedAuthorizationUrl(provider, session.authorize_url)) {
        throw new Error("The prepared account sign-in does not match this document.");
      }
      onStatus("Complete " + label + " sign-in, then return to QRed to finish sealing.");
    } else {
      // Compatibility with callers that have not opted into the two-step mobile
      // flow. The form itself uses beginAccountSignIn before opening a new tab.
      session = await beginAccountSignIn(provider, pages, { signal, fetchImpl });
      onStatus("Opening " + label + " sign-in. Your PDF and its text stay on this device.");
      popup.location.href = session.authorize_url;
    }
    const { salts, commitments } = session;
    const credentials = { id: session.id, secret: session.secret };
    const deadline = session.startedAt + SESSION_MILLISECONDS;
    let identity, timestamp;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Account sealing cancelled");
      const status = await post(authPath + "/status", credentials);
      if (status.status === "ready") { identity = status.identity; timestamp = status.timestamp; break; }
      if (status.status === "failed") throw new Error(status.error || label + " sign-in failed");
      // The provider may sever window.opener. Cookies are still shared and
      // polling resumes when mobile users return to the QRed tab.
      await delay(1500, signal);
    }
    if (!identity) throw new Error(label + " sign-in expired. Prepare the document again and retry.");
    if (identity.provider !== provider) throw new Error("Sign-in provider changed during authentication");
    encodeIdentity(identity);
    onIdentity(identity);
    onStatus(label + " sign-in completed. Obtaining document attestations…");
    const receipts = [];
    for (let index = 0; index < pages.length; index += 1) {
      const receipt = await post("/api/attest/" + provider, { ...credentials, commitments, index });
      if (!trusted[receipt.key_id]) throw new Error("This QRed authority key is not trusted by this copy of the app. Reload QRed and try again.");
      if (JSON.stringify(receipt.identity) !== JSON.stringify(identity) ||
          receipt.timestamp !== timestamp) throw new Error("Inconsistent document attestation");
      receipts.push({ ...receipt, public_key: trusted[receipt.key_id], salt: salts[index] });
    }
    return receipts;
  } finally {
    try { popup.close(); } catch { /* The provider may isolate the popup. */ }
    if (session) await finishAccountSignIn(provider, session, { fetchImpl });
  }
}
