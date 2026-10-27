import { beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { authorizationUrl, exchangeIdentity, providerConfiguration, providerIdentity, verifyMetaIdToken, verifyMicrosoftIdToken } from "./authProviders.js";
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
  it("checks the nonce and token issuance against the pending request during exchange", async () => {
    for (const change of [{ nonce: "different-request" }, { iat: seconds - 31 }]) {
      await expect(exchangeIdentity(provider, { clientId: "test-client", clientSecret: "secret", graphVersion: "v26.0" }, {
        code: "code", origin: "https://qred.test", pending: { nonce: "nonce", pkce: "verifier", iat: seconds }, now: () => now,
        fetchImpl: async () => Response.json({ id_token: await token({ ...claims(provider), ...change }) }),
        verifyTokens: { [provider]: (value, client, time) => verify[provider](value, client, time, keys) },
      })).rejects.toThrow();
    }
  });
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

it("fails closed when Meta does not return the requested OIDC identity token", async () => {
  await expect(exchangeIdentity("meta", { clientId: "app", clientSecret: "secret", graphVersion: "v26.0" }, {
    code: "code", origin: "https://qred.test", pending: {}, now: () => now,
    fetchImpl: async () => Response.json({ access_token: "opaque-token" }),
  })).rejects.toThrow("identity token");
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
  ["meta", "https://www.facebook.com/v26.0/dialog/oauth", "openid public_profile email"],
  ["amazon", "https://www.amazon.com/ap/oa", "profile"],
])("restricts %s authorization to its provider, code flow and PKCE", (provider, endpoint, scope) => {
  const url = new URL(authorizationUrl(provider, { clientId: "client", graphVersion: "v26.0" }, { origin: "https://qred.test", id: "state", nonce: "nonce", challenge: "challenge" }));
  expect(url.origin + url.pathname).toBe(endpoint);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ scope, response_type: "code", code_challenge_method: "S256", code_challenge: "challenge", state: "state", redirect_uri: "https://qred.test/api/auth/" + provider + "/callback" });
  expect(allowedAuthorizationUrl(provider, url.href)).toBe(true);
  for (const other of ["https://attacker.example/", endpoint.replace("https:", "http:"), endpoint + "#credentials", endpoint.replace("https://", "https://attacker@")]) expect(allowedAuthorizationUrl(provider, other)).toBe(false);
});

it("requires each provider's own configuration and bounds the Meta API version", () => {
  expect(providerConfiguration("microsoft", { QRED_GOOGLE_CLIENT_ID: "google", QRED_GOOGLE_CLIENT_SECRET: "secret" })).toBeNull();
  expect(providerConfiguration("meta", { QRED_META_APP_ID: "app", QRED_META_APP_SECRET: "secret", QRED_META_GRAPH_VERSION: "../v26.0" })).toBeNull();
  expect(providerConfiguration("toString", {})).toBeNull();
});
