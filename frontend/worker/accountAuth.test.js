import { beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createAccountAuth } from "./accountAuth.js";
import { beginAccountSignIn, attestPagesWithAccount } from "../src/accountSealing.js";
import { cookieSessions, SESSION_SECONDS } from "./accountSession.js";
import { createQRedSeals } from "../src/qredSealer.js";
import { verifyQRedSeals } from "../src/qredVerifier.js";
import { decodeEnvelope, encodeBase64Url, encodeEnvelope, qrPayloadBytes, sealString, sha256, utf8 } from "../src/sealFormat.js";

const origin = "https://qred.test", epoch = Date.parse("2026-10-25T12:00:00Z");
const tenant = "11111111-2222-3333-4444-555555555555";
const seed = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", keyId = "da522162396ab2d0";
const trusted = { [keyId]: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q" };
const providers = ["google", "microsoft", "amazon"];
const env = { QRED_ORIGIN: origin, QRED_ATTESTATION_PRIVATE_KEY: seed, QRED_ATTESTATION_KEY_ID: keyId,
  QRED_GOOGLE_CLIENT_ID: "google-client", QRED_GOOGLE_CLIENT_SECRET: "google-secret",
  QRED_MICROSOFT_CLIENT_ID: "microsoft-client",
  QRED_AMAZON_CLIENT_ID: "amazon-client", QRED_AMAZON_CLIENT_SECRET: "amazon-secret" };
const fingerprint = encodeBase64Url(new Uint8Array(32).fill(1));
beforeAll(() => vi.stubGlobal("crypto", webcrypto));

function fixture(provider) {
  const jar = new Map(), sent = [];
  let authorization, idTokenClaims;
  const receive = response => {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0], index = pair.indexOf("=");
      if (header.includes("Max-Age=0")) jar.delete(pair.slice(0, index));
      else jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };
  const cookie = () => [...jar].map(([key, value]) => key + "=" + value).join("; ");
  const exchange = vi.fn(async (url, options) => {
    if (url.startsWith("https://api.amazon.com/auth/o2/tokeninfo?")) return Response.json({
      iss: "https://www.amazon.com", aud: "amazon-client", user_id: "amazon-user", exp: 3599 });
    if (url === "https://api.amazon.com/user/profile") return Response.json({ user_id: "amazon-user", name: "Amazon Profile", email: "user@example.org" });
    const params = options.body;
    expect(params.get("client_id")).toBe(provider + "-client");
    expect(params.get("client_secret")).toBe(provider + "-secret");
    expect(params.get("redirect_uri")).toBe(origin + "/api/auth/" + provider + "/callback");
    expect(encodeBase64Url(await sha256(utf8.encode(params.get("code_verifier")))))
      .toBe(authorization.searchParams.get("code_challenge"));
    idTokenClaims = { name: "Profile Name", email: "user@gmail.com", email_verified: true, sub: "account-user", tid: tenant,
      nonce: authorization.searchParams.get("nonce"), iat: epoch / 1000 };
    return Response.json(provider === "amazon" ? { access_token: "opaque-amazon-token", token_type: "bearer", expires_in: 3600 } :
      { id_token: "synthetic-id-token" });
  });
  const handle = (request, config = env) => createAccountAuth({ fetchImpl: exchange, trusted, now: () => epoch,
    verifyTokens: { [provider]: async () => idTokenClaims } })(request, config);
  const post = async (path, body, config) => receive(await handle(new Request(origin + path, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie() }, body: JSON.stringify(body),
  }), config));
  const login = async session => {
    authorization = new URL(session.authorize_url);
    const response = receive(await handle(new Request(origin + "/api/auth/" + provider + "/callback?state=" + session.id + "&code=one-use-code", { headers: { Cookie: cookie() } })));
    if (provider === "microsoft") {
      const html = await response.clone().text();
      expect(html).toContain("https://login.microsoftonline.com/common/oauth2/v2.0/token");
      expect(html).not.toContain("client_secret");
      const verifier = await cookieSessions(env, origin, () => epoch, "microsoft", "microsoft-client")
        .read(new Request(origin, { headers: { Cookie: cookie() } }), session.id, "request");
      expect(encodeBase64Url(await sha256(utf8.encode(verifier.pkce)))).toBe(authorization.searchParams.get("code_challenge"));
      idTokenClaims = { name: "Profile Name", email: "user@gmail.com", sub: "account-user", tid: tenant,
        nonce: authorization.searchParams.get("nonce"), iat: epoch / 1000 };
      const completion = await post("/api/auth/microsoft/complete", { id: session.id, id_token: "synthetic-id-token" });
      expect(completion.status).toBe(200);
      expect(exchange).not.toHaveBeenCalled();
    }
    return response;
  };
  const clientFetch = async (path, options) => {
    const body = JSON.parse(options.body); sent.push({ path, body });
    const response = await post(path, body);
    if (path.endsWith("/start")) await login(await response.clone().json());
    return response;
  };
  return { jar, sent, post, handle, login, clientFetch, exchange, cookie };
}

