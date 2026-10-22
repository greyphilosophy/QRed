import { createRemoteJWKSet, jwtVerify } from "jose";
import authorities from "../src/trustedAuthorities.json";
import { attestationMessage, decodeFixedBase64, encodeIdentity, MAX_ATTESTATION_PAGES } from "../src/attestation.js";
import { concatenate, encodeBase64Url, sha256, utf8 } from "../src/sealFormat.js";
import { cookieSessions, SESSION_SECONDS } from "./googleSession.js";

const GOOGLE_TOKEN_MAX_AGE = 300;
const CLOCK_SKEW = 30;
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
let cachedSigningKey;
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
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

export function googleIdentity(payload, fallbackName) {
  if (payload.email_verified !== true || typeof payload.email !== "string" ||
      !(payload.email.toLowerCase().endsWith("@gmail.com") || (typeof payload.hd === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(payload.hd)))) {
    throw new RequestError("Use a Gmail or Google Workspace account. Other email addresses need separate email verification.", 403);
  }
  const hasName = typeof payload.name === "string" && payload.name.trim();
  const identity = { provider: "google", email: payload.email, subject: payload.sub,
    name: hasName ? payload.name.trim() : fallbackName, name_source: hasName ? "google" : "self" };
  if (!identity.name) throw new RequestError("Google did not supply a name. Enter your name in QRed and try again.");
  try { encodeIdentity(identity); } catch { throw new RequestError("Google returned unsupported account details"); }
  return identity;
}

function checkGoogleTime(payload, now) {
  const seconds = Math.floor(now / 1000);
  // iat is Google's token-issuance time, not the time a password was entered.
  if (!Number.isSafeInteger(payload.iat) || payload.iat < seconds - GOOGLE_TOKEN_MAX_AGE || payload.iat > seconds + CLOCK_SKEW) {
    throw new RequestError("Google sign-in is too old or its clock differs from QRed. Please try again.", 403);
  }
}

export async function verifyGoogleIdToken(token, clientId, now, keys = googleKeys) {
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ["RS256"], issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId, requiredClaims: ["exp", "iat", "sub", "nonce"],
    maxTokenAge: GOOGLE_TOKEN_MAX_AGE, clockTolerance: CLOCK_SKEW, currentDate: new Date(now),
  });
  checkGoogleTime(payload, now);
  if (payload.aud !== clientId || (payload.azp && payload.azp !== clientId)) throw new RequestError("Google authentication failed", 403);
  return payload;
}

