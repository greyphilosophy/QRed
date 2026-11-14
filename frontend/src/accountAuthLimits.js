// One document-specific OAuth attempt has a fixed five-minute expiry from
// initial PDF preparation. Polling and retries cannot extend the deadline.
export const ACCOUNT_SESSION_SECONDS = 5 * 60;

// Google's additional issued-at age limit. Microsoft uses token exp/nbf and
// the signed document nonce within ACCOUNT_SESSION_SECONDS, because its iat
// describes provider authentication rather than this request's start time.
export const DEFAULT_ID_TOKEN_MAX_AGE_SECONDS = 5 * 60;