describe.each(providers)("%s document attestations", provider => {
  it("runs the client/server protocol privately and verifies offline with the correct provider", async () => {
    const flow = fixture(provider), popup = { location: {}, close: vi.fn() };
    const pages = [1, 2].map(page => ({ content: "Confidential synthetic page " + page,
      metadata: { pdf: true, page_number: page, page_count: 2, document_root: "c3".repeat(32) } }));
    const receipts = await attestPagesWithAccount(provider, pages, { fetchImpl: flow.clientFetch, popup, trusted });
    expect(receipts).toHaveLength(2);
    expect(flow.jar.size).toBe(0);
    expect(popup.close).toHaveBeenCalledOnce();
    for (let index = 0; index < pages.length; index++) {
      const receipt = receipts[index], page = pages[index];
      const sealed = await createQRedSeals({ content: page.content, pageContext: { pageNumber: index + 1, pageCount: 2, documentRoot: page.metadata.document_root }, attestation: receipt });
      await expect(verifyQRedSeals(sealed.seals, "", trusted)).resolves.toMatchObject({ status: "VALID", identity_authenticated: true, attestation: provider, identity: { provider, name_source: provider }, page_number: index + 1 });
      const original = decodeEnvelope(qrPayloadBytes(sealed.seals[0]));
      for (const other of providers.filter(name => name !== provider)) {
        const changed = { ...original, identity: { ...original.identity, provider: other, name_source: other } };
        const record = encodeEnvelope(changed, original.signature, original.data, original.encoding);
        await expect(verifyQRedSeals([sealString(record)], "", trusted)).resolves.toMatchObject({ status: "INVALID", identity_authenticated: false });
      }
      const wire = JSON.stringify(flow.sent);
      for (const hidden of [page.content, page.metadata.document_root, seed]) expect(wire).not.toContain(hidden);
    }
  });

  it("rejects provider substitution, client changes and renamed cross-provider cookies", async () => {
    const flow = fixture(provider);
    const session = await (await flow.post("/api/auth/" + provider + "/start", { commitments: [fingerprint] })).json();
    const credentials = { id: session.id, secret: session.secret };
    for (const other of providers.filter(name => name !== provider)) {
      const callback = await flow.handle(new Request(origin + "/api/auth/" + other + "/callback?state=" + session.id + "&code=unused", { headers: { Cookie: flow.cookie() } }));
      expect(callback.status).toBe(403);
    }
    expect(flow.exchange).not.toHaveBeenCalled();
    await flow.login(session);
    const ownCookie = flow.cookie();
    for (const other of providers.filter(name => name !== provider)) {
      // Renaming the cookie cannot defeat the cryptographic provider binding.
      const fakeCookie = ownCookie.replace(/__Host-qred-(?:microsoft-|amazon-)?receipt-/, "__Host-qred-" + (other === "google" ? "" : other + "-") + "receipt-");
      const response = await flow.handle(new Request(origin + "/api/attest/" + other, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: fakeCookie },
        body: JSON.stringify({ ...credentials, commitments: [fingerprint], index: 0 }),
      }), { ...env, ["QRED_" + other.toUpperCase() + "_CLIENT_ID"]: provider + "-client" });
      expect(response.status).toBe(403);
      await flow.post("/api/auth/" + other + "/finish", credentials);
      expect(flow.cookie()).toBe(ownCookie);
    }
    const clientField = "QRED_" + provider.toUpperCase() + "_CLIENT_ID";
    expect((await flow.post("/api/auth/" + provider + "/status", credentials, { ...env, [clientField]: "changed-client" })).status).toBe(403);
    const response = await flow.post("/api/auth/" + provider + "/status", credentials);
    expect((await response.json()).identity.provider).toBe(provider);
    const sessionData = await cookieSessions(env, origin, () => epoch, provider, provider + "-client").read(new Request(origin, { headers: { Cookie: ownCookie } }), session.id, "receipt");
    expect(JSON.stringify(sessionData)).not.toMatch(/opaque-amazon-token|synthetic-id-token|pkce|nonce/);
  });

  it("closes and clears the client session when the server redirects to a different provider", async () => {
    const popup = { location: {}, close: vi.fn() }, paths = [];
    const fetchImpl = async path => {
      paths.push(path);
      return Response.json({ id: "id", secret: "secret", authorize_url: "https://attacker.example/login" });
    };
    await expect(attestPagesWithAccount(provider, [{ content: "Private", metadata: {} }], { popup, fetchImpl, trusted })).rejects.toThrow("Unexpected sign-in address");
    expect(popup.location.href).toBeUndefined();
    expect(popup.close).toHaveBeenCalledOnce();
    expect(paths).toEqual(["/api/auth/" + provider + "/start", "/api/auth/" + provider + "/finish"]);
  });
});

