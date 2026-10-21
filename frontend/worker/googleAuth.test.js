import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createGoogleAuth, googleIdentity, verifyGoogleIdToken } from "./googleAuth.js";
import { attestationMessage, pageCommitment } from "../src/attestation.js";
import { encodeBase64Url, decodeBase64Url } from "../src/sealFormat.js";
import { createQRedSeals } from "../src/qredSealer.js";
import { verifyQRedSeals } from "../src/qredVerifier.js";
import { attestPagesWithGoogle } from "../src/googleSealing.js";

const seed = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
const keyId = "da522162396ab2d0";
const trusted = { [keyId]: publicKey };
const origin = "https://qred.org";
const epoch = Date.parse("2026-10-20T12:00:00Z");
// Vite 5 predates node:sqlite; load this Node 24 built-in without its resolver.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
let rsa, jwks;
beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);
  rsa = await generateKeyPair("RS256", { extractable: true });
  jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(rsa.publicKey), kid: "test-google-key", alg: "RS256" }] });
});
async function token(claims = {}) {
  return new SignJWT({ email: "alice@gmail.com", email_verified: true, name: "Alice Example", sub: "123456789", nonce: "test-nonce", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-google-key" }).setIssuer(claims.iss || "https://accounts.google.com")
    .setAudience(claims.aud || "test-client").setIssuedAt(claims.iat ?? epoch / 1000)
    .setExpirationTime(claims.exp ?? epoch / 1000 + 3600).sign(rsa.privateKey);
}
function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("./migrations/0001_google_auth.sql", import.meta.url), "utf8"));
  const prepare = sql => ({ bind: (...params) => ({
    first: async () => sqlite.prepare(sql).get(...params) || null,
    run: async () => sqlite.prepare(sql).run(...params),
  }) });
  return { sqlite, prepare, batch: async statements => {
    sqlite.exec("BEGIN");
    try { const results = []; for (const stmt of statements) results.push(await stmt.run()); sqlite.exec("COMMIT"); return results; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } };
}

describe("Google token and account eligibility", () => {
  it("checks a real RSA signature, issuer, audience, token age and expiry", async () => {
    await expect(verifyGoogleIdToken(await token(), "test-client", epoch, jwks)).resolves.toMatchObject({ email: "alice@gmail.com" });
    for (const claims of [{ iss: "https://evil.example" }, { aud: "other-client" }, { azp: "other-client" },
      { exp: epoch / 1000 - 10 }, { iat: epoch / 1000 - 700 }]) {
      await expect(verifyGoogleIdToken(await token(claims), "test-client", epoch, jwks)).rejects.toThrow();
    }
    const good = await token();
    const missingExpiry = await new SignJWT({ sub: "123456789", nonce: "test-nonce" })
      .setProtectedHeader({ alg: "RS256", kid: "test-google-key" }).setIssuer("https://accounts.google.com")
      .setAudience("test-client").setIssuedAt(epoch / 1000).sign(rsa.privateKey);
    await expect(verifyGoogleIdToken(missingExpiry, "test-client", epoch, jwks)).rejects.toThrow();
    await expect(verifyGoogleIdToken(await token({ nonce: undefined }), "test-client", epoch, jwks)).rejects.toThrow();
    const parts = good.split("."); parts[1] = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ sub: "forged" })));
    await expect(verifyGoogleIdToken(parts.join("."), "test-client", epoch, jwks)).rejects.toThrow();
  });
  it("accepts only authoritative verified emails and labels fallback names", () => {
    const user = { email: "alice@gmail.com", email_verified: true, name: "Alice", sub: "123" };
    expect(googleIdentity(user, "Wrong fallback")).toMatchObject({ name: "Alice", name_source: "google" });
    expect(googleIdentity({ ...user, email: "alice@example.org", hd: "example.org" }, "")).toMatchObject({ email: "alice@example.org" });
    expect(googleIdentity({ ...user, name: undefined }, "Declared name")).toMatchObject({ name_source: "self", name: "Declared name" });
    for (const bad of [{ ...user, email_verified: false }, { ...user, email_verified: "true" },
      { ...user, email: "alice@outlook.com" }, { ...user, email: "alice@gmail.com.evil.example" },
      { ...user, name: undefined }, { ...user, name: "Spoof\u202e" }]) expect(() => googleIdentity(bad, "")).toThrow();
  });
});

