import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { encodeIdentity } from "../src/attestation.js";
import { authProvider } from "../src/authProviders.js";
import { RequestError } from "./authErrors.js";

export const TOKEN_MAX_AGE = 300;
export const CLOCK_SKEW = 30;
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const microsoftKeys = createRemoteJWKSet(new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"));
const metaKeys = createRemoteJWKSet(new URL("https://www.facebook.com/.well-known/oauth/openid/jwks/"));
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function providerConfiguration(provider, env) {
  if (!authProvider(provider)) return null;
  const prefix = "QRED_" + (provider === "meta" ? "META_APP" : provider.toUpperCase() + "_CLIENT");
  const clientId = env[prefix + "_ID"]?.trim(), clientSecret = env[prefix + "_SECRET"]?.trim();
  // Microsoft is a public SPA client; its browser PKCE flow must not require a secret.
  if (!clientId || (provider !== "microsoft" && !clientSecret)) return null;
  const graphVersion = env.QRED_META_GRAPH_VERSION || "v26.0";
  if (provider === "meta" && !/^v\d{1,2}\.\d{1,2}$/.test(graphVersion)) return null;
  return { clientId, clientSecret, graphVersion };
}

export function authorizationUrl(provider, config, { origin, id, nonce, challenge }) {
  const urls = {
    google: "https://accounts.google.com/o/oauth2/v2/auth",
    microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    meta: "https://www.facebook.com/" + config.graphVersion + "/dialog/oauth",
    amazon: "https://www.amazon.com/ap/oa",
  };
  const auth = new URL(urls[provider]);
  auth.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: origin + "/api/auth/" + provider + "/callback",
    response_type: "code", state: id, code_challenge: challenge, code_challenge_method: "S256",
    scope: provider === "amazon" ? "profile" : provider === "meta" ? "public_profile,email" : "openid email profile",
    ...(provider === "amazon" ? {} : { nonce }),
    ...(["google", "microsoft"].includes(provider) ? { prompt: "select_account" } : {}),
    ...(provider === "meta" ? { display: "popup", auth_type: "rerequest" } : {}),
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

export const verifyMetaIdToken = (token, clientId, now, keys = metaKeys) =>
  verifyIdToken(token, clientId, now, keys, "https://www.facebook.com", "meta");

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

const tokenVerifiers = { google: verifyGoogleIdToken, meta: verifyMetaIdToken };

async function providerJson(fetchImpl, url, options = {}, failureMessage = "The sign-in service could not complete this request. Please try again.") {
  const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new RequestError(failureMessage, 403);
  return response.json();
}

// Standard Facebook Login returns an opaque OAuth access token, not an OIDC
// identity token. Treat the Graph token debugger as an independent, app-bound
// authorization check and require a matching user profile before sealing.
export async function verifyMetaAccessToken(tokens, config, fetchImpl, now) {
  if (typeof tokens?.access_token !== "string" || !tokens.access_token ||
      tokens.access_token.length > 2048 ||
      (tokens.token_type != null && tokens.token_type.toLowerCase() !== "bearer") ||
      !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    throw new RequestError("Facebook did not return a usable account token. Please try again.", 403);
  }
  const base = "https://graph.facebook.com/" + config.graphVersion;
  // The debug_token API requires an app-scoped inspector credential. Both the
  // inspected token and app secret go only to Meta, over TLS, never to the QRed
  // frontend or an attestation cookie.
  const debug = await providerJson(fetchImpl, base + "/debug_token?" +
    new URLSearchParams({ input_token: tokens.access_token,
      access_token: config.clientId + "|" + config.clientSecret }),
    {}, "Facebook could not validate the QRed account token. Please try again.");
  const data = debug?.data;
  const seconds = Math.floor(now() / 1000);
  if (data?.is_valid !== true || String(data?.app_id) !== config.clientId ||
      data?.type !== "USER" || typeof data.user_id !== "string" ||
      !/^[0-9]+$/.test(data.user_id) || !Number.isSafeInteger(data.expires_at) ||
      data.expires_at <= seconds || !Array.isArray(data.scopes)) {
    throw new RequestError("Facebook returned an invalid, expired, or unrelated account token.", 403);
  }
  if (!data.scopes.includes("email")) {
    throw new RequestError("Allow QRed to access your Facebook email address and try again.", 403);
  }
  // appsecret_proof binds use of the user token to QRed's server secret.
  const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.clientSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const proof = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey,
    new TextEncoder().encode(tokens.access_token))), b => b.toString(16).padStart(2, "0")).join("");
  const profile = await providerJson(fetchImpl, base + "/me?" +
    new URLSearchParams({ fields: "id,name,email", appsecret_proof: proof }),
    { headers: { Authorization: "Bearer " + tokens.access_token } },
    "Facebook could not provide your name and email to QRed. Please check your permissions.");
  if (profile?.id !== data.user_id) {
    throw new RequestError("Facebook profile did not match the authenticated account.", 403);
  }
  return { identity: providerIdentity("meta",
    { sub: data.user_id, name: profile.name, email: profile.email }) };
}

export async function exchangeIdentity(provider, config, { code, origin, pending, fetchImpl, now, verifyTokens = {} }) {
  // A Microsoft SPA redirect cannot redeem a code server-side or use a client secret.
  if (provider === "microsoft") throw new RequestError("Microsoft requires browser PKCE", 403);
  const endpoints = {
    google: "https://oauth2.googleapis.com/token",
    meta: "https://graph.facebook.com/" + config.graphVersion + "/oauth/access_token",
    amazon: "https://api.amazon.com/auth/o2/token",
  };
  const parameters = new URLSearchParams({
    code, client_id: config.clientId, client_secret: config.clientSecret,
    code_verifier: pending.pkce, redirect_uri: origin + "/api/auth/" + provider + "/callback",
    ...(provider === "meta" ? {} : { grant_type: "authorization_code" }),
  });
  // Meta documents GET for its code exchange; other providers use form POST.
  const tokens = await providerJson(fetchImpl, provider === "meta" ? endpoints.meta + "?" + parameters : endpoints[provider],
    provider === "meta" ? {} : { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: parameters },
    provider === "meta" ? "Facebook rejected QRed's login code exchange. Check the app credentials and callback URI." :
      "The sign-in service could not complete this request. Please try again.");
  if (provider === "meta") return verifyMetaAccessToken(tokens, config, fetchImpl, now);
  if (provider !== "amazon") {
    if (typeof tokens.id_token !== "string" || tokens.id_token.length > 16384) throw new RequestError("The sign-in service did not return an identity token", 403);
    const payload = await (verifyTokens[provider] || tokenVerifiers[provider])(tokens.id_token, config.clientId, now());
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