it("advertises providers independently and rejects unknown routes", async () => {
  const { handle } = fixture("google");
  const response = await handle(new Request(origin + "/api/auth/config"), env);
  expect(await response.json()).toEqual({ google: true, microsoft: true, amazon: true });
  expect((await handle(new Request(origin + "/api/auth/unknown/start"))).status).toBe(404);
  expect((await handle(new Request(origin + "/api/auth/meta/start"))).status).toBe(404);
  expect((await handle(new Request(origin + "/api/auth/google/extra/path"))).status).toBe(404);
});

it("rejects a status identity from another provider before requesting attestations", async () => {
  const popup = { location: {}, close: vi.fn() }, paths = [];
  const fetchImpl = async path => {
    paths.push(path);
    if (path.endsWith("/start")) return Response.json({ id: "id", secret: "secret", authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize" });
    return Response.json({ status: "ready", identity: { provider: "google" }, timestamp: new Date(epoch).toISOString() });
  };
  await expect(attestPagesWithAccount("microsoft", [{ content: "Private", metadata: {} }], { popup, fetchImpl, trusted })).rejects.toThrow("provider changed");
  expect(paths).toEqual(["/api/auth/microsoft/start", "/api/auth/microsoft/status", "/api/auth/microsoft/finish"]);
  expect(popup.close).toHaveBeenCalledOnce();
});


it.each(["google", "microsoft", "amazon"])("enforces a five-minute absolute %s PDF sign-in expiry", async provider => {
  const flow = fixture(provider);
  const started = await (await flow.post("/api/auth/" + provider + "/start",
    { commitments: [fingerprint] })).json();
  const cookie = flow.cookie(), clientId = provider + "-client";
  const readAt = async time => cookieSessions(env, origin, () => time, provider, clientId)
    .read(new Request(origin, { headers: { Cookie: cookie } }), started.id, "request");
  expect(SESSION_SECONDS).toBe(300);
  const pending = await readAt(epoch);
  expect(pending.exp - pending.iat).toBe(300);
  await expect(readAt(epoch + 299_000)).resolves.toMatchObject({ status: "pending" });
  await expect(readAt(epoch + 301_000)).rejects.toThrow();
  // The encrypted cookie must not grant a fresh 5-minute window upon reread.
  expect(pending.exp).toBe(Math.floor(epoch / 1000) + 300);
});

it("rejects Microsoft SPA completion without the authenticated pending cookie", async () => {
  const flow = fixture("microsoft");
  const session = await (await flow.post("/api/auth/microsoft/start", { commitments: [fingerprint] })).json();
  const noCookie = await flow.handle(new Request(origin + "/api/auth/microsoft/complete", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ id: session.id, id_token: "forged-id-token" }),
  }));
  expect(noCookie.status).toBe(403);
  const crossOrigin = await flow.handle(new Request(origin + "/api/auth/microsoft/complete", {
    method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json", Cookie: flow.cookie() },
    body: JSON.stringify({ id: session.id, id_token: "forged-id-token" }),
  }));
  expect(crossOrigin.status).toBe(403);
  const forged = await flow.post("/api/auth/microsoft/complete", { id: session.id, id_token: "forged-id-token" });
  expect(forged.status).toBe(403);
  const status = await (await flow.post("/api/auth/microsoft/status", { id: session.id, secret: session.secret })).json();
  expect(status.status).toBe("failed");
  expect(flow.exchange).not.toHaveBeenCalled();
});



