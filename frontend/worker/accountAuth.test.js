import { beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createAccountAuth } from "./accountAuth.js";
import { attestPagesWithAccount } from "../src/accountSealing.js";
import { cookieSessions } from "./accountSession.js";
import { createQRedSeals } from "../src/qredSealer.js";
import { verifyQRedSeals } from "../src/qredVerifier.js";
import { decodeEnvelope, encodeBase64Url, encodeEnvelope, qrPayloadBytes, sealString, sha256, utf8 } from "../src/sealFormat.js";

const origin = "https://qred.test", epoch = Date.parse("2026-10-25T12:00:00Z");
const tenant = "11111111-2222-3333-4444-555555555555";
const seed = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", keyId = "da522162396ab2d0";
const trusted = { [keyId]: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q" };
const providers = ["google", "microsoft", "meta", "amazon"];
const env = { QRED_ORIGIN: origin, QRED_ATTESTATION_PRIVATE_KEY: seed, QRED_ATTESTATION_KEY_ID: keyId,
  QRED_GOOGLE_CLIENT_ID: "google-client", QRED_GOOGLE_CLIENT_SECRET: "google-secret",
  QRED_MICROSOFT_CLIENT_ID: "microsoft-client",
  QRED_META_APP_ID: "meta-client", QRED_META_APP_SECRET: "meta-secret",
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
    if (provider === "meta" && url.startsWith("https://graph.facebook.com/v26.0/debug_token?")) {
      const query = new URL(url).searchParams;
      expect(query.get("input_token")).toBe("opaque-meta-token");
      expect(query.get("access_token")).toBe("meta-client|meta-secret");
      return Response.json({ data: { app_id: "meta-client", user_id: "1234567890",
        is_valid: true, type: "USER", expires_at: epoch / 1000 + 3600, scopes: ["email"] } });
    }
    if (provider === "meta" && url.startsWith("https://graph.facebook.com/v26.0/me?")) {
      expect(options.headers.Authorization).toBe("Bearer opaque-meta-token");
      expect(new URL(url).searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
      return Response.json({ id: "1234567890", name: "Profile Name", email: "user@gmail.com" });
    }
    if (url.startsWith("https://api.amazon.com/auth/o2/tokeninfo?")) return Response.json({
      iss: "https://www.amazon.com", aud: "amazon-client", user_id: "amazon-user", exp: 3599 });
    if (url === "https://api.amazon.com/user/profile") return Response.json({ user_id: "amazon-user", name: "Amazon Profile", email: "user@example.org" });
    const params = provider === "meta" ? new URL(url).searchParams : options.body;
    expect(params.get("client_id")).toBe(provider + "-client");
    expect(params.get("client_secret")).toBe(provider + "-secret");
    expect(params.get("redirect_uri")).toBe(origin + "/api/auth/" + provider + "/callback");
    if (provider === "meta") {
      expect(params.has("code_verifier")).toBe(false);
      expect(authorization.searchParams.has("code_challenge")).toBe(false);
    } else {
      expect(encodeBase64Url(await sha256(utf8.encode(params.get("code_verifier")))))
        .toBe(authorization.searchParams.get("code_challenge"));
    }
    idTokenClaims = { name: "Profile Name", email: "user@gmail.com", email_verified: true, sub: "account-user", tid: tenant,
      nonce: authorization.searchParams.get("nonce"), iat: epoch / 1000 };
    return Response.json(provider === "amazon" ? { access_token: "opaque-amazon-token", token_type: "bearer", expires_in: 3600 } :
      provider === "meta" ? { access_token: "opaque-meta-token", token_type: "bearer", expires_in: 3600 } :
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
      for (const hidden of [page.content, page.metadata.document_root, encodeBase64Url(receipt.salt), seed]) expect(wire).not.toContain(hidden);
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
      const fakeCookie = ownCookie.replace(/__Host-qred-(?:microsoft-|meta-|amazon-)?receipt-/, "__Host-qred-" + (other === "google" ? "" : other + "-") + "receipt-");
      const response = await flow.handle(new Request(origin + "/api/attest/" + other, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: fakeCookie },
        body: JSON.stringify({ ...credentials, commitments: [fingerprint], index: 0 }),
      }), { ...env, [other === "meta" ? "QRED_META_APP_ID" : "QRED_" + other.toUpperCase() + "_CLIENT_ID"]: provider + "-client" });
      expect(response.status).toBe(403);
      await flow.post("/api/auth/" + other + "/finish", credentials);
      expect(flow.cookie()).toBe(ownCookie);
    }
    const clientField = provider === "meta" ? "QRED_META_APP_ID" : "QRED_" + provider.toUpperCase() + "_CLIENT_ID";
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
  const response = await handle(new Request(origin + "/api/auth/config"), { ...env, QRED_META_APP_SECRET: "" });
  expect(await response.json()).toEqual({ google: true, microsoft: true, meta: false, amazon: true });
  expect((await handle(new Request(origin + "/api/auth/unknown/start"))).status).toBe(404);
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


it("does not expose Facebook Graph access tokens in authenticated session status", async () => {
  const flow = fixture("meta");
  // This check exercises callback error propagation without disclosing the
  // OAuth code or Graph access token to the browser response.
  const started = await (await flow.post("/api/auth/meta/start", { commitments: [fingerprint] })).json();
  const result = await flow.login(started);
  expect(result.status).toBe(200); // Error callback page is intentionally HTTP 200.
  const status = await (await flow.post("/api/auth/meta/status", { id: started.id, secret: started.secret })).json();
  expect(status.status).toBe("ready");
  expect(JSON.stringify(status)).not.toContain("opaque-meta-token");
  expect(JSON.stringify(status)).not.toContain("one-use-code");
});

it("keeps a rejected Facebook callback open with sanitized error details instead of silently closing", async () => {
  const flow = fixture("meta");
  const session = await (await flow.post("/api/auth/meta/start", { commitments: [fingerprint] })).json();
  const upstream = createAccountAuth({
    trusted, now: () => epoch,
    fetchImpl: async () => Response.json({ error: {
      code: 100, error_subcode: 36008,
      message: "Hidden OAuth code one-use-code, secret meta-secret, <script>alert(1)</script>",
    } }, { status: 400 }),
  });
  const callback = await upstream(new Request(origin + "/api/auth/meta/callback?state=" +
    session.id + "&code=one-use-code", { headers: { Cookie: flow.cookie() } }), env);
  expect(callback.status).toBe(200);
  const html = await callback.text();
  expect(html).toContain('role="alert"');
  expect(html).toContain("Sign-in could not be completed.");
  expect(html).toContain("Meta error 100; subcode 36008");
  expect(html).not.toContain("one-use-code");
  expect(html).not.toContain("meta-secret");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("window.close()");
  expect(callback.headers.get("Cache-Control")).toBe("no-store");
  expect(callback.headers.get("Referrer-Policy")).toBe("no-referrer");
  const failedCookie = callback.headers.getSetCookie()[0].split(";")[0];
  const status = await flow.handle(new Request(origin + "/api/auth/meta/status", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: failedCookie },
    body: JSON.stringify({ id: session.id, secret: session.secret }),
  }));
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ status: "failed",
    error: expect.stringContaining("Meta error 100") });
});

