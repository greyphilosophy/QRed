import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createGoogleAuth, googleIdentity, verifyGoogleIdToken } from "./googleAuth.js";
import { attestationMessage, pageCommitment } from "../src/attestation.js";
import { encodeBase64Url, decodeBase64Url, sha256, utf8 } from "../src/sealFormat.js";
import { createQRedSeals } from "../src/qredSealer.js";
import { verifyQRedSeals } from "../src/qredVerifier.js";
import { attestPagesWithGoogle } from "../src/googleSealing.js";

const seed = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
const keyId = "da522162396ab2d0";
const trusted = { [keyId]: publicKey };
const origin = "https://qred.org";
const epoch = Date.parse("2026-10-20T12:00:00Z");
const fingerprint = value => encodeBase64Url(new Uint8Array(32).fill(value));
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
class CookieJar {
  constructor(other) { this.values = new Map(other?.values); }
  receive(response) {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0], separator = pair.indexOf("=");
      const name = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (header.includes("Max-Age=0")) this.values.delete(name);
      else this.values.set(name, value);
    }
    return response;
  }
  header() { return [...this.values].map(([key, value]) => key + "=" + value).join("; "); }
  tamper(kind) {
    const key = [...this.values.keys()].find(key => key.startsWith("__Host-qred-" + kind + "-"));
    const pieces = this.values.get(key).split(".");
    pieces[3] = (pieces[3][0] === "A" ? "B" : "A") + pieces[3].slice(1);
    this.values.set(key, pieces.join("."));
  }
}
const credentials = ({ id, secret }) => ({ id, secret });

describe("Google token and account eligibility", () => {
  it("checks real RSA signatures, issuer, audience, expiry and a five-minute issuance window", async () => {
    await expect(verifyGoogleIdToken(await token(), "test-client", epoch, jwks)).resolves.toMatchObject({ email: "alice@gmail.com" });
    for (const claims of [{ iss: "https://evil.example" }, { aud: "other-client" }, { azp: "other-client" },
      { exp: epoch / 1000 - 31 }, { iat: epoch / 1000 - 301 }, { iat: epoch / 1000 + 31 }, { iat: epoch / 1000 + 0.5 }]) {
      await expect(verifyGoogleIdToken(await token(claims), "test-client", epoch, jwks)).rejects.toThrow();
    }
    for (const offset of [-300, 30]) {
      await expect(verifyGoogleIdToken(await token({ iat: epoch / 1000 + offset }), "test-client", epoch, jwks)).resolves.toBeTruthy();
    }
    const missingExpiry = await new SignJWT({ sub: "123456789", nonce: "test-nonce" })
      .setProtectedHeader({ alg: "RS256", kid: "test-google-key" }).setIssuer("https://accounts.google.com")
      .setAudience("test-client").setIssuedAt(epoch / 1000).sign(rsa.privateKey);
    await expect(verifyGoogleIdToken(missingExpiry, "test-client", epoch, jwks)).rejects.toThrow();
    await expect(verifyGoogleIdToken(await token({ nonce: undefined }), "test-client", epoch, jwks)).rejects.toThrow();
    const parts = (await token()).split(".");
    parts[1] = encodeBase64Url(utf8.encode(JSON.stringify({ sub: "forged" })));
    await expect(verifyGoogleIdToken(parts.join("."), "test-client", epoch, jwks)).rejects.toThrow();
  });
  it("accepts only authoritative verified emails and names supplied by Google", () => {
    const user = { email: "alice@gmail.com", email_verified: true, name: "Alice", sub: "123" };
    expect(googleIdentity(user)).toMatchObject({ name: "Alice", name_source: "google" });
    expect(googleIdentity({ ...user, email: "alice@example.org", hd: "example.org" })).toMatchObject({ email: "alice@example.org" });
    for (const bad of [{ ...user, email_verified: false }, { ...user, email_verified: "true" },
      { ...user, email: "alice@outlook.com" }, { ...user, email: "alice@gmail.com.evil.example" },
      { ...user, name: undefined }, { ...user, name: "   " }, { ...user, name: 123 },
      { ...user, name: "Spoof\u202e" }]) expect(() => googleIdentity(bad)).toThrow();
  });
});