it("returns safe and actionable Microsoft failure categories without relaxing session checks", async () => {
  const flow = fixture("microsoft");
  const started = await (await flow.post("/api/auth/microsoft/start", { commitments: [fingerprint] })).json();
  const nonce = new URL(started.authorize_url).searchParams.get("nonce");
  const identity = { name: "Account Name", email: "account@example.org",
    sub: "account-user", tid: tenant, nonce, iat: epoch / 1000 };
  const callback = await flow.handle(new Request(origin + "/api/auth/microsoft/callback?state=" +
    started.id + "&code=synthetic-code", { headers: { Cookie: flow.cookie() } }));
  expect(callback.status).toBe(200);
  expect(await callback.text()).toContain("login.microsoftonline.com/common/oauth2/v2.0/token");

  const cases = [
    {
      name: "missing email",
      verify: async () => ({ ...identity, email: undefined }),
      expected: "Microsoft did not share an email address",
    },
    {
      name: "nonce mismatch",
      verify: async () => ({ ...identity, nonce: "different-document" }),
      expected: "Microsoft identity nonce did not match this document sign-in request",
    },
    {
      name: "bad signature",
      verify: async () => { throw Object.assign(new Error("secret=id-token-PRIVATE"), { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" }); },
      expected: "Microsoft identity signature is invalid",
    },
    {
      name: "no signing key",
      verify: async () => { throw Object.assign(new Error("secret=PRIVATE"), { code: "ERR_JWKS_NO_MATCHING_KEY" }); },
      expected: "Microsoft signing key not found",
    },
    {
      name: "unrecognized provider error",
      verify: async () => { throw new Error("secret=id-token-PRIVATE"); },
      expected: "Microsoft identity token or signing keys could not be verified",
    },
  ];
  for (const scenario of cases) {
    const handler = createAccountAuth({ trusted, now: () => epoch, verifyTokens: { microsoft: scenario.verify } });
    const result = await handler(new Request(origin + "/api/auth/microsoft/complete", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Cookie: flow.cookie() },
      body: JSON.stringify({ id: started.id, id_token: "private-test-id-token" }),
    }), env);
    expect(result.status, scenario.name).toBe(403);
    const body = await result.json();
    expect(body.error, scenario.name).toContain(scenario.expected);
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(JSON.stringify(body)).not.toContain("private-test-id-token");
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(result.headers.getSetCookie().some(item => item.includes("microsoft-request-"))).toBe(true);
  }
});

it("accepts a recent SSO ID token with matching nonce and preserves PDF-bound receipt", async () => {
  const flow = fixture("microsoft");
  const session = await (await flow.post("/api/auth/microsoft/start", { commitments: [fingerprint] })).json();
  const nonce = new URL(session.authorize_url).searchParams.get("nonce");
  const handler = createAccountAuth({
    trusted, now: () => epoch,
    verifyTokens: { microsoft: async () => ({
      name: "Microsoft Profile", email: "account@example.org", sub: "account-id", tid: tenant,
      nonce, iat: epoch / 1000 - 120,
    }) },
  });
  const result = await handler(new Request(origin + "/api/auth/microsoft/complete", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: flow.cookie() },
    body: JSON.stringify({ id: session.id, id_token: "synthetic-id-token" }),
  }), env);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ status: "ready" });
  const receiptCookie = result.headers.getSetCookie().find(value => value.includes("microsoft-receipt-"));
  expect(receiptCookie).toBeTruthy();
  expect(receiptCookie).toContain("HttpOnly");
  expect(receiptCookie).toContain("SameSite=Lax");
  expect(receiptCookie).not.toContain("synthetic-id-token");
  // No independent identity or different document gets a receipt without
  // this verified session cookie and matching randomized commitment.
  const response = await handler(new Request(origin + "/api/auth/microsoft/status", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json",
      Cookie: receiptCookie.split(";")[0] },
    body: JSON.stringify({ id: session.id, secret: session.secret }),
  }), env);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "ready", identity: { provider: "microsoft", email: "account@example.org" },
  });
});

