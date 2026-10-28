import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { encodeIdentity } from "../src/attestation.js";
import { authProvider } from "../src/authProviders.js";
import { RequestError } from "./authErrors.js";

export const TOKEN_MAX_AGE = 300;
export const CLOCK_SKEW = 30;
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const microsoftKeys = createRemoteJWKSet(new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"));
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function providerConfiguration(provider, env) {
  if (!authProvider(provider)) return null;
  const prefix = "QRED_" + provider.toUpperCase() + "_CLIENT";
  const clientId = env[prefix + "_ID"]?.trim(), clientSecret = env[prefix + "_SECRET"]?.trim();
  // Microsoft is a public SPA client; its browser PKCE flow must not require a secret.
  if (!clientId || (provider !== "microsoft" && !clientSecret)) return null;
  return { clientId, clientSecret };
}

export function authorizationUrl(provider, config, { origin, id, nonce, challenge }) {
  const urls = {
    google: "https://accounts.google.com/o/oauth2/v2/auth",
    microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    amazon: "https://www.amazon.com/ap/oa",
  };
  const auth = new URL(urls[provider]);
  auth.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: origin + "/api/auth/" + provider + "/callback",
    response_type: "code", state: id,
    code_challenge: challenge, code_challenge_method: "S256",
    scope: provider === "amazon" ? "profile" : "openid email profile",
    ...(["google", "microsoft"].includes(provider) ? { nonce } : {}),
    ...(["google", "microsoft"].includes(provider) ? { prompt: "select_account" } : {}),
  }).toString();
  return auth.href;
}

export function providerIdentity(provider, payload) {
  const label = authProvider(provider)?.label;
  if (!label) throw new RequestError("Unsupported sign-in provider");
  if (provider === "google" && (payload.email_verified !== true || typeof payload.email !== "string" ||
      !(payload.email.toLowerCase().endsWith("@gmail.com") || (typeof payload.hd === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(payload.hd))))) {
    throw new RequestError("Use a Gmail or Google Workspace account. Other email addresses need separate email verification.", 403);
  }
  if (typeof payload.name !== "string" || !payload.name.trim()) {
    throw new RequestError(label + " did not supply a profile name. Add a name to your " + label + " profile and try again, or use a private key file.");
  }
  if (typeof payload.email !== "string" || !payload.email.trim()) {
    throw new RequestError(label + " did not share an email address. Allow email access or choose another sealing method.");
  }
  // Microsoft subjects are issuer-scoped. Never identify users by a mutable
  // email/preferred_username, or by sub alone across different tenants.
  if (provider === "microsoft" && !TENANT_ID.test(payload.tid || "")) throw new RequestError("Invalid Microsoft account tenant", 403);
  const identity = {
    provider, name_source: provider, name: payload.name.trim(), email: payload.email,
    subject: provider === "microsoft" ? payload.tid + ":" + payload.sub : provider === "amazon" ? payload.user_id : payload.sub,
  };
  if (provider === "microsoft" && (typeof payload.sub !== "string" || !payload.sub.trim())) throw new RequestError("Invalid Microsoft account subject", 403);
  try { encodeIdentity(identity); } catch { throw new RequestError(label + " returned unsupported account details"); }
  return identity;
}

export const googleIdentity = payload => providerIdentity("google", payload);

export function checkTokenTime(payload, now, provider) {
  const seconds = Math.floor(now / 1000);
  // Token issuance is not evidence of when a person last entered a password.
  if (!Number.isSafeInteger(payload.iat) || payload.iat < seconds - TOKEN_MAX_AGE || payload.iat > seconds + CLOCK_SKEW) {
    throw new RequestError(authProvider(provider).label + " sign-in is too old or its clock differs from QRed. Please try again.", 403);
  }
}

