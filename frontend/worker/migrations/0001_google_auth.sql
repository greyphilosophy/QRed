CREATE TABLE auth_requests (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  cookie_hash TEXT NOT NULL,
  nonce TEXT,
  pkce TEXT,
  commitments TEXT NOT NULL,
  name TEXT NOT NULL,
  expires INTEGER NOT NULL,
  status TEXT NOT NULL,
  identity TEXT,
  issued_at TEXT,
  error TEXT,
  receipts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX auth_requests_expiry ON auth_requests(expires);
CREATE TABLE auth_rate (
  bucket TEXT NOT NULL,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(bucket, window)
);