describe.each(providers)("%s prepared native-link handoff", provider => {
  it("verifies and attests a prepared session without a popup handle", async () => {
    const flow = fixture(provider);
    const pages = [{ content: "Native link synthetic document",
      metadata: { pdf: true, page_number: 1, page_count: 1 } }];
    // Native <a target=_blank rel=noopener> deliberately has no window.opener,
    // but signed cookies and server-side status checks must still work.
    const preparedSession = await beginAccountSignIn(provider, pages, { fetchImpl: flow.clientFetch });
    const receipts = await attestPagesWithAccount(provider, pages, {
      popup: null, preparedSession, fetchImpl: flow.clientFetch, trusted,
    });
    expect(receipts).toHaveLength(1);
    expect(flow.jar.size).toBe(0);
    expect(flow.sent.map(item => item.path)).toContain("/api/auth/" + provider + "/status");
    expect(flow.sent.map(item => item.path)).toContain("/api/attest/" + provider);
    const signed = await createQRedSeals({
      content: pages[0].content, attestation: receipts[0],
      pageContext: { pageNumber: 1, pageCount: 1 },
    });
    await expect(verifyQRedSeals(signed.seals, "", trusted))
      .resolves.toMatchObject({ status: "VALID", identity_authenticated: true, identity: { provider } });
    expect(JSON.stringify(flow.sent)).not.toContain(pages[0].content);
  });
});

it.each(["google", "amazon"])("closes an authenticated %s native-link tab even without window.opener", async provider => {
  const flow = fixture(provider);
  const session = await (await flow.post("/api/auth/" + provider + "/start", { commitments: [fingerprint] })).json();
  const callback = await flow.login(session);
  expect(callback.status).toBe(200);
  const html = await callback.text();
  expect(html).toContain("Sign-in completed.");
  expect(html).toContain('role="status"');
  expect(html).not.toContain('role="alert"');
  expect(html).toContain('id="close-qred-sign-in"');
  expect(html).toContain('id="close-qred-help"');
  expect(html).toContain("tab switcher");
  expect(html).toContain("Do not reload that tab");
  expect(html).toContain("Try to close sign-in tab");
  // A blocked close() must display a useful manual fallback. Native OAuth
  // tabs deliberately have no opener, and their closing policy is browser-owned.
  expect(html).toContain('closeButton.addEventListener("click",tryClose)');
  expect(html).toContain('setTimeout(function(){closeHelp.hidden=false;},300)');
  expect(html).toMatch(/try\{if\(window\.opener\)\{window\.opener\.postMessage\(/);
  expect(html).toMatch(/\}\}catch\(e\)\{\}tryClose\(\);/);
  expect(html).not.toContain(session.secret);
  expect(callback.headers.get("Cache-Control")).toBe("no-store");
  expect(callback.headers.get("Referrer-Policy")).toBe("no-referrer");
});

it("HTML-escapes a provider-originated error before showing it in the callback", async () => {
  const flow = fixture("google");
  const session = await (await flow.post("/api/auth/google/start", { commitments: [fingerprint] })).json();
  const escaped = createAccountAuth({
    trusted, now: () => epoch,
    fetchImpl: async () => Response.json({ id_token: "synthetic-jwt" }),
    verifyTokens: { google: async () => {
      const { RequestError } = await import("./authErrors.js");
      throw new RequestError('Invalid profile <img src=x onerror=alert(1)> & "quoted"', 403);
    } },
  });
  const callback = await escaped(new Request(origin + "/api/auth/google/callback?state=" +
    session.id + "&code=one-use-code", { headers: { Cookie: flow.cookie() } }), env);
  const html = await callback.text();
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).toContain("&amp; &quot;quoted&quot;");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("window.close()");
  expect(html).not.toContain("close-qred-sign-in");
});