async function verifyIdToken(token, clientId, now, keys, issuer, provider, requiredClaims = []) {
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ["RS256"], issuer, audience: clientId,
    requiredClaims: ["exp", "iat", "sub", "nonce", ...requiredClaims],
    maxTokenAge: TOKEN_MAX_AGE, clockTolerance: CLOCK_SKEW, currentDate: new Date(now),
  });
  checkTokenTime(payload, now, provider);
  if (payload.aud !== clientId || (payload.azp && payload.azp !== clientId)) throw new RequestError("Authentication failed", 403);
  return payload;
}

export const verifyGoogleIdToken = (token, clientId, now, keys = googleKeys) =>
  verifyIdToken(token, clientId, now, keys, ["https://accounts.google.com", "accounts.google.com"], "google");

export async function verifyMicrosoftIdToken(token, clientId, now, keys = microsoftKeys) {
  // Untrusted claims only select the expected issuer. Signature and every
  // security claim are then verified against Microsoft's fixed JWKS endpoint.
  const claims = decodeJwt(token);
  if (!TENANT_ID.test(claims.tid || "") || claims.ver !== "2.0") throw new RequestError("Invalid Microsoft token issuer", 403);
  const issuer = "https://login.microsoftonline.com/" + claims.tid + "/v2.0";
  const scopedKey = async (header, jwt) => {
    const key = await keys(header, jwt);
    const candidates = keys.jwks()?.keys.filter(jwk => jwk.kid === header.kid);
    if (candidates?.length !== 1 || candidates[0].issuer?.replace("{tenantid}", claims.tid) !== issuer) {
      throw new RequestError("Microsoft signing key does not match the account tenant", 403);
    }
    return key;
  };
  return verifyIdToken(token, clientId, now, scopedKey, issuer, "microsoft", ["tid", "ver"]);
}

// The browser obtains the Microsoft ID token using a one-time authorization
// code and PKCE. Only this server decides whether it represents a valid account.
export async function validateMicrosoftSpaToken(token, config, pending, now, verifyTokens = {}) {
  if (typeof token !== "string" || !token || token.length > 16384) throw new RequestError("Invalid Microsoft identity token", 403);
  const payload = await (verifyTokens.microsoft || verifyMicrosoftIdToken)(token, config.clientId, now());
  if (payload.nonce !== pending.nonce || payload.iat < pending.iat - CLOCK_SKEW) {
    throw new RequestError("Microsoft identity did not match this document sign-in request", 403);
  }
  checkTokenTime(payload, now(), "microsoft");
  return { identity: providerIdentity("microsoft", payload), provider_iat: payload.iat };
}

// The browser may show Microsoft sign-in verification diagnostics, but never
// third-party prose, JWTs, key material, authorization codes, or exception text.
// Only QRed-owned, fixed messages and known jose error codes are disclosed.
const MICROSOFT_REQUEST_DIAGNOSTICS = new Set([
  "Invalid Microsoft identity token",
  "Invalid Microsoft token issuer",
  "Microsoft signing key does not match the account tenant",
  "Microsoft identity did not match this document sign-in request",
  "Microsoft sign-in is too old or its clock differs from QRed. Please try again.",
  "Microsoft did not supply a profile name. Add a name to your Microsoft profile and try again, or use a private key file.",
  "Microsoft did not share an email address. Allow email access or choose another sealing method.",
  "Invalid Microsoft account tenant",
  "Invalid Microsoft account subject",
  "Microsoft returned unsupported account details",
]);
const MICROSOFT_JOSE_DIAGNOSTICS = Object.freeze({
  ERR_JWKS_TIMEOUT: "Microsoft signing keys temporarily unavailable",
  ERR_JWKS_NO_MATCHING_KEY: "Microsoft signing key not found",
  ERR_JWS_SIGNATURE_VERIFICATION_FAILED: "Microsoft identity signature is invalid",
  ERR_JWT_CLAIM_VALIDATION_FAILED: "Microsoft identity token claims are invalid",
  ERR_JWT_EXPIRED: "Microsoft identity token has expired",
  ERR_JWS_INVALID: "Microsoft identity token is malformed",
  ERR_JWT_INVALID: "Microsoft identity token is malformed",
});
export function safeMicrosoftVerificationReason(error) {
  if (error instanceof RequestError && MICROSOFT_REQUEST_DIAGNOSTICS.has(error.message)) return error.message;
  if (typeof error?.code === "string" && Object.hasOwn(MICROSOFT_JOSE_DIAGNOSTICS, error.code)) {
    return MICROSOFT_JOSE_DIAGNOSTICS[error.code];
  }
  return "Microsoft identity token or signing keys could not be verified";
}