describe("stateless document-bound Google attestation API", () => {
  let env, clock, exchange, browser, codes, usedCodes, sequence;
  // Every HTTP request gets a fresh Worker handler. Only Google's fake code
  // exchange has a used-code list; QRed has no DB or per-request server memory.
  const handle = request => createGoogleAuth({ now: () => clock, fetchImpl: exchange, trusted,
    verifyToken: (value, clientId, now) => verifyGoogleIdToken(value, clientId, now, jwks) })(request, env);
  const post = async (path, body, { jar = browser, headers = {} } = {}) => jar.receive(await handle(new Request(origin + path, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: jar.header(), ...headers },
    body: JSON.stringify(body),
  })));
  async function start(commitments = [fingerprint(0)], { jar = browser } = {}) {
    const response = await post("/api/auth/google/start", { commitments }, { jar });
    expect(response.status).toBe(200);
    return { ...await response.json(), commitments, jar };
  }
  async function issueCode(session, claims = {}) {
    const code = "test-code-" + ++sequence;
    const query = new URL(session.authorize_url).searchParams;
    codes.set(code, { token: await token({ nonce: query.get("nonce"), iat: Math.floor(clock / 1000), ...claims }),
      challenge: query.get("code_challenge") });
    return code;
  }
  const callback = async (session, code, jar = session.jar, extra = "") =>
    jar.receive(await handle(new Request(origin + "/api/auth/google/callback?state=" + session.id + "&code=" + code + extra, {
      headers: { Cookie: jar.header() },
    })));
  const login = async (session, claims = {}) => callback(session, await issueCode(session, claims));
  const status = async session => (await post("/api/auth/google/status", credentials(session), { jar: session.jar })).json();
  const attest = (session, index = 0, overrides = {}) => post("/api/attest/google",
    { ...credentials(session), commitments: session.commitments, index, ...overrides }, { jar: session.jar });

  beforeEach(() => {
    clock = epoch; sequence = 0; browser = new CookieJar(); codes = new Map(); usedCodes = new Set();
    env = { QRED_GOOGLE_CLIENT_ID: "test-client", QRED_GOOGLE_CLIENT_SECRET: "test-secret",
      QRED_ATTESTATION_PRIVATE_KEY: seed + "\n", QRED_ATTESTATION_KEY_ID: keyId };
    exchange = vi.fn(async (_url, options) => {
      const code = options.body.get("code"), issued = codes.get(code);
      const challenge = encodeBase64Url(await sha256(utf8.encode(options.body.get("code_verifier"))));
      if (!issued || usedCodes.has(code) || challenge !== issued.challenge) return new Response("invalid_grant", { status: 400 });
      usedCodes.add(code);
      return new Response(JSON.stringify({ id_token: issued.token }));
    });
  });

  it("runs without a database and produces an independently verifiable offline seal", async () => {
    const content = "Private invoice: 125 dollars";
    const metadata = { pdf: true, page_number: 2, page_count: 2, document_root: "12".repeat(32) };
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const commitment = await pageCommitment(metadata, content, salt);
    const session = await start([encodeBase64Url(commitment)]);
    const query = new URL(session.authorize_url).searchParams;
    expect(query.get("scope")).toBe("openid email profile");
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(session.authorize_url).not.toContain(encodeBase64Url(commitment));
    expect(browser.header()).not.toContain(session.secret);
    expect((await attest(session)).status).toBe(403);
    await login(session);
    const response = await attest(session);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ timestamp: new Date(epoch).toISOString(), identity: { email: "alice@gmail.com", name: "Alice Example" } });
    expect(browser.header()).not.toContain("alice@gmail.com");
    const pub = await crypto.subtle.importKey("raw", decodeBase64Url(publicKey), "Ed25519", false, ["verify"]);
    expect(await crypto.subtle.verify("Ed25519", pub, decodeBase64Url(receipt.signature), attestationMessage(receipt, commitment))).toBe(true);
    const seals = await createQRedSeals({ content, pageContext: { pageNumber: 2, pageCount: 2, documentRoot: metadata.document_root },
      attestation: { ...receipt, salt, public_key: publicKey } });
    clock += 86400000;
    await expect(verifyQRedSeals(seals.seals, "", trusted)).resolves.toMatchObject({ status: "VALID", identity_authenticated: true, content, page_number: 2 });
    const finish = await post("/api/auth/google/finish", credentials(session));
    expect(finish.status).toBe(200);
    expect(browser.values.size).toBe(0);
  });

  it("does not issue attestations when Google supplies no profile name", async () => {
    const session = await start();
    await login(session, { name: undefined });
    expect(await status(session)).toMatchObject({ status: "failed", error: expect.stringContaining("Add a name to your Google profile") });
    expect((await attest(session)).status).toBe(403);
  });

  it("requires both the original browser cookie and the separate in-memory secret", async () => {
    const session = await start();
    const stranger = new CookieJar();
    expect((await callback(session, "unused", stranger)).status).toBe(403);
    expect(exchange).not.toHaveBeenCalled();
    await login(session);
    expect((await post("/api/auth/google/status", credentials(session), { jar: stranger })).status).toBe(403);
    expect((await attest(session, 0, { secret: fingerprint(9) })).status).toBe(403);
    const second = await start([fingerprint(1)]);
    await login(second, { email: "bob@gmail.com", sub: "other" });
    expect((await attest(second, 0, { secret: session.secret })).status).toBe(403);
    expect((await attest(session, 0, { commitments: second.commitments })).status).toBe(403);
    expect((await status(session)).identity.email).toBe("alice@gmail.com");
    expect((await status(second)).identity.email).toBe("bob@gmail.com");
  });

  it.each(["request", "receipt"])("rejects a modified encrypted %s cookie", async kind => {
    const session = await start();
    if (kind === "receipt") await login(session);
    browser.tamper(kind);
    if (kind === "request") {
      expect((await callback(session, "unused")).status).toBe(403);
      expect(exchange).not.toHaveBeenCalled();
    } else expect((await attest(session)).status).toBe(403);
  });

  it("rejects changing the document, its page order, identity or timestamp", async () => {
    const session = await start([fingerprint(0), fingerprint(1)]);
    await login(session);
    expect((await attest(session, 0, { commitments: [fingerprint(2), fingerprint(1)] })).status).toBe(403);
    expect((await attest(session, 0, { commitments: [...session.commitments].reverse() })).status).toBe(403);
    expect((await attest(session, 0, { commitments: [session.commitments[0]] })).status).toBe(403);
    expect((await attest(session, 2)).status).toBe(400);
    expect((await attest(session, 0, { identity: { email: "someone-else@gmail.com" } })).status).toBe(400);
    expect((await attest(session, 0, { timestamp: new Date(epoch + 86400000).toISOString() })).status).toBe(400);
  });

  it("allows retries across Workers without renewing the identity, timestamp or expiry", async () => {
    const session = await start();
    clock += 60000;
    const code = await issueCode(session);
    await callback(session, code);
    const first = await (await attest(session)).json();
    const copy = new CookieJar(browser);
    clock += 180000;
    await callback(session, code);
    expect(exchange).toHaveBeenCalledOnce();
    expect(await (await attest(session)).json()).toEqual(first);
    expect(first.timestamp).toBe(new Date(epoch + 60000).toISOString());
    await post("/api/auth/google/finish", credentials(session));
    expect((await attest(session)).status).toBe(403);
    // Clearing cookies is not revocation of stolen copies. Their fixed expiry
    // and document scope are enforced even after the original browser finishes.
    session.jar = copy;
    expect(await (await attest(session)).json()).toEqual(first);
    clock = epoch + 300000;
    expect((await attest(session)).status).toBe(403);
  });

  it("keeps a successful result when a concurrent callback reuses Google's code", async () => {
    const session = await start(), staleBrowser = new CookieJar(browser);
    const code = await issueCode(session);
    await callback(session, code);
    const response = await callback(session, code, staleBrowser);
    browser.receive(response); // Deliver the failed concurrent response last.
    expect((await status(session)).status).toBe("ready");
    expect((await attest(session)).status).toBe(200);
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["wrong nonce", { nonce: "wrong" }],
    ["old token", { iat: epoch / 1000 - 301 }],
    ["future token", { iat: epoch / 1000 + 31 }],
    ["token predating the request", { iat: epoch / 1000 - 31 }],
    ["non-authoritative email", { email: "alice@outlook.com" }],
  ])("fails closed for %s", async (_label, claims) => {
    const session = await start();
    await login(session, claims);
    expect(await status(session)).toMatchObject({ status: "failed", error: expect.any(String) });
    expect((await attest(session)).status).toBe(403);
  });

  it("expires pending requests and rechecks expiry after Google's response arrives", async () => {
    const expired = await start();
    clock += 300000;
    expect((await login(expired)).status).toBe(403);
    expect(exchange).not.toHaveBeenCalled();
    const session = await start();
    const originalExchange = exchange.getMockImplementation();
    exchange.mockImplementation(async (...args) => { const response = await originalExchange(...args); clock += 300000; return response; });
    await login(session);
    expect((await attest(session)).status).toBe(403);
  });

  it("does not reuse cookies after an authority, client or origin change", async () => {
    const session = await start(); await login(session);
    for (const change of [
      { QRED_ATTESTATION_PRIVATE_KEY: fingerprint(5) },
      { QRED_GOOGLE_CLIENT_ID: "different-client" },
      { QRED_ORIGIN: "https://another.example" },
    ]) {
      const previous = { ...env }; Object.assign(env, change);
      expect((await post("/api/auth/google/status", credentials(session), { headers: { Origin: env.QRED_ORIGIN || origin } })).status).toBe(403);
      env = previous;
    }
  });

  it("bounds cookie size for 100-page documents and maximal identity fields", async () => {
    const session = await start(Array.from({ length: 100 }, (_, index) => fingerprint(index)));
    await login(session, { name: '"'.repeat(160), email: "a".repeat(240) + "@gmail.com", sub: "9".repeat(255) });
    expect((await status(session)).status).toBe("ready");
    expect((await attest(session, 99)).status).toBe(200);
    for (const [key, value] of browser.values) expect((key + "=" + value).length).toBeLessThan(4096);
    const response = await post("/api/auth/google/start", { commitments: [fingerprint(1)] });
    for (const cookie of response.headers.getSetCookie()) {
      expect(cookie).toContain("; HttpOnly; Secure; SameSite=Lax");
      expect(cookie).toContain("; Path=/;");
      expect(cookie).not.toContain("; Domain=");
    }
  });

  it("rejects wrong origins, invalid or oversized inputs and incomplete configuration", async () => {
    const startPath = "/api/auth/google/start";
    expect((await post(startPath, { commitments: [fingerprint(0)] }, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    for (const body of [{ commitments: ["bad"] }, { commitments: [] }, { commitments: Array(101).fill(fingerprint(0)) },
      { commitments: [fingerprint(0)], text: "must never be sent" }, { commitments: [fingerprint(0)], name: "User-supplied name" }]) {
      expect((await post(startPath, body)).status).toBe(400);
    }
    expect((await post(startPath, { name: "x".repeat(17000) })).status).toBe(413);
    expect(await (await handle(new Request(origin + "/api/auth/config"))).json()).toEqual({ google: true, microsoft: false, amazon: false });
    delete env.QRED_ATTESTATION_PRIVATE_KEY;
    expect((await post(startPath, {})).status).toBe(503);
  });

  it.each([false, true])("runs the browser protocol and clears cookies after a signing error=%s", async failSigning => {
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
      if (path === "/api/attest/google" && failSigning) return new Response(JSON.stringify({ error: "Synthetic signing failure" }), { status: 503 });
      const response = await post(path, body);
      if (path === "/api/auth/google/start") session = { ...await response.clone().json(), jar: browser };
      return response;
    };
    const operation = attestPagesWithGoogle(pages, { popup, fetchImpl: clientFetch, trusted });
    if (failSigning) await expect(operation).rejects.toThrow("Synthetic signing failure");
    else {
      const receipts = await operation;
      expect(receipts).toHaveLength(2);
      const wire = JSON.stringify(sent);
      for (const page of pages) { expect(wire).not.toContain(page.content); expect(wire).not.toContain(page.metadata.document_root); }
      for (const receipt of receipts) expect(wire).not.toContain(encodeBase64Url(receipt.salt));
      expect(wire).not.toContain(seed);
      const seal = await createQRedSeals({ content: pages[1].content, pageContext: {
        pageNumber: 2, pageCount: 2, documentRoot: pages[1].metadata.document_root,
      }, attestation: receipts[1] });
      await expect(verifyQRedSeals(seal.seals, "", trusted)).resolves.toMatchObject({ status: "VALID", content: pages[1].content });
    }
    expect(Object.keys(sent.find(request => request.path === "/api/auth/google/start").body)).toEqual(["commitments"]);
    expect(new URL(popup.location.href).origin).toBe("https://accounts.google.com");
    expect(popup.close).toHaveBeenCalledOnce();
    expect(browser.values.size).toBe(0);
  });
});
