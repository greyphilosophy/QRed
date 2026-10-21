import { createRemoteJWKSet, jwtVerify } from "jose";
import authorities from "../src/trustedAuthorities.json";
import { attestationMessage, decodeFixedBase64, encodeIdentity, MAX_ATTESTATION_PAGES } from "../src/attestation.js";
import { concatenate, encodeBase64Url, sha256, utf8 } from "../src/sealFormat.js";

const TTL = 10 * 60 * 1000;
const COOKIE = "__Host-qred-google";
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
let cachedSigningKey;
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const random = () => encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const hash = async value => encodeBase64Url(await sha256(utf8.encode(value)));
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...headers },
});

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

export async function verifyGoogleIdToken(token, clientId, now, keys = googleKeys) {
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ["RS256"], issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId, requiredClaims: ["exp", "iat", "sub", "nonce"],
    maxTokenAge: "10m", clockTolerance: 5, currentDate: new Date(now),
  });
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
  async function rateLimit(env, bucket, window, limit) {
    const row = await env.QRED_AUTH_DB.prepare("INSERT INTO auth_rate(bucket, window, count) VALUES (?, ?, 1) ON CONFLICT(bucket, window) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count")
      .bind(bucket, window, limit).first();
    if (!row) throw new RequestError("Too many sign-in requests. Please try again later or use a private key file.", 429);
  }
  function configured(env) {
    return Boolean(env.QRED_GOOGLE_CLIENT_ID && env.QRED_GOOGLE_CLIENT_SECRET && env.QRED_AUTH_DB &&
      env.QRED_ATTESTATION_PRIVATE_KEY && trusted[env.QRED_ATTESTATION_KEY_ID]);
  }
  function callbackPage(id, origin, successful) {
    const nonce = random();
    const script = "if(window.opener){window.opener.postMessage(" + JSON.stringify({ type: "qred-google-complete", id }) + "," + JSON.stringify(origin) + ");window.close();}";
    return new Response("<!doctype html><meta charset=utf-8><title>QRed sign-in</title><p>" +
      (successful ? "Sign-in completed. Return to your QRed document window." : "Sign-in could not be completed. Return to QRed for details or try again.") +
      "</p><script nonce=\"" + nonce + "\">" + script + "</script>", {
      headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce + "'; frame-ancestors 'none'; base-uri 'none'",
        "Set-Cookie": COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" },
    });
  }
  async function handle(request, env) {
    const url = new URL(request.url);
    const origin = env.QRED_ORIGIN || "https://qred.org";
    const path = url.pathname;
    if (path === "/api/auth/config" && request.method === "GET") return json({ google: configured(env) });
    if (!configured(env)) throw new RequestError("Google sealing is not available on this QRed installation. Use a private key file.", 503);
    if (new URL(origin).origin !== origin || !origin.startsWith("https://")) throw new RequestError("Google sealing is unavailable", 503);
    if (path === "/api/auth/google/callback" && request.method === "GET") {
      const id = url.searchParams.get("state");
      if (!/^[A-Za-z0-9_-]{43}$/.test(id || "")) throw new RequestError("Invalid sign-in request", 403);
      const cookie = request.headers.get("Cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
      if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) throw new RequestError("Return to the browser where you started signing in", 403);
      // Atomic claim prevents callback replay, even across Worker isolates.
      const row = await env.QRED_AUTH_DB.prepare("UPDATE auth_requests SET status='exchanging' WHERE id=? AND cookie_hash=? AND status='pending' AND expires>? RETURNING *")
        .bind(id, await hash(cookie), now()).first();
      if (!row) throw new RequestError("Sign-in request expired or was already used", 403);
      try {
        const code = url.searchParams.get("code");
        if (url.searchParams.has("error") || !code || code.length > 4096) throw new RequestError("Google sign-in was cancelled. You can try again.");
        const response = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(10000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ code, client_id: env.QRED_GOOGLE_CLIENT_ID, client_secret: env.QRED_GOOGLE_CLIENT_SECRET,
            code_verifier: row.pkce, redirect_uri: origin + path, grant_type: "authorization_code" }) });
        if (!response.ok) throw new RequestError("Google authentication failed. Please try again.", 403);
        const tokens = await response.json();
        if (typeof tokens.id_token !== "string" || tokens.id_token.length > 16384) throw new RequestError("Google authentication failed", 403);
        const payload = await verifyToken(tokens.id_token, env.QRED_GOOGLE_CLIENT_ID, now());
        if (payload.nonce !== row.nonce) throw new RequestError("Google authentication did not match this request", 403);
        const identity = googleIdentity(payload, row.name);
        await env.QRED_AUTH_DB.prepare("UPDATE auth_requests SET status='ready', identity=?, issued_at=?, pkce=NULL, nonce=NULL WHERE id=? AND status='exchanging' AND expires>?")
          .bind(JSON.stringify(identity), new Date(now()).toISOString(), id, now()).run();
        return callbackPage(id, origin, true);
      } catch (error) {
        const message = error instanceof RequestError ? error.message : "Google authentication failed. Please try again.";
        await env.QRED_AUTH_DB.prepare("UPDATE auth_requests SET status='failed', error=?, pkce=NULL, nonce=NULL WHERE id=?")
          .bind(message, id).run();
        return callbackPage(id, origin, false);
      }
    }
    if (request.method !== "POST") throw new RequestError("Method not allowed", 405);
    if (request.headers.get("Origin") !== origin) throw new RequestError("Invalid request origin", 403);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Invalid request");
    if (path === "/api/auth/google/start") {
      if (Object.keys(body).some(k => !["commitments", "name"].includes(k)) || !Array.isArray(body.commitments) ||
          !body.commitments.length || body.commitments.length > MAX_ATTESTATION_PAGES) throw new RequestError("Choose a document with 1–100 pages");
      try { body.commitments.forEach(c => decodeFixedBase64(c, 32)); } catch { throw new RequestError("Invalid document fingerprints"); }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (utf8.encode(name).length > 160 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw new RequestError("Invalid name");
      try { await signingKey(env, trusted); } catch { throw new RequestError("Google sealing is unavailable", 503); }
      const time = now();
      const day = Math.floor(time / 86400000);
      const limit = Number(env.QRED_DAILY_SIGNIN_LIMIT || 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RequestError("Google sealing is unavailable", 503);
      await rateLimit(env, "daily", day * 86400000, limit);
      // Check the global budget first so new IPs cannot keep creating rate rows after exhaustion.
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      await rateLimit(env, "ip:" + await hash(day + ":" + ip + ":" + env.QRED_GOOGLE_CLIENT_SECRET), Math.floor(time / 600000) * 600000, 10);
      const id = random(), secret = random(), cookie = random(), nonce = random(), pkce = random();
      await env.QRED_AUTH_DB.batch([
        env.QRED_AUTH_DB.prepare("DELETE FROM auth_requests WHERE id IN (SELECT id FROM auth_requests WHERE expires<? LIMIT 100)").bind(time),
        env.QRED_AUTH_DB.prepare("DELETE FROM auth_rate WHERE window<?").bind(time - 2 * 86400000),
        env.QRED_AUTH_DB.prepare("INSERT INTO auth_requests(id, secret_hash, cookie_hash, nonce, pkce, commitments, name, expires, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')")
          .bind(id, await hash(secret), await hash(cookie), nonce, pkce, JSON.stringify(body.commitments), name, time + TTL),
      ]);
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({ client_id: env.QRED_GOOGLE_CLIENT_ID, redirect_uri: origin + "/api/auth/google/callback",
        response_type: "code", scope: "openid email profile", state: id, nonce, prompt: "select_account", code_challenge: await hash(pkce), code_challenge_method: "S256" }).toString();
      return json({ id, secret, authorize_url: auth.href }, 200,
        { "Set-Cookie": COOKIE + "=" + cookie + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600" });
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(body.id || "") || !/^[A-Za-z0-9_-]{43}$/.test(body.secret || "")) throw new RequestError("Invalid sign-in request", 403);
    const secretHash = await hash(body.secret);
    if (path === "/api/auth/google/finish") {
      await env.QRED_AUTH_DB.prepare("DELETE FROM auth_requests WHERE id=? AND secret_hash=?").bind(body.id, secretHash).run();
      return json({ finished: true });
    }
    const row = await env.QRED_AUTH_DB.prepare("SELECT * FROM auth_requests WHERE id=? AND secret_hash=? AND expires>?")
      .bind(body.id, secretHash, now()).first();
    if (!row) throw new RequestError("Sign-in request expired. Please try again.", 403);
    if (path === "/api/auth/google/status") return json({ status: row.status, ...(row.error ? { error: row.error } : {}),
      ...(row.status === "ready" ? { identity: JSON.parse(row.identity), timestamp: row.issued_at } : {}) });
    if (path !== "/api/attest/google") throw new RequestError("Unknown endpoint", 404);
    if (row.status !== "ready") throw new RequestError("Complete Google sign-in first", 403);
    const commitments = JSON.parse(row.commitments);
    if (!Number.isInteger(body.index) || body.index < 0 || body.index >= commitments.length) throw new RequestError("Invalid page number");
    const permitted = await env.QRED_AUTH_DB.prepare("UPDATE auth_requests SET receipts=receipts+1 WHERE id=? AND receipts<? RETURNING id")
      .bind(body.id, commitments.length * 3).first();
    if (!permitted) throw new RequestError("Too many attestation retries. Please start again.", 429);
    const receipt = { timestamp: row.issued_at, key_id: env.QRED_ATTESTATION_KEY_ID, identity: JSON.parse(row.identity) };
    const key = await signingKey(env, trusted);
    const signature = await crypto.subtle.sign("Ed25519", key, attestationMessage(receipt, decodeFixedBase64(commitments[body.index], 32)));
    return json({ ...receipt, signature: encodeBase64Url(new Uint8Array(signature)) });
  }
  return async (request, env) => {
    try { return await handle(request, env); }
    catch (error) { return json({ error: error instanceof RequestError ? error.message : "QRed could not complete this request. Please try again." }, error.status || 500); }
  };
}

export const handleGoogleAuth = createGoogleAuth();