const tokenVerifiers = { google: verifyGoogleIdToken };

// Google returns a standard OAuth error on a rejected code exchange. Only
// fixed, documented protocol identifiers may reach the browser; the provider's
// free-form error_description can echo URLs, codes or client credentials.
const GOOGLE_OAUTH_ERRORS = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
  "unsupported_grant_type", "invalid_scope", "access_denied", "expired_token",
  "temporarily_unavailable", "admin_policy_enforced", "org_internal",
]);
export function safeGoogleTokenErrorDetails(responseStatus, data) {
  const status = Number.isSafeInteger(responseStatus) && responseStatus >= 400 &&
    responseStatus <= 599 ? responseStatus : null;
  const value = data && typeof data === "object" && !Array.isArray(data) ? data.error : null;
  const code = typeof value === "string" && GOOGLE_OAUTH_ERRORS.has(value) ? value : null;
  const details = [
    ...(status ? ["HTTP " + status] : []),
    ...(code ? ["OAuth " + code] : []),
  ];
  return details.length ? " (" + details.join("; ") + ")" : "";
}

const GOOGLE_ID_TOKEN_ERRORS = Object.freeze({
  ERR_JWKS_TIMEOUT: "Google signing keys temporarily unavailable",
  ERR_JWKS_NO_MATCHING_KEY: "Google signing key not found",
  ERR_JWS_SIGNATURE_VERIFICATION_FAILED: "invalid signature",
  ERR_JWT_CLAIM_VALIDATION_FAILED: "invalid token claims",
  ERR_JWT_EXPIRED: "expired token",
  ERR_JWS_INVALID: "malformed token",
  ERR_JWT_INVALID: "malformed token",
});
export function safeGoogleIdTokenErrorReason(error) {
  return typeof error?.code === "string" &&
    Object.hasOwn(GOOGLE_ID_TOKEN_ERRORS, error.code) ?
      GOOGLE_ID_TOKEN_ERRORS[error.code] : "token or signing keys unavailable";
}

async function providerJson(fetchImpl, url, options = {},
  failureMessage = "The sign-in service could not complete this request. Please try again.",
  diagnosticsProvider = null) {
  let response;
  try {
    // Cloudflare Workers supports "manual" but NOT redirect: "error":
    // https://developers.cloudflare.com/workers/runtime-apis/request/
    // "error" throws TypeError before a network request is sent, preventing
    // every confidential Google, Meta and Amazon authorization-code exchange.
    // Never follow an OAuth redirect (it can leak codes, tokens or secrets).
    response = await fetchImpl(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(10000) });
  } catch {
    // Fetch exceptions can include the OAuth code and client secret in the
    // request URL. Never copy the raw exception or request URL into a response.
    throw new RequestError(failureMessage +
      (diagnosticsProvider ? " (could not contact the provider or request timed out)" : ""), 403);
  }
  // Cloudflare's "manual" mode returns a 3xx response. Treat ANY such
  // response as an authentication failure; do not fetch its Location URL,
  // include it in an error, or accept a redirected token response.
  if (response.status >= 300 && response.status < 400) {
    throw new RequestError(failureMessage + " (unexpected provider redirect)", 403);
  }
  if (!response.ok) {
    let details = "";
    if (diagnosticsProvider === "google") {
      let data = null;
      try {
        // Never echo untrusted provider error descriptions or trace IDs.
        const text = await response.text();
        if (text.length <= 4096) data = JSON.parse(text);
      } catch { /* Ignore malformed or unreadable provider error bodies. */ }
      details = safeGoogleTokenErrorDetails(response.status, data);
    }
    throw new RequestError(failureMessage + details, 403);
  }
  try { return await response.json(); }
  catch {
    throw new RequestError(failureMessage +
      (diagnosticsProvider ? " (invalid provider JSON response)" : ""), 403);
  }
}

