import { beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { authorizationUrl, exchangeIdentity, providerConfiguration, providerIdentity, validateMicrosoftSpaToken, verifyMetaAccessToken, safeMetaErrorDetails, verifyMetaIdToken, verifyMicrosoftIdToken } from "./authProviders.js";
import { allowedAuthorizationUrl } from "../src/authProviders.js";

const now = Date.parse("2026-10-25T12:00:00Z"), seconds = now / 1000;
const tenant = "11111111-2222-3333-4444-555555555555";
const microsoftIssuer = "https://login.microsoftonline.com/" + tenant + "/v2.0";
let rsa, jwk, keys;
beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);
  rsa = await generateKeyPair("RS256", { extractable: true });
  jwk = { ...await exportJWK(rsa.publicKey), kid: "test-key", alg: "RS256", issuer: "https://login.microsoftonline.com/{tenantid}/v2.0" };
  keys = createLocalJWKSet({ keys: [jwk] });
});
const claims = provider => ({ sub: "account-123", name: "Profile Name", email: "profile@example.org", nonce: "nonce",
  iat: seconds, exp: seconds + 3600, aud: "test-client",
  iss: provider === "microsoft" ? microsoftIssuer : "https://www.facebook.com",
  ...(provider === "microsoft" ? { tid: tenant, ver: "2.0" } : {}) });
const token = payload => new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(rsa.privateKey);
const verify = { microsoft: verifyMicrosoftIdToken, meta: verifyMetaIdToken };

