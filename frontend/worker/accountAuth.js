import authorities from "../src/trustedAuthorities.json";
import { attestationMessage, decodeFixedBase64, MAX_ATTESTATION_PAGES } from "../src/attestation.js";
import { concatenate, encodeBase64Url, sha256, utf8 } from "../src/sealFormat.js";
import { cookieSessions, SESSION_SECONDS } from "./accountSession.js";

import { AUTH_PROVIDERS, authProvider } from "../src/authProviders.js";
import { RequestError } from "./authErrors.js";
import { authorizationUrl, exchangeIdentity, providerConfiguration } from "./authProviders.js";

let cachedSigningKey;
const random = () => encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const hash = async value => encodeBase64Url(await sha256(utf8.encode(value)));
const json = (body, status = 200, extra = {}) => {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(body), { status, headers });
};
const cookieHeaders = cookies => {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return headers;
};
function onlyFields(body, allowed) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new RequestError("Unexpected request fields");
}
async function commitmentDigest(commitments) {
  if (!Array.isArray(commitments) || !commitments.length || commitments.length > MAX_ATTESTATION_PAGES) throw new RequestError("Choose a document with 1–100 pages");
  try { commitments.forEach(value => decodeFixedBase64(value, 32)); }
  catch { throw new RequestError("Invalid document fingerprints"); }
  return hash(JSON.stringify(commitments));
}

async function readJson(request) {
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json" || !request.body) throw new RequestError("Expected a JSON request");
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16384) { await reader.cancel(); throw new RequestError("Request is too large", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(concatenate(chunks))); }
  catch { throw new RequestError("Invalid JSON request"); }
}

async function signingKey(env, trusted) {
  const seed = env.QRED_ATTESTATION_PRIVATE_KEY?.trim();
  const keyId = env.QRED_ATTESTATION_KEY_ID;
  const publicKey = trusted[keyId];
  if (!publicKey) throw new RequestError("Account sealing is not available on this QRed installation", 503);
  if (cachedSigningKey?.seed === seed && cachedSigningKey?.publicKey === publicKey && cachedSigningKey?.keyId === keyId) return cachedSigningKey.promise;
  const promise = (async () => {
    const raw = decodeFixedBase64(seed, 32);
    // RFC 8410 PKCS#8 wrapper for a raw Ed25519 seed; signing uses native Web Crypto.
    const prefix = new Uint8Array([48,46,2,1,0,48,5,6,3,43,101,112,4,34,4,32]);
    const key = await crypto.subtle.importKey("pkcs8", concatenate([prefix, raw]), "Ed25519", false, ["sign"]);
    const pub = decodeFixedBase64(publicKey, 32);
    const id = Array.from((await sha256(pub)).subarray(0, 8), b => b.toString(16).padStart(2, "0")).join("");
    const verificationKey = await crypto.subtle.importKey("raw", pub, "Ed25519", false, ["verify"]);
    const check = utf8.encode("QRed authority key configuration check");
    if (id !== keyId || !await crypto.subtle.verify("Ed25519", verificationKey, await crypto.subtle.sign("Ed25519", key, check), check)) throw new Error("Mismatched authority key");
    return key;
  })();
  cachedSigningKey = { seed, publicKey, keyId, promise };
  return promise;
}

export function createAccountAuth({ fetchImpl = (...args) => fetch(...args), verifyTokens = {},
  now = () => Date.now(), trusted = authorities } = {}) {
  function configured(provider, env) {
    return Boolean(providerConfiguration(provider, env) &&
      env.QRED_ATTESTATION_PRIVATE_KEY && trusted[env.QRED_ATTESTATION_KEY_ID]);
  }
  function callbackPage(id, origin, successful, cookies = []) {
    const nonce = random();
    const script = "if(window.opener){window.opener.postMessage(" + JSON.stringify({ type: "qred-account-complete", id }) + "," + JSON.stringify(origin) + ");window.close();}";
    const headers = cookieHeaders(cookies);
    headers.set("Content-Type", "text/html;charset=utf-8");
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-" + nonce + "'; frame-ancestors 'none'; base-uri 'none'");
    return new Response("<!doctype html><meta charset=utf-8><title>QRed sign-in</title><p>" +
      (successful ? "Sign-in completed. Return to your QRed document window." : "Sign-in could not be completed. Return to QRed for details or try again.") +
      "</p><script nonce=\"" + nonce + "\">" + script + "</script>", { headers });
  }
  async function handle(request, env) {
    const url = new URL(request.url);
    const origin = env.QRED_ORIGIN || "https://qred.org";
    const path = url.pathname;
    if (path === "/api/auth/config" && request.method === "GET") {
      return json(Object.fromEntries(Object.keys(AUTH_PROVIDERS).map(provider => [provider, configured(provider, env)])));
    }
    const authRoute = path.match(/^\/api\/auth\/([a-z]+)\/(start|callback|status|finish)$/);
    const attestRoute = path.match(/^\/api\/attest\/([a-z]+)$/);
    const provider = authRoute?.[1] || attestRoute?.[1];
    const action = authRoute?.[2] || (attestRoute ? "attest" : null);
    const label = authProvider(provider)?.label;
    if (!label) throw new RequestError("Unknown endpoint", 404);
    if (!configured(provider, env)) throw new RequestError(label + " sealing is not available on this QRed installation. Choose another sealing method.", 503);
    const config = providerConfiguration(provider, env);
    if (new URL(origin).origin !== origin || !origin.startsWith("https://")) throw new RequestError("Account sealing is unavailable", 503);
    const sessions = cookieSessions(env, origin, now, provider, config.clientId);
    const readSession = async (id, kind) => {
      try { return await sessions.read(request, id, kind); }
      catch { throw new RequestError("Sign-in request expired or could not be authenticated. Please start again.", 403); }
    };
    if (action === "callback" && request.method === "GET") {
      const id = url.searchParams.get("state");
      if (!/^[A-Za-z0-9_-]{43}$/.test(id || "")) throw new RequestError("Invalid sign-in request", 403);
      // A duplicate callback with a completed cookie cannot renew the timestamp.
      const complete = await readSession(id, "receipt");
      if (complete?.status === "ready") return callbackPage(id, origin, true);
      const pending = await readSession(id, "request");
      if (!pending) throw new RequestError("Return to the browser where you started signing in, or start again.", 403);
      if (pending.status === "failed") return callbackPage(id, origin, false);
      if (pending.status !== "pending") throw new RequestError("Invalid sign-in request", 403);
      try {
        const code = url.searchParams.get("code");
        if (url.searchParams.has("error") || !code || code.length > 4096) throw new RequestError("Sign-in was cancelled. You can try again.");
        const authenticated = await exchangeIdentity(provider, config, { code, origin, pending, fetchImpl, now, verifyTokens });
        const identity = authenticated.identity;
        const time = now();
        if (Math.floor(time / 1000) >= pending.exp) throw new RequestError("Sign-in request expired. Please try again.", 403);
        const receipt = { status: "ready", secret_hash: pending.secret_hash, commitments_hash: pending.commitments_hash,
          identity, issued_at: new Date(time).toISOString(), provider_iat: authenticated.provider_iat,
          iat: Math.floor(time / 1000), exp: pending.exp };
        // Keep the success cookie separate: a concurrent failed code exchange
        // must not overwrite a successful result. The provider enforces code single-use.
        return callbackPage(id, origin, true, [
          await sessions.write(id, "receipt", receipt), sessions.clear(id, "request"),
        ]);
      } catch (error) {
        const message = error instanceof RequestError ? error.message : "Authentication failed. Please try again.";
        return callbackPage(id, origin, false, [await sessions.write(id, "request", {
          status: "failed", secret_hash: pending.secret_hash, error: message, iat: pending.iat, exp: pending.exp,
        })]);
      }
    }
    if (request.method !== "POST") throw new RequestError("Method not allowed", 405);
    if (request.headers.get("Origin") !== origin) throw new RequestError("Invalid request origin", 403);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Invalid request");
    if (action === "start") {
      onlyFields(body, ["commitments"]);
      const commitmentsHash = await commitmentDigest(body.commitments);
      try { await signingKey(env, trusted); } catch { throw new RequestError("Account sealing is unavailable", 503); }
      const seconds = Math.floor(now() / 1000);
      const id = random(), secret = random(), nonce = random(), pkce = random();
      const pending = { status: "pending", secret_hash: await hash(secret), commitments_hash: commitmentsHash, nonce, pkce,
        iat: seconds, exp: seconds + SESSION_SECONDS };
      const authorize_url = authorizationUrl(provider, config, { origin, id, nonce, challenge: await hash(pkce) });
      return json({ id, secret, authorize_url }, 200, cookieHeaders([await sessions.write(id, "request", pending)]));
    }

    onlyFields(body, action === "attest" ? ["id", "secret", "commitments", "index"] : ["id", "secret"]);
    if (typeof body.id !== "string" || typeof body.secret !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(body.id) || !/^[A-Za-z0-9_-]{43}$/.test(body.secret)) throw new RequestError("Invalid sign-in request", 403);
    if (action === "finish") {
      // Clear even expired cookies. Copies of a cookie remain valid only until
      // their original expiry; stateless sessions cannot be individually revoked.
      return json({ finished: true }, 200, cookieHeaders([sessions.clear(body.id, "request"), sessions.clear(body.id, "receipt")]));
    }
    const session = await readSession(body.id, "receipt") || await readSession(body.id, "request");
    if (!session || session.secret_hash !== await hash(body.secret)) throw new RequestError("Sign-in request expired or belongs to another browser. Please start again.", 403);
    if (action === "status") return json({ status: session.status,
      ...(session.status === "failed" ? { error: session.error } : {}),
      ...(session.status === "ready" ? { identity: session.identity, timestamp: session.issued_at } : {}) });
    if (action !== "attest") throw new RequestError("Unknown endpoint", 404);
    if (session.status !== "ready") throw new RequestError("Complete sign-in first", 403);
    if (await commitmentDigest(body.commitments) !== session.commitments_hash) throw new RequestError("Document fingerprints changed after sign-in started", 403);
    if (!Number.isInteger(body.index) || body.index < 0 || body.index >= body.commitments.length) throw new RequestError("Invalid page number");
    const receipt = { timestamp: session.issued_at, key_id: session.key_id, identity: session.identity };
    const key = await signingKey(env, trusted);
    const signature = await crypto.subtle.sign("Ed25519", key, attestationMessage(receipt, decodeFixedBase64(body.commitments[body.index], 32)));
    return json({ ...receipt, signature: encodeBase64Url(new Uint8Array(signature)) });
  }
  return async (request, env) => {
    try { return await handle(request, env); }
    catch (error) { return json({ error: error instanceof RequestError ? error.message : "QRed could not complete this request. Please try again." }, error.status || 500); }
  };
}

export const handleAccountAuth = createAccountAuth();