async function signingKey(env, trusted) {
  const seed = env.QRED_ATTESTATION_PRIVATE_KEY?.trim();
  const keyId = env.QRED_ATTESTATION_KEY_ID;
  const publicKey = trusted[keyId];
  if (!publicKey) throw new RequestError("Google sealing is not available on this QRed installation", 503);
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

export function createGoogleAuth({ fetchImpl = (...args) => fetch(...args), verifyToken = verifyGoogleIdToken,
  now = () => Date.now(), trusted = authorities } = {}) {
  function configured(env) {
    return Boolean(env.QRED_GOOGLE_CLIENT_ID && env.QRED_GOOGLE_CLIENT_SECRET &&
      env.QRED_ATTESTATION_PRIVATE_KEY && trusted[env.QRED_ATTESTATION_KEY_ID]);
  }
  function callbackPage(id, origin, successful, cookies = []) {
    const nonce = random();
    const script = "if(window.opener){window.opener.postMessage(" + JSON.stringify({ type: "qred-google-complete", id }) + "," + JSON.stringify(origin) + ");window.close();}";
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
    if (path === "/api/auth/config" && request.method === "GET") return json({ google: configured(env) });
    if (!configured(env)) throw new RequestError("Google sealing is not available on this QRed installation. Use a private key file.", 503);
    if (new URL(origin).origin !== origin || !origin.startsWith("https://")) throw new RequestError("Google sealing is unavailable", 503);
    const sessions = cookieSessions(env, origin, now);
    const readSession = async (id, kind) => {
      try { return await sessions.read(request, id, kind); }
      catch { throw new RequestError("Sign-in request expired or could not be authenticated. Please start again.", 403); }
    };
    if (path === "/api/auth/google/callback" && request.method === "GET") {
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
        if (url.searchParams.has("error") || !code || code.length > 4096) throw new RequestError("Google sign-in was cancelled. You can try again.");
        const response = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(10000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ code, client_id: env.QRED_GOOGLE_CLIENT_ID, client_secret: env.QRED_GOOGLE_CLIENT_SECRET,
            code_verifier: pending.pkce, redirect_uri: origin + path, grant_type: "authorization_code" }) });
        if (!response.ok) throw new RequestError("Google authentication failed. Please try again.", 403);
        const tokens = await response.json();
        if (typeof tokens.id_token !== "string" || tokens.id_token.length > 16384) throw new RequestError("Google authentication failed", 403);
        const payload = await verifyToken(tokens.id_token, env.QRED_GOOGLE_CLIENT_ID, now());
        if (payload.nonce !== pending.nonce) throw new RequestError("Google authentication did not match this request", 403);
        if (payload.iat < pending.iat - CLOCK_SKEW) throw new RequestError("Google sign-in predates this request. Please try again.", 403);
        const identity = googleIdentity(payload, pending.name);
        const time = now();
        checkGoogleTime(payload, time);
        if (Math.floor(time / 1000) >= pending.exp) throw new RequestError("Sign-in request expired. Please try again.", 403);
        const receipt = { status: "ready", secret_hash: pending.secret_hash, commitments_hash: pending.commitments_hash,
          identity, issued_at: new Date(time).toISOString(), google_iat: payload.iat,
          iat: Math.floor(time / 1000), exp: pending.exp };
        // Keep the success cookie separate: a concurrent failed code exchange
        // must not overwrite a successful result. Google enforces code single-use.
        return callbackPage(id, origin, true, [
          await sessions.write(id, "receipt", receipt), sessions.clear(id, "request"),
        ]);
      } catch (error) {
        const message = error instanceof RequestError ? error.message : "Google authentication failed. Please try again.";
        return callbackPage(id, origin, false, [await sessions.write(id, "request", {
          status: "failed", secret_hash: pending.secret_hash, error: message, iat: pending.iat, exp: pending.exp,
        })]);
      }
    }
    if (request.method !== "POST") throw new RequestError("Method not allowed", 405);
    if (request.headers.get("Origin") !== origin) throw new RequestError("Invalid request origin", 403);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Invalid request");
    if (path === "/api/auth/google/start") {
      onlyFields(body, ["commitments", "name"]);
      const commitmentsHash = await commitmentDigest(body.commitments);
      if (body.name !== undefined && typeof body.name !== "string") throw new RequestError("Invalid name");
      const name = (body.name || "").trim();
      // eslint-disable-next-line no-control-regex
      if (utf8.encode(name).length > 160 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw new RequestError("Invalid name");
      try { await signingKey(env, trusted); } catch { throw new RequestError("Google sealing is unavailable", 503); }
      const seconds = Math.floor(now() / 1000);
      const id = random(), secret = random(), nonce = random(), pkce = random();
      const pending = { status: "pending", secret_hash: await hash(secret), commitments_hash: commitmentsHash, name, nonce, pkce,
        iat: seconds, exp: seconds + SESSION_SECONDS };
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({ client_id: env.QRED_GOOGLE_CLIENT_ID, redirect_uri: origin + "/api/auth/google/callback",
        response_type: "code", scope: "openid email profile", state: id, nonce, prompt: "select_account", code_challenge: await hash(pkce), code_challenge_method: "S256" }).toString();
      return json({ id, secret, authorize_url: auth.href }, 200, cookieHeaders([await sessions.write(id, "request", pending)]));
    }
    onlyFields(body, path === "/api/attest/google" ? ["id", "secret", "commitments", "index"] : ["id", "secret"]);
    if (typeof body.id !== "string" || typeof body.secret !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(body.id) || !/^[A-Za-z0-9_-]{43}$/.test(body.secret)) throw new RequestError("Invalid sign-in request", 403);
    if (path === "/api/auth/google/finish") {
      // Clear even expired cookies. Copies of a cookie remain valid only until
      // their original expiry; stateless sessions cannot be individually revoked.
      return json({ finished: true }, 200, cookieHeaders([sessions.clear(body.id, "request"), sessions.clear(body.id, "receipt")]));
    }
    const session = await readSession(body.id, "receipt") || await readSession(body.id, "request");
    if (!session || session.secret_hash !== await hash(body.secret)) throw new RequestError("Sign-in request expired or belongs to another browser. Please start again.", 403);
    if (path === "/api/auth/google/status") return json({ status: session.status,
      ...(session.status === "failed" ? { error: session.error } : {}),
      ...(session.status === "ready" ? { identity: session.identity, timestamp: session.issued_at } : {}) });
    if (path !== "/api/attest/google") throw new RequestError("Unknown endpoint", 404);
    if (session.status !== "ready") throw new RequestError("Complete Google sign-in first", 403);
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

export const handleGoogleAuth = createGoogleAuth();