describe.each(["microsoft", "meta"])("%s identity tokens", provider => {
  it("accepts a signed identity and rejects wrong issuer, audience, time, nonce presence and signature", async () => {
    await expect(verify[provider](await token(claims(provider)), "test-client", now, keys)).resolves.toMatchObject({ sub: "account-123" });
    const invalid = [{ iss: "https://attacker.example" }, { aud: "another-app" }, { aud: ["test-client", "another-app"] },
      { azp: "another-app" }, { exp: seconds - 31 }, { exp: undefined }, { nonce: undefined }, { sub: undefined },
      { iat: seconds - 301 }, { iat: seconds + 31 }, { iat: seconds + 0.5 }];
    if (provider === "microsoft") invalid.push({ tid: "not-a-guid" }, { tid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, { ver: "1.0" });
    for (const change of invalid) await expect(verify[provider](await token({ ...claims(provider), ...change }), "test-client", now, keys)).rejects.toThrow();
    const forged = (await token(claims(provider))).split(".");
    forged[2] = (forged[2][0] === "A" ? "B" : "A") + forged[2].slice(1);
    await expect(verify[provider](forged.join("."), "test-client", now, keys)).rejects.toThrow();
  });
});

it("binds Microsoft's signed ID token to the pending nonce and request time", async () => {
  for (const change of [{ nonce: "different-request" }, { iat: seconds - 31 }]) {
    const idToken = await token({ ...claims("microsoft"), ...change });
    await expect(validateMicrosoftSpaToken(idToken, { clientId: "test-client" },
      { nonce: "nonce", iat: seconds }, () => now,
      { microsoft: (value, client, time) => verifyMicrosoftIdToken(value, client, time, keys) })).rejects.toThrow();
  }
});


it("checks the Microsoft signing key's tenant scope, not just the token issuer", async () => {
  const value = await token(claims("microsoft"));
  for (const issuer of [undefined, "https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0", "https://attacker.example/{tenantid}/v2.0"]) {
    await expect(verifyMicrosoftIdToken(value, "test-client", now, createLocalJWKSet({ keys: [{ ...jwk, issuer }] }))).rejects.toThrow("signing key");
  }
  await expect(verifyMicrosoftIdToken(value, "test-client", now, createLocalJWKSet({ keys: [{ ...jwk, issuer: microsoftIssuer }] }))).resolves.toBeTruthy();
  const first = providerIdentity("microsoft", claims("microsoft"));
  const second = providerIdentity("microsoft", { ...claims("microsoft"), tid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  expect(first.subject).toBe(tenant + ":account-123");
  expect(first.subject).not.toBe(second.subject);
});

it.each(["microsoft", "meta", "amazon"])("requires %s to supply both email and profile name", provider => {
  const user = { ...claims(provider), tid: tenant, user_id: "amazon-account" };
  expect(providerIdentity(provider, user)).toMatchObject({ provider, name_source: provider });
  for (const change of [{ email: undefined, preferred_username: "not-an-email-proof@example.org" }, { email: "" }, { name: undefined }, { name: " " }, { name: "spoof\u202e" }]) {
    expect(() => providerIdentity(provider, { ...user, ...change })).toThrow();
  }
});


describe("standard Facebook Login access-token verification", () => {
  const config = { clientId: "facebook-app", clientSecret: "server-only-secret", graphVersion: "v26.0" };
  const good = { access_token: "opaque-user-token", token_type: "bearer", expires_in: 3600 };
  async function authenticate(changes = {}) {
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      if (url.startsWith("https://graph.facebook.com/v26.0/oauth/access_token?")) {
        const params = new URL(url).searchParams;
        expect(params.get("client_id")).toBe(config.clientId);
        expect(params.get("client_secret")).toBe(config.clientSecret);
        expect(params.get("redirect_uri")).toBe("https://qred.test/api/auth/meta/callback");
        expect(params.has("code_verifier")).toBe(false);
        return changes.tokenHttpError ? new Response("error", { status: 403 }) :
          Response.json({ ...good, ...changes.token });
      }
      if (url.startsWith("https://graph.facebook.com/v26.0/debug_token?")) {
        const params = new URL(url).searchParams;
        expect(params.get("input_token")).toBe("opaque-user-token");
        expect(params.get("access_token")).toBe("facebook-app|server-only-secret");
        return changes.debugHttpError ? new Response("error", { status: 403 }) :
          Response.json({ data: { is_valid: true, app_id: "facebook-app", type: "USER",
            user_id: "1234567890", expires_at: seconds + 3600, scopes: ["email"], ...changes.debug } });
      }
      if (url.startsWith("https://graph.facebook.com/v26.0/me?")) {
        const params = new URL(url).searchParams;
        expect(params.get("fields")).toBe("id,name,email");
        expect(params.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
        const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.clientSecret),
          { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const mac = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key,
          new TextEncoder().encode("opaque-user-token"))), b => b.toString(16).padStart(2, "0")).join("");
        expect(params.get("appsecret_proof")).toBe(mac);
        expect(options.headers.Authorization).toBe("Bearer opaque-user-token");
        return changes.profileHttpError ? new Response("error", { status: 403 }) :
          Response.json({ id: "1234567890", name: "Facebook Profile", email: "person@example.org", ...changes.profile });
      }
      throw new Error("Unexpected Meta endpoint " + url);
    };
    const result = await exchangeIdentity("meta", config, {
      code: "one-use-code", origin: "https://qred.test", pending: { pkce: "verifier" },
      now: () => now, fetchImpl,
    });
    return { result, requests };
  }
  it("authenticates a Facebook account using app-bound introspection and a matching profile", async () => {
    const { result, requests } = await authenticate();
    expect(result).toEqual({ identity: { provider: "meta", name_source: "meta", name: "Facebook Profile",
      email: "person@example.org", subject: "1234567890" } });
    expect(requests).toHaveLength(3);
    expect(requests.every(({ options }) => options.redirect === "error")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("opaque-user-token");
    expect(JSON.stringify(result)).not.toContain("server-only-secret");
  });
  it.each([
    { token: { access_token: "" } }, { token: { access_token: undefined } },
    { token: { token_type: "MAC" } }, { token: { expires_in: 0 } },
    { debug: { app_id: "attacker-app" } }, { debug: { is_valid: false } },
    { debug: { type: "PAGE" } }, { debug: { expires_at: seconds - 1 } },
    { debug: { user_id: "" } }, { debug: { scopes: ["public_profile"] } },
    { profile: { id: "another-user" } }, { profile: { name: "" } },
    { profile: { email: undefined } }, { profile: { email: "" } },
    { tokenHttpError: true }, { debugHttpError: true }, { profileHttpError: true },
  ])("rejects invalid Facebook OAuth evidence without creating a signing identity: %j", async changes => {
    await expect(authenticate(changes)).rejects.toThrow();
  });
  it("does not trust an experimental id_token in place of a verified Meta access token", async () => {
    await expect(authenticate({ token: { access_token: undefined, id_token: "unverified" } })).rejects.toThrow("usable");
  });
});

describe("Login with Amazon", () => {
  const config = { clientId: "amazon-app", clientSecret: "server-secret" };
  async function exchange(changes = {}) {
    const requests = [];
    const result = await exchangeIdentity("amazon", config, {
      code: "one-use-code", origin: "https://qred.test", pending: { pkce: "verifier" }, now: () => now,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        if (url === "https://api.amazon.com/auth/o2/token") {
          expect(options.method).toBe("POST");
          expect(Object.fromEntries(options.body)).toEqual({ code: "one-use-code", client_id: "amazon-app", client_secret: "server-secret",
            redirect_uri: "https://qred.test/api/auth/amazon/callback", grant_type: "authorization_code", code_verifier: "verifier" });
          return Response.json({ access_token: "access-token", token_type: "bearer", expires_in: 3600, ...changes.token });
        }
        if (url === "https://api.amazon.com/auth/o2/tokeninfo?access_token=access-token") return Response.json({
          iss: "https://www.amazon.com", aud: "amazon-app", user_id: "amazon-account", exp: 3597, ...changes.info });
        expect(url).toBe("https://api.amazon.com/user/profile");
        expect(options.headers.Authorization).toBe("Bearer access-token");
        return Response.json({ user_id: "amazon-account", name: "Amazon Name", email: "profile@example.org", ...changes.profile });
      },
    });
    return { result, requests };
  }
  it("checks token audience and profile subject without inventing email verification or an ID token", async () => {
    const { result, requests } = await exchange();
    expect(result).toEqual({ identity: { provider: "amazon", name_source: "amazon", subject: "amazon-account", name: "Amazon Name", email: "profile@example.org" } });
    expect(requests).toHaveLength(3);
    expect(requests.every(request => request.options.redirect === "error")).toBe(true);
  });
  it.each([
    { token: { token_type: "MAC" } }, { token: { expires_in: 0 } }, { token: { access_token: "" } },
    { info: { aud: "another-app" } }, { info: { iss: "https://attacker.example" } }, { info: { exp: 0 } },
    { profile: { user_id: "another-account" } }, { profile: { email: undefined } }, { profile: { name: undefined } },
  ])("rejects untrusted or incomplete Amazon responses %j", async changes => {
    await expect(exchange(changes)).rejects.toThrow();
  });
});

