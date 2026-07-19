/**
 * QRed Cloudflare Pages Worker
 *
 * Serves the static frontend assets and exposes only the public signing key.
 * All PDF sealing happens client-side in the browser — no PDFs ever touch
 * the server, and no private keys are served.
 *
 * To configure a custom keypair, set QRED_DEFAULT_PUBLIC_KEY on the Worker.
 * The private key must remain secret and must never be set on the server.
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
// Demo public key (public only — private key is NOT included)
// ---------------------------------------------------------------------------

const DEMO_PUBLIC_KEY = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

/**
 * Decode a Base64url-encoded public key to bytes for computing key_id.
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
 * Return the effective default public key: env var when present, else demo.
 * NOTE: The private key is NEVER returned by this endpoint.
 * Users must supply their own private key in the browser.
 */
async function defaultPublicKey(env) {
  const publicKey = env.QRED_DEFAULT_PUBLIC_KEY?.trim() || DEMO_PUBLIC_KEY;
  const keyId = env.QRED_DEFAULT_KEY_ID?.trim() || (await computeKeyId(publicKey));
  return {
    public_key: publicKey,
    key_id: keyId,
    source: env.QRED_DEFAULT_PUBLIC_KEY?.trim() ? "worker-environment" : "static-demo",
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- /api/keys/default — public key only (NO private key) -------------
    if (url.pathname === "/api/keys/default" || url.pathname === "/api/keys/demo") {
      return json(await defaultPublicKey(env));
    }

    // --- All other paths → static assets -----------------------------------
    return env.ASSETS.fetch(request);
  },
};