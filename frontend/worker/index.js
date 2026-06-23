function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function buildProxyRequest(request, apiOrigin) {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(apiOrigin);
  targetUrl.pathname = sourceUrl.pathname;
  targetUrl.search = sourceUrl.search;

  const headers = new Headers(request.headers);
  headers.set("Host", targetUrl.host);
  headers.set("X-Forwarded-Host", sourceUrl.host);
  headers.set("X-Forwarded-Proto", sourceUrl.protocol.replace(":", ""));

  return new Request(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
    duplex: request.body ? "half" : undefined,
    redirect: "manual",
  });
}

const STATIC_DEMO_KEYPAIR = {
  private_key: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=",
  public_key: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
  key_id: "da522162396ab2d0",
  source: "worker-static-demo",
};

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function computeKeyId(publicKey) {
  const digest = await crypto.subtle.digest("SHA-256", base64UrlToBytes(publicKey));
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

async function configuredDefaultKeypair(env) {
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

  return STATIC_DEMO_KEYPAIR;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/keys/default" || url.pathname === "/api/keys/demo") {
      return jsonResponse(await configuredDefaultKeypair(env));
    }

    if (url.pathname.startsWith("/api/")) {
      if (!env.QRED_API_ORIGIN) {
        return jsonResponse(
          {
            error: "QRED_API_ORIGIN is not configured for this Worker.",
            message: "The static verifier is available, but API-backed demo endpoints require a separate QRed backend origin.",
          },
          { status: 503 },
        );
      }

      return fetch(buildProxyRequest(request, env.QRED_API_ORIGIN));
    }

    return env.ASSETS.fetch(request);
  },
};