it.each([
  ["google", "https://accounts.google.com/o/oauth2/v2/auth", "openid email profile"],
  ["microsoft", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "openid email profile"],
  ["meta", "https://www.facebook.com/v26.0/dialog/oauth", "public_profile,email"],
  ["amazon", "https://www.amazon.com/ap/oa", "profile"],
])("restricts %s authorization to its provider, code flow and PKCE", (provider, endpoint, scope) => {
  const url = new URL(authorizationUrl(provider, { clientId: "client", graphVersion: "v26.0" }, { origin: "https://qred.test", id: "state", nonce: "nonce", challenge: "challenge" }));
  expect(url.origin + url.pathname).toBe(endpoint);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    scope, response_type: "code", state: "state", redirect_uri: "https://qred.test/api/auth/" + provider + "/callback",
  });
  if (provider === "meta") {
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("code_challenge_method")).toBe(false);
    expect(url.searchParams.has("nonce")).toBe(false);
    // A top-level browser tab should render the provider's default responsive
    // dialog, not force the desktop popup-only view or unnecessary re-consent.
    expect(url.searchParams.has("display")).toBe(false);
    expect(url.searchParams.has("auth_type")).toBe(false);
  } else {
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
  }
  expect(allowedAuthorizationUrl(provider, url.href)).toBe(true);
  for (const other of ["https://attacker.example/", endpoint.replace("https:", "http:"), endpoint + "#credentials", endpoint.replace("https://", "https://attacker@")]) expect(allowedAuthorizationUrl(provider, other)).toBe(false);
});

it("requires each provider's own configuration and bounds the Meta API version", () => {
  expect(providerConfiguration("microsoft", { QRED_GOOGLE_CLIENT_ID: "google", QRED_GOOGLE_CLIENT_SECRET: "secret" })).toBeNull();
  expect(providerConfiguration("microsoft", { QRED_MICROSOFT_CLIENT_ID: "public-client-id" }))
    .toMatchObject({ clientId: "public-client-id" });
  expect(providerConfiguration("meta", { QRED_META_APP_ID: "app", QRED_META_APP_SECRET: "secret", QRED_META_GRAPH_VERSION: "../v26.0" })).toBeNull();
  expect(providerConfiguration("toString", {})).toBeNull();
});


describe("redacted Meta token-exchange diagnostics", () => {
  const config = { clientId: "facebook-app", clientSecret: "server-only-secret", graphVersion: "v26.0" };
  const context = { code: "one-use-code", origin: "https://qred.test", pending: { pkce: "secret-local-verifier" }, now: () => now };
  it("reports only Meta's numeric HTTP/error/subcode, not reflected credentials or free-form text", async () => {
    const upstreamMessage = "Client secret server-only-secret, code one-use-code, do not show";
    const exchange = exchangeIdentity("meta", config, {
      ...context, fetchImpl: async () => Response.json({ error: { code: 100, error_subcode: 36008, message: upstreamMessage,
        fbtrace_id: "MetaTraceSecretDoNotEcho" } }, { status: 400 }),
    });
    await expect(exchange).rejects.toThrow(/HTTP 400; Meta error 100; subcode 36008/);
    await expect(exchange).rejects.not.toThrow(upstreamMessage);
    expect(safeMetaErrorDetails(400, { error: { code: 100, error_subcode: 36008, message: upstreamMessage } }))
      .toBe(" (HTTP 400; Meta error 100; subcode 36008)");
  });
  it("ignores provider-controlled strings, arrays and invalid numeric codes", () => {
    expect(safeMetaErrorDetails(403, { error: { code: "100; secret", error_subcode: -3, message: "token" } }))
      .toBe(" (HTTP 403)");
    expect(safeMetaErrorDetails(999, { error: { code: 100000000000 } })).toBe("");
  });
  it("fails without exposing network errors or malformed upstream responses", async () => {
    for (const fetchImpl of [
      async () => { throw new Error("leaked client_secret server-only-secret"); },
      async () => new Response("private token=secret", { status: 400 }),
    ]) {
      try {
        await exchangeIdentity("meta", config, { ...context, fetchImpl });
        throw new Error("Expected a failure");
      } catch (error) {
        expect(error.message).toContain("Facebook rejected QRed's login code exchange");
        expect(error.message).not.toContain("server-only-secret");
        expect(error.message).not.toContain("private token");
      }
    }
  });
});
