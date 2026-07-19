/**
 * QRed Cloudflare Pages Worker
 *
 * Serves the static frontend assets and exposes /api/keys/default for
 * the sealing interface.  All sealing happens client-side — the backend
 * has been removed so no PDFs ever touch a server.
 *
 * Static demo keypair used when no environment variables are set.
 * Configure QRED_DEFAULT_PRIVATE_KEY / QRED_DEFAULT_PUBLIC_KEY on the
 * Worker to use your own signing keys.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return a JSON Response with a predictable Content-Type header.
 */
function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Demo keypair (hard-coded for static hosting)
// ---------------------------------------------------------------------------

const DEMO_KEYPAIR = {
  private_key: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=",
  public_key: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
  key_id: "da522162396ab2d0",
  source: "static-demo",
};

/**
 * Decode a Base64url-encoded public key to hex for computing key_id.
 */
function base64urlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Compute a 16-character hex key_id from a Base64url public key.
 */
async function computeKeyId(publicKey) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    base64urlToBytes(publicKey)
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Return the effective default keypair: env vars when present, else demo.
 */
async function defaultKeypair(env) {
  const privateKey = env.QRED_DEFAULT_PRIVATE_KEY?.trim();
  const publicKey = env.QRED_DEFAULT_PUBLIC_KEY?.trim();
  const keyId = env.QRED_DEFAULT_KEY_ID?.trim();

  if (privateKey && publicKey) {
    return {
      private_key: privateKey,
      public_key: publicKey,
      key_id: keyId || (await computeKeyId(publicKey)),
      source: "worker-environment",
    };
  }

  return DEMO_KEYPAIR;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- /api/keys/default  (frontend calls this on load) -------------------
    if (url.pathname === "/api/keys/default" || url.pathname === "/api/keys/demo") {
      return json(await defaultKeypair(env));
    }

    // --- All other paths → static assets -----------------------------------
    return env.ASSETS.fetch(request);
  },
};