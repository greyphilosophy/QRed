// Authentication is authorized for one specific prepared document only.
// The random nonce, salted document commitment, encrypted cookie and in-memory
// secret are valid for at most five minutes from initial preparation.
// Polling, status checks and retries never extend this absolute deadline.
export const ACCOUNT_SESSION_SECONDS = 5 * 60;

// Google requires a freshly issued signed ID token. Microsoft can return an
// older signed iat during a new SSO exchange; QRed instead enforces its fresh
// exact-match nonce and five-minute prepared-document session.
export const DEFAULT_ID_TOKEN_MAX_AGE_SECONDS = 5 * 60;