describe("document-bound Google attestation API", () => {
  let db, env, handle, clock, issuedToken, exchange;
  const post = (path, body, extra = {}) => handle(new Request(origin + path, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1", ...extra }, body: JSON.stringify(body),
  }), env);
  async function start(commitments = [encodeBase64Url(new Uint8Array(32))]) {
    const response = await post("/api/auth/google/start", { commitments, name: "Fallback" });
    expect(response.status).toBe(200);
    const session = await response.json();
    return { ...session, cookie: response.headers.get("Set-Cookie").split(";")[0] };
  }
  async function login(session, claims = {}) {
    const nonce = new URL(session.authorize_url).searchParams.get("nonce");
    issuedToken = await token({ nonce, ...claims });
    return handle(new Request(origin + "/api/auth/google/callback?state=" + session.id + "&code=test-code", {
      headers: { Cookie: session.cookie },
    }), env);
  }
  beforeEach(() => {
    db = database(); clock = epoch;
    env = { QRED_AUTH_DB: db, QRED_GOOGLE_CLIENT_ID: "test-client", QRED_GOOGLE_CLIENT_SECRET: "test-secret",
      QRED_ATTESTATION_PRIVATE_KEY: seed + "\n", QRED_ATTESTATION_KEY_ID: keyId };
    exchange = vi.fn(async () => new Response(JSON.stringify({ id_token: issuedToken })));
    handle = createGoogleAuth({ now: () => clock, fetchImpl: exchange, trusted,
      verifyToken: (value, clientId, now) => verifyGoogleIdToken(value, clientId, now, jwks) });
  });
  it("freezes the document before login and produces an independently verifiable offline seal", async () => {
    const content = "Private invoice: 125 dollars";
    const metadata = { pdf: true, page_number: 2, page_count: 2, document_root: "12".repeat(32) };
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const commitment = await pageCommitment(metadata, content, salt);
    const session = await start([encodeBase64Url(commitment)]);
    const query = new URL(session.authorize_url).searchParams;
    expect(query.get("scope")).toBe("openid email profile");
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(session.authorize_url).not.toContain(encodeBase64Url(commitment));
    expect((await post("/api/attest/google", { ...session, index: 0 })).status).toBe(403);
    await login(session);
    const response = await post("/api/attest/google", { ...session, index: 0 });
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ timestamp: new Date(epoch).toISOString(), identity: { email: "alice@gmail.com", name: "Alice Example" } });
    const pub = await crypto.subtle.importKey("raw", decodeBase64Url(publicKey), "Ed25519", false, ["verify"]);
    expect(await crypto.subtle.verify("Ed25519", pub, decodeBase64Url(receipt.signature), attestationMessage(receipt, commitment))).toBe(true);
    const seals = await createQRedSeals({ content, pageContext: { pageNumber: 2, pageCount: 2, documentRoot: metadata.document_root },
      attestation: { ...receipt, salt, public_key: publicKey } });
    await expect(verifyQRedSeals(seals.seals, "", trusted)).resolves.toMatchObject({ status: "VALID", identity_authenticated: true, content, page_number: 2 });
    const stored = db.sqlite.prepare("SELECT * FROM auth_requests").get();
    expect(JSON.stringify(stored)).not.toContain(content);
    expect(JSON.stringify(stored)).not.toContain(encodeBase64Url(salt));
    expect(JSON.stringify(stored)).not.toContain(session.secret);
    expect(JSON.stringify(stored)).not.toContain(issuedToken);
    expect(stored.pkce).toBeNull();
    expect((await login(session)).status).toBe(403);
    expect(exchange).toHaveBeenCalledTimes(1);
    await post("/api/auth/google/finish", session);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_requests").get().n).toBe(0);
  });
  it("requires the original browser cookie, nonce and unexpired request", async () => {
    const session = await start();
    const noCookie = await handle(new Request(origin + "/api/auth/google/callback?state=" + session.id + "&code=x"), env);
    expect(noCookie.status).toBe(403);
    expect(exchange).not.toHaveBeenCalled();
    await login(session, { nonce: "wrong" });
    expect(await (await post("/api/auth/google/status", session)).json()).toMatchObject({ status: "failed" });
    expect((await post("/api/attest/google", { ...session, index: 0 })).status).toBe(403);
    const expired = await start(); clock += 600001;
    expect((await login(expired)).status).toBe(403);
  });
  it("runs the browser protocol without sending text, document roots, salts, filenames or user keys", async () => {
    const pages = [{ content: "Sensitive synthetic document", metadata: {
      pdf: true, page_number: 1, page_count: 2, document_root: "c3".repeat(32),
    } }, { content: "Second private page", metadata: {
      pdf: true, page_number: 2, page_count: 2, document_root: "c3".repeat(32),
    } }];
    const sent = []; let session, loggedIn = false;
    const popup = { location: {}, get closed() { throw new Error("Opener isolated by browser"); }, close: vi.fn() };
    const clientFetch = async (path, options) => {
      const body = JSON.parse(options.body); sent.push({ path, body });
      if (path === "/api/auth/google/status" && !loggedIn) { await login(session); loggedIn = true; }
      const response = await post(path, body);
      if (path === "/api/auth/google/start") {
        session = { ...await response.clone().json(), cookie: response.headers.get("Set-Cookie").split(";")[0] };
      }
      return response;
    };
    const receipts = await attestPagesWithGoogle(pages, { popup, fetchImpl: clientFetch, trusted });
    expect(receipts).toHaveLength(2);
    expect(new URL(popup.location.href).origin).toBe("https://accounts.google.com");
    expect(popup.close).toHaveBeenCalledOnce();
    const wire = JSON.stringify(sent);
    for (const page of pages) { expect(wire).not.toContain(page.content); expect(wire).not.toContain(page.metadata.document_root); }
    for (const receipt of receipts) expect(wire).not.toContain(encodeBase64Url(receipt.salt));
    expect(wire).not.toContain(seed);
    const seal = await createQRedSeals({ content: pages[1].content, pageContext: {
      pageNumber: 2, pageCount: 2, documentRoot: pages[1].metadata.document_root,
    }, attestation: receipts[1] });
    await expect(verifyQRedSeals(seal.seals, "", trusted)).resolves.toMatchObject({ status: "VALID", content: pages[1].content });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_requests").get().n).toBe(0);
  });
  it("rejects wrong origins, session secrets, page indices and changed commitments", async () => {
    expect((await post("/api/auth/google/start", { commitments: [] }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/auth/google/start", { commitments: ["bad"] })).status).toBe(400);
    expect((await post("/api/auth/google/start", { commitments: [encodeBase64Url(new Uint8Array(32))], text: "must never be sent" })).status).toBe(400);
    const session = await start(); await login(session);
    expect((await post("/api/attest/google", { ...session, secret: encodeBase64Url(new Uint8Array(32)), index: 0 })).status).toBe(403);
    expect((await post("/api/attest/google", { ...session, index: 1 })).status).toBe(400);
    // Extra caller-provided fingerprints cannot replace the server's frozen one.
    const first = await (await post("/api/attest/google", { ...session, index: 0 })).json();
    const second = await (await post("/api/attest/google", { ...session, index: 0, commitment: encodeBase64Url(new Uint8Array(32).fill(1)) })).json();
    expect(second.signature).toBe(first.signature);
  });
  it("fails closed on outside email addresses, missing configuration and exhausted free-tier budget", async () => {
    const session = await start(); await login(session, { email: "alice@outlook.com" });
    expect(await (await post("/api/auth/google/status", session)).json()).toMatchObject({ status: "failed", error: expect.stringContaining("separate email verification") });
    env.QRED_DAILY_SIGNIN_LIMIT = "1";
    expect((await post("/api/auth/google/start", { commitments: [encodeBase64Url(new Uint8Array(32))] })).status).toBe(429);
    const rateRows = db.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_rate").get().n;
    expect((await post("/api/auth/google/start", { commitments: [encodeBase64Url(new Uint8Array(32))] }, { "CF-Connecting-IP": "192.0.2.2" })).status).toBe(429);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_rate").get().n).toBe(rateRows);
    delete env.QRED_ATTESTATION_PRIVATE_KEY;
    expect((await post("/api/auth/google/start", {})).status).toBe(503);
  });
});
