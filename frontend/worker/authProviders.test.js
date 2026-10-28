import { beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { authorizationUrl, checkTokenTime, exchangeIdentity, providerConfiguration, providerIdentity, validateMicrosoftSpaToken, safeMicrosoftVerificationReason, safeGoogleTokenErrorDetails, safeGoogleIdTokenErrorReason, verifyMicrosoftIdToken } from "./authProviders.js";
import { allowedAuthorizationUrl } from "../src/authProviders.js";
import { RequestError } from "./authErrors.js";

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
  iss: microsoftIssuer,
  ...(provider === "microsoft" ? { tid: tenant, ver: "2.0" } : {}) });
const token = payload => new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(rsa.privateKey);
const verify = { microsoft: verifyMicrosoftIdToken };

describe.each(["microsoft"])("%s identity tokens", provider => {
  it("accepts a signed identity and rejects wrong issuer, audience, time, nonce presence and signature", async () => {
    await expect(verify[provider](await token(claims(provider)), "test-client", now, keys)).resolves.toMatchObject({ sub: "account-123" });
    const invalid = [{ iss: "https://attacker.example" }, { aud: "another-app" }, { aud: ["test-client", "another-app"] },
      { azp: "another-app" }, { exp: seconds - 31 }, { exp: undefined }, { nonce: undefined }, { sub: undefined },
      { iat: seconds - 1201 }, { iat: seconds + 31 }, { iat: seconds + 0.5 }];
    if (provider === "microsoft") invalid.push({ tid: "not-a-guid" }, { tid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, { ver: "1.0" });
    for (const change of invalid) await expect(verify[provider](await token({ ...claims(provider), ...change }), "test-client", now, keys)).rejects.toThrow();
    const forged = (await token(claims(provider))).split(".");
    forged[2] = (forged[2][0] === "A" ? "B" : "A") + forged[2].slice(1);
    await expect(verify[provider](forged.join("."), "test-client", now, keys)).rejects.toThrow();
  });
});


it("categorizes Microsoft verification failures without reflecting private tokens or provider errors", () => {
  expect(safeMicrosoftVerificationReason(new RequestError("Microsoft did not share an email address. Allow email access or choose another sealing method.")))
    .toContain("email address");
  expect(safeMicrosoftVerificationReason(new RequestError("Microsoft identity nonce did not match this document sign-in request")))
    .toContain("did not match");
  expect(safeMicrosoftVerificationReason(Object.assign(new Error("id_token=private-secret"), {
    code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  }))).toBe("Microsoft identity signature is invalid");
  expect(safeMicrosoftVerificationReason(Object.assign(new Error("private authorisation code"), {
    code: "ERR_JWKS_NO_MATCHING_KEY",
  }))).toBe("Microsoft signing key not found");
  for (const malicious of [
    new Error("ID token: top-secret, client_secret: private"),
    new RequestError("Microsoft returned secret token=private"),
    Object.assign(new Error("private"), { code: "ERR_UNTRUSTED_private_secret" }),
  ]) {
    const safe = safeMicrosoftVerificationReason(malicious);
    expect(safe).toBe("Microsoft identity token or signing keys could not be verified");
    expect(safe).not.toContain("secret");
    expect(safe).not.toContain("token=");
  }
});

it("requires Microsoft's signed document nonce but accepts a recent SSO token issued before preparation", async () => {
  const check = async change => validateMicrosoftSpaToken(
    await token({ ...claims("microsoft"), ...change }),
    { clientId: "test-client" }, { nonce: "nonce", iat: seconds }, () => now,
    { microsoft: (value, client, time) => verifyMicrosoftIdToken(value, client, time, keys) });
  await expect(check({ nonce: "different-request" })).rejects.toThrow("nonce did not match");
  await expect(check({ nonce: undefined })).rejects.toThrow();
  // Microsoft may reuse a recent SSO authentication time, even though
  // this particular signed ID token contains QRed's fresh document nonce.
  const recent = await check({ iat: seconds - 120 });
  expect(recent.identity.provider).toBe("microsoft");
  expect(recent.provider_iat).toBe(seconds - 120);
  // A 15-minute mail/MFA challenge is valid for Microsoft.
  const fifteenMinutesOld = await check({ iat: seconds - 15 * 60 });
  expect(fifteenMinutesOld.identity.provider).toBe("microsoft");
  // Beyond 20 minutes is still rejected, even with a matching signed nonce.
  await expect(check({ iat: seconds - 1201 })).rejects.toThrow();
  await expect(check({ iat: seconds + 31 })).rejects.toThrow();
});


it("keeps Google's five-minute token freshness even as Microsoft's window grows", () => {
  expect(() => checkTokenTime({ iat: seconds - 301 }, now, "google")).toThrow("too old");
  expect(() => checkTokenTime({ iat: seconds - 15 * 60 }, now, "microsoft")).not.toThrow();
  expect(() => checkTokenTime({ iat: seconds - 1201 }, now, "microsoft")).toThrow("too old");
  expect(() => checkTokenTime({ iat: seconds + 31 }, now, "microsoft")).toThrow("clock");
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

it.each(["microsoft", "amazon"])("requires %s to supply both email and profile name", provider => {
  const user = { ...claims(provider), tid: tenant, user_id: "amazon-account" };
  expect(providerIdentity(provider, user)).toMatchObject({ provider, name_source: provider });
  for (const change of [{ email: undefined, preferred_username: "not-an-email-proof@example.org" }, { email: "" }, { name: undefined }, { name: " " }, { name: "spoof\u202e" }]) {
    expect(() => providerIdentity(provider, { ...user, ...change })).toThrow();
  }
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
    expect(requests.every(request => request.options.redirect === "manual")).toBe(true);
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
  ["amazon", "https://www.amazon.com/ap/oa", "profile"],
])("restricts %s authorization to its provider, code flow and PKCE", (provider, endpoint, scope) => {
  const url = new URL(authorizationUrl(provider, { clientId: "client" }, { origin: "https://qred.test", id: "state", nonce: "nonce", challenge: "challenge" }));
  expect(url.origin + url.pathname).toBe(endpoint);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    scope, response_type: "code", state: "state", redirect_uri: "https://qred.test/api/auth/" + provider + "/callback",
  });
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBe("challenge");
  expect(allowedAuthorizationUrl(provider, url.href)).toBe(true);
  for (const other of ["https://attacker.example/", endpoint.replace("https:", "http:"), endpoint + "#credentials", endpoint.replace("https://", "https://attacker@")]) expect(allowedAuthorizationUrl(provider, other)).toBe(false);
});

it("requires each active provider's configuration", () => {
  expect(providerConfiguration("microsoft", { QRED_GOOGLE_CLIENT_ID: "google", QRED_GOOGLE_CLIENT_SECRET: "secret" })).toBeNull();
  expect(providerConfiguration("microsoft", { QRED_MICROSOFT_CLIENT_ID: "public-client-id" }))
    .toMatchObject({ clientId: "public-client-id" });
  expect(providerConfiguration("meta", { QRED_META_APP_ID: "app", QRED_META_APP_SECRET: "secret" })).toBeNull();
  expect(providerConfiguration("toString", {})).toBeNull();
});


describe("redacted Google token-exchange and verification diagnostics", () => {
  const config = { clientId: "google-app", clientSecret: "google-server-secret" };
  const context = {
    code: "one-time-authorization-code", origin: "https://qred.test",
    pending: { nonce: "nonce", iat: seconds, pkce: "local-pkce-verifier" }, now: () => now,
  };

  it.each([
    [401, "invalid_client"], [400, "invalid_grant"], [400, "invalid_request"],
  ])("reports Google HTTP %i and the allowlisted OAuth %s error only", async (httpStatus, oauthCode) => {
    const upstreamDescription = "google-server-secret / one-time-authorization-code / id_token";
    const fetchImpl = async (url, options) => {
      expect(url).toBe("https://oauth2.googleapis.com/token");
      expect(options.method).toBe("POST");
      expect(options.redirect).toBe("manual");
      expect(options.body.get("client_secret")).toBe(config.clientSecret);
      expect(options.body.get("code")).toBe(context.code);
      expect(options.body.get("redirect_uri")).toBe("https://qred.test/api/auth/google/callback");
      expect(options.body.get("code_verifier")).toBe(context.pending.pkce);
      expect(options.body.get("grant_type")).toBe("authorization_code");
      return Response.json({ error: oauthCode, error_description: upstreamDescription,
        incident_detail: "<script>secret</script>" }, { status: httpStatus });
    };
    let message = "";
    try {
      await exchangeIdentity("google", config, { ...context, fetchImpl });
      throw new Error("Expected Google to reject the code exchange");
    } catch (error) { message = error.message; }
    expect(message).toContain("Google declined QRed's authorization code exchange");
    expect(message).toContain("HTTP " + httpStatus + "; OAuth " + oauthCode);
    expect(message).not.toContain("google-server-secret");
    expect(message).not.toContain("one-time-authorization-code");
    expect(message).not.toContain("id_token");
    expect(message).not.toContain("incident_detail");
  });

  it("never echoes unknown Google error values, request URLs or provider prose", () => {
    expect(safeGoogleTokenErrorDetails(400, {
      error: "invalid_grant;google-server-secret", error_description: "secrets",
    })).toBe(" (HTTP 400)");
    expect(safeGoogleTokenErrorDetails(401, { error: "invalid_client" }))
      .toBe(" (HTTP 401; OAuth invalid_client)");
    expect(safeGoogleTokenErrorDetails(200, { error: "invalid_grant" }))
      .toBe(" (OAuth invalid_grant)");
    expect(safeGoogleTokenErrorDetails(700, { error: "arbitrary" })).toBe("");
    expect(safeGoogleTokenErrorDetails(403, { error: ["invalid_grant"] })).toBe(" (HTTP 403)");
  });

  it("distinguishes unreachable Google token endpoint from a rejected credential", async () => {
    for (const fetchImpl of [
      async () => { throw new Error("private code=one-time-authorization-code, client_secret=google-server-secret"); },
      async () => new Response("the private secret is google-server-secret", { status: 400 }),
    ]) {
      let message = "";
      try {
        await exchangeIdentity("google", config, { ...context, fetchImpl });
        throw new Error("Expected failed Google token request");
      } catch (error) { message = error.message; }
      expect(message).toContain("Google declined QRed's authorization code exchange");
      expect(message).not.toContain("google-server-secret");
      expect(message).not.toContain(context.code);
      expect(message).not.toContain("private secret");
    }
    await expect(exchangeIdentity("google", config, {
      ...context, fetchImpl: async () => { throw new Error("network unavailable"); },
    })).rejects.toThrow("could not contact the provider or request timed out");
    await expect(exchangeIdentity("google", config, {
      ...context, fetchImpl: async () => new Response("not JSON", { status: 200 }),
    })).rejects.toThrow("invalid provider JSON response");
  });

  it("identifies unexpected Google identity-token signature/JWKS failures without exposing error messages", async () => {
    const malicious = "google-server-secret & one-time-authorization-code";
    for (const [code, expected] of [
      ["ERR_JWKS_NO_MATCHING_KEY", "Google signing key not found"],
      ["ERR_JWT_CLAIM_VALIDATION_FAILED", "invalid token claims"],
      ["ERR_JWS_SIGNATURE_VERIFICATION_FAILED", "invalid signature"],
      ["unexpected " + malicious, "token or signing keys unavailable"],
    ]) {
      expect(safeGoogleIdTokenErrorReason({ code, message: malicious })).toBe(expected);
      await expect(exchangeIdentity("google", config, {
        ...context,
        fetchImpl: async () => Response.json({ id_token: "synthetic-Google-id-token" }),
        verifyTokens: { google: async () => { throw Object.assign(new Error(malicious), { code }); } },
      })).rejects.toThrow("Google identity token verification failed (" + expected + ")");
    }
  });
});

describe("Cloudflare Workers-compatible confidential OAuth subrequests", () => {
  // Cloudflare Workers does not implement the Fetch redirect mode "error": it
  // throws TypeError before contacting OAuth providers. This regression would
  // have caught the shared Google/Amazon exchange failure.
  it.each(["google", "amazon"])("uses supported manual redirect handling for %s token exchanges", async provider => {
    const config = { clientId: "app-id", clientSecret: "private-client-secret" };
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, init });
      if (init.redirect === "error") throw new TypeError("Cloudflare does not implement redirect mode error");
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      // A real provider's OAuth error should be received and categorized as
      // an HTTP response, never swallowed as an unreachable endpoint.
      return Response.json({ error: "invalid_grant", error_description: "private-client-secret" }, { status: 400 });
    };
    const authenticate = exchangeIdentity(provider, config, {
      code: "private-one-use-code", origin: "https://qred.test",
      pending: { nonce: "nonce", pkce: "verifier", iat: seconds },
      fetchImpl, now: () => now,
    });
    if (provider === "google") await expect(authenticate).rejects.toThrow("HTTP 400; OAuth invalid_grant");
    else await expect(authenticate).rejects.toThrow("The sign-in service could not complete this request");
    expect(seen).toHaveLength(1);
    expect(seen[0].init.redirect).toBe("manual");
  });

  it.each(["google", "amazon"])("rejects unexpected 3xx redirects for %s without following or leaking credentials", async provider => {
    const config = { clientId: "app-id", clientSecret: "private-client-secret" };
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init.redirect).toBe("manual");
      return Response.redirect("https://untrusted.invalid/steal?code=private-one-use-code&secret=private-client-secret", 302);
    });
    let message;
    try {
      await exchangeIdentity(provider, config, {
        code: "private-one-use-code", origin: "https://qred.test",
        pending: { nonce: "nonce", pkce: "verifier", iat: seconds },
        fetchImpl, now: () => now,
      });
      throw new Error("Expected the provider's HTTP redirect to be rejected");
    } catch (error) { message = error.message; }
    expect(message).toContain("unexpected provider redirect");
    expect(message).not.toContain("private-one-use-code");
    expect(message).not.toContain("private-client-secret");
    expect(message).not.toContain("untrusted.invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 303, 307, 308])("does not follow HTTP %i even when a provider includes a Location header", async httpStatus => {
    const fetchImpl = vi.fn(async (_url, options) => {
      expect(options.redirect).toBe("manual");
      return Response.redirect("https://untrusted.invalid/attacker", httpStatus);
    });
    await expect(exchangeIdentity("google", { clientId: "app", clientSecret: "server-only-secret" }, {
      code: "single-use-code", origin: "https://qred.test",
      pending: { pkce: "verifier", nonce: "nonce", iat: seconds }, now: () => now, fetchImpl,
    })).rejects.toThrow("unexpected provider redirect");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