export async function exchangeIdentity(provider, config, { code, origin, pending, fetchImpl, now, verifyTokens = {} }) {
  // A Microsoft SPA redirect cannot redeem a code server-side or use a client secret.
  if (provider === "microsoft") throw new RequestError("Microsoft requires browser PKCE", 403);
  const endpoints = {
    google: "https://oauth2.googleapis.com/token",
    amazon: "https://api.amazon.com/auth/o2/token",
  };
  const parameters = new URLSearchParams({
    code, client_id: config.clientId, client_secret: config.clientSecret,
    code_verifier: pending.pkce,
    redirect_uri: origin + "/api/auth/" + provider + "/callback",
    grant_type: "authorization_code",
  });
  const tokens = await providerJson(fetchImpl, endpoints[provider],
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: parameters },
    provider === "google" ? "Google declined QRed's authorization code exchange." :
      "The sign-in service could not complete this request. Please try again.",
    provider === "google" ? "google" : null);
  if (provider !== "amazon") {
    if (typeof tokens.id_token !== "string" || tokens.id_token.length > 16384) throw new RequestError("The sign-in service did not return an identity token", 403);
    let payload;
    try {
      payload = await (verifyTokens[provider] || tokenVerifiers[provider])(tokens.id_token, config.clientId, now());
    } catch (error) {
      if (error instanceof RequestError || provider !== "google") throw error;
      // jose/JWKS errors otherwise escaped to the callback's catch-all as
      // "Authentication failed", hiding which step rejected Google sign-in.
      // Report only fixed error categories, never exception messages/tokens.
      throw new RequestError("Google identity token verification failed (" +
        safeGoogleIdTokenErrorReason(error) + "). Please try again.", 403);
    }
    if (payload.nonce !== pending.nonce) throw new RequestError("Authentication did not match this request", 403);
    if (payload.iat < pending.iat - CLOCK_SKEW) throw new RequestError("Sign-in predates this request. Please try again.", 403);
    checkTokenTime(payload, now(), provider);
    return { identity: providerIdentity(provider, payload), provider_iat: payload.iat };
  }
  if (typeof tokens.access_token !== "string" || !tokens.access_token || tokens.access_token.length > 2048 ||
      tokens.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    throw new RequestError("Amazon did not return a valid access token", 403);
  }
  // Amazon returns an opaque access token, not an OIDC ID token. Verify it with
  // Amazon before obtaining the profile. Neither token is stored in a cookie.
  const info = await providerJson(fetchImpl, "https://api.amazon.com/auth/o2/tokeninfo?" +
    new URLSearchParams({ access_token: tokens.access_token }));
  if (info.aud !== config.clientId || info.iss !== "https://www.amazon.com" || typeof info.user_id !== "string" ||
      !Number.isFinite(info.exp) || info.exp <= 0) {
    throw new RequestError("Amazon token does not match this application or has expired", 403);
  }
  const profile = await providerJson(fetchImpl, "https://api.amazon.com/user/profile",
    { headers: { Authorization: "Bearer " + tokens.access_token } });
  if (profile.user_id !== info.user_id) throw new RequestError("Amazon profile does not match the authenticated account", 403);
  return { identity: providerIdentity(provider, profile) };
}