it.each(["google", "meta", "amazon"])("closes a successful %s popup only after sign-in completed", async provider => {
  const flow = fixture(provider);
  const session = await (await flow.post("/api/auth/" + provider + "/start", { commitments: [fingerprint] })).json();
  const callback = await flow.login(session);
  expect(callback.status).toBe(200);
  const html = await callback.text();
  expect(html).toContain("Sign-in completed.");
  expect(html).not.toContain('role="alert"');
  expect(html).toContain("window.close()");
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
});


it("does not close a failed provider window from the client protocol cleanup", async () => {
  const popup = { location: {}, close: vi.fn() }, paths = [];
  const fetchImpl = async path => {
    paths.push(path);
    if (path.endsWith("/start")) return Response.json({
      id: "synthetic-session", secret: "synthetic-secret",
      authorize_url: "https://www.facebook.com/v26.0/dialog/oauth",
    });
    if (path.endsWith("/status")) return Response.json({
      status: "failed", error: "Facebook rejected QRed's login code exchange (HTTP 400; Meta error 100)",
    });
    if (path.endsWith("/finish")) return Response.json({ finished: true });
    throw new Error("Unexpected request path " + path);
  };
  await expect(attestPagesWithAccount("meta", [{ content: "Synthetic text", metadata: {} }],
    { popup, fetchImpl, trusted })).rejects.toThrow("Facebook rejected");
  expect(popup.close).not.toHaveBeenCalled();
  expect(popup.location.href).toBe("https://www.facebook.com/v26.0/dialog/oauth");
  expect(paths).toEqual(["/api/auth/meta/start", "/api/auth/meta/status", "/api/auth/meta/finish"]);
});
