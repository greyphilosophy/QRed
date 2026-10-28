// One document-specific OAuth attempt has a fixed five-minute expiry from
// initial PDF preparation. Polling and retries cannot extend the deadline.
export const ACCOUNT_SESSION_SECONDS = 5 * 60;

// Keep a consistent five-minute token freshness limit. A signed nonce binds
// a provider token to the specific document; it does not waive token age.
export const DEFAULT_ID_TOKEN_MAX_AGE_SECONDS = 5 * 60;
