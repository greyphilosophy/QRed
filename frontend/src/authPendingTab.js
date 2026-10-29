import { allowedAuthorizationUrl } from "./authProviders.js";

const PREFIX = "qred-auth-pending-";
const DEFAULT_READY_TIMEOUT_MS = 12000;

// Open a same-origin preparation tab in the user's click handler, while
// preserving an origin-scoped channel after the browser severs window.opener.
// Never rely on popup.closed or popup.location after detaching the opener:
// Chrome can invalidate that WindowProxy even when the tab remains visible.
export function openAuthPendingTab({
  openWindow = (url, target) => window.open(url, target),
  BroadcastChannelCtor = globalThis.BroadcastChannel,
  randomBytes = bytes => crypto.getRandomValues(bytes),
} = {}) {
  if (typeof BroadcastChannelCtor !== "function") return null;
  const token = Array.from(randomBytes(new Uint8Array(16)),
    value => value.toString(16).padStart(2, "0")).join("");
  const channel = new BroadcastChannelCtor(PREFIX + token);
  let resolved = false;
  let resolveReady;
  let disposed = false;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  channel.onmessage = event => {
    if (!disposed && !resolved && event.data?.type === "ready") {
      resolved = true;
      resolveReady(true);
    }
  };
  let popup;
  try {
    popup = openWindow("/auth-pending.html#" + token, "_blank");
    if (!popup) {
      channel.close();
      return null;
    }
    // Isolate the authentication tab from the document and keys. The actual
    // authorization handoff uses BroadcastChannel, not a WindowProxy handle.
    try { popup.opener = null; } catch { /* WindowProxy may already be isolated. */ }
  } catch {
    channel.close();
    try { popup?.close(); } catch { /* Might be isolated already. */ }
    return null;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (!resolved) resolveReady(false);
    channel.close();
  }

  function cancel() {
    if (!disposed) channel.postMessage({ type: "cancel" });
    try { popup.close(); } catch { /* An isolated tab may reject close(). */ }
    dispose();
  }

  async function authorize(provider, url, { readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
    if (!allowedAuthorizationUrl(provider, url)) throw new Error("Unexpected sign-in address");
    if (disposed) return false;
    let timeout;
    const gotReady = await Promise.race([
      ready,
      new Promise(resolve => {
        timeout = setTimeout(() => resolve(false), readyTimeoutMs);
      }),
    ]);
    clearTimeout(timeout);
    if (!gotReady || disposed) return false;
    channel.postMessage({ type: "authorize", provider, url });
    return true;
  }

  return { popup, authorize, cancel, dispose };
}
