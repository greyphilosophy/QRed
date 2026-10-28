// One document-specific OAuth login may take time for email codes or MFA.
// The pending browser session has a fixed absolute expiry; polling never
// refreshes it. Keep the browser and Worker on this same value.
export const ACCOUNT_SESSION_SECONDS = 20 * 60;

// Ordinary provider identity tokens should be very recent. Microsoft's SSO
// ID token iat may predate a lengthy interactive challenge, so allow the same
// bounded 20-minute freshness as the document-specific login. The signed
// nonce, exact audience, issuer, expiry and PKCE checks remain mandatory.
export const DEFAULT_ID_TOKEN_MAX_AGE_SECONDS = 5 * 60;
export const MICROSOFT_ID_TOKEN_MAX_AGE_SECONDS = 20 * 60;
