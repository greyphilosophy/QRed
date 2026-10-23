# Google document attestations

QRed can attest documents after Google sign-in, with no email/SMS service or paid authentication subscription. Local private-key sealing remains available and works offline. Google is disabled until this installation has a trusted authority key and the server configuration below.

The claim is deliberately limited: QRed authenticated a Google account associated with the recorded email, and attested the prepared document fingerprints at the recorded server time. The display name comes from the Google profile, or is explicitly marked self-declared when Google supplies no name. Neither proves legal identity, organization authority, authorship, or the truth of the document. Exact extracted text remains the primary reference. Optional binary page evidence includes signed lossy grayscale thumbnails and line coordinates; it cannot authenticate every original pixel or guarantee detection of photo substitutions. See [page references](PAGE_REFERENCES.md).

## Enable it on the existing Cloudflare Free plan

Keep Workers on the Free plan. No paid plan, email provider, SMS account, or identity broker is required by this implementation. Workers Free has a daily request allowance and a per-request CPU limit. The service caps documents at 100 pages and signs one page per request. A cold Worker also checks its authority key pair. Production CPU usage still needs to be measured in Cloudflare after deployment; local tests cannot certify its CPU accounting. At a limit, the operation fails with an error; the app does not upgrade a plan or purchase capacity.

1. Register a **Web application** OAuth client in a Google Cloud project. Configure the consent screen with the application homepage and privacy policy. Request only `openid email profile`. Add the exact authorized redirect URI `https://qred.org/api/auth/google/callback`. Publish the OAuth application for its intended audience; while it is in testing, only configured test users can use it. Google Workspace administrators can still prohibit this application.

2. Generate a dedicated QRed authority key **on your own machine**, from `frontend/`:

   ```sh
   node scripts/createAttestationKey.mjs /secure/path/qred-authority.private-key.txt
   ```

   Choose an existing secure directory. The script writes a new private seed file and refuses to overwrite a file. It prints the file path, public key and public key ID, never the private seed. It also adds the public key to `src/trustedAuthorities.json`. Back up the private file securely. Commit the **public JSON file only**, so every verifier build carries the same trust anchor. The private filename is ignored by Git. Never use the demo/test key as the authority.

   For a public key beginning with the exact characters `QRed`, add `--prefix QRed`:

   ```sh
   node scripts/createAttestationKey.mjs /secure/path/qred-authority.private-key.txt --prefix QRed
   ```

   Prefixes are case-sensitive and may contain 1–4 Base64URL characters. The generator repeatedly creates fresh random Ed25519 key pairs and keeps the first matching public key, together with its matching private seed. Four specified characters take approximately `64^4 = 16,777,216` attempts on average; completion time is random. Progress shows attempts and speed, and Ctrl+C cancels. The script uses only Node's built-in modules, needs no npm installation or network access, and prints the resulting **public** key. Run the production search on the device where you will keep the private key. This changes the key's appearance, not how QRed authenticates it; anyone can generate a different key with the same prefix.

3. Set these non-secret Worker variables in the configuration actually used to deploy. Keep the repository-root and `frontend/wrangler.jsonc` configurations consistent:

   | Variable | Value |
   | --- | --- |
   | `QRED_ORIGIN` | `https://qred.org`, without a trailing slash |
   | `QRED_GOOGLE_CLIENT_ID` | The Google web client's ID |
   | `QRED_ATTESTATION_KEY_ID` | The ID printed by the key-generation script |

   Set `QRED_GOOGLE_CLIENT_SECRET` and `QRED_ATTESTATION_PRIVATE_KEY` as **encrypted Worker secrets**, not plain variables or `VITE_` variables. From `frontend/`, Wrangler can read the key through stdin without placing it in shell history or command arguments:

   ```sh
   npx wrangler secret put QRED_GOOGLE_CLIENT_SECRET
   npx wrangler secret put QRED_ATTESTATION_PRIVATE_KEY < /secure/path/qred-authority.private-key.txt
   ```

4. Build and deploy the frontend and Worker together. **No database, migration, session store, or cleanup schedule is needed.** The Pages build bundles the Worker dependencies into `_worker.js`; `_routes.json` limits invocation to `/api/*`, leaving static app resources outside the Functions request allowance. For **Pages** hosting, configure variables and secrets on that Pages project instead of using Worker commands.

   Both Wrangler configurations explicitly set `triggers.crons` to `[]` so deployment removes the previous hourly cleanup trigger. When upgrading the previous database-backed implementation, also remove its `QRED_AUTH_DB` binding and `QRED_DAILY_SIGNIN_LIMIT` variable from any separately maintained deployment settings. This code does not delete an existing database or any old records; an operator who previously deployed it must separately handle that old data.

5. Test a Gmail account and an eligible Workspace account on the real deployment. Check that an unrelated external email address is refused, cancellation works, and both verifier routes can verify the resulting QR with networking disabled after loading. Check Cloudflare CPU and request metrics while sealing representative multipage documents. A local fixture tests the protocol but cannot establish real Google consent-screen configuration, domain routing, or Free-tier CPU usage.

## User experience and privacy

The user chooses a PDF and **Sign in with Google**. QRed flattens supported fields, extracts/canonicalizes page text, computes the document root and generates a fresh 32-byte random salt per page locally. The browser opens Google's sign-in in a separate window. No Google SDK or other provider script is loaded into the document-processing page.

The backend receives randomized page commitments and an optional fallback name. It never receives PDF bytes, filenames, document text, unsalted document roots, salts, or user private keys. Google receives a normal authentication request with random state, nonce and PKCE values; it does not receive document commitments. QRed necessarily processes Google account identity and ordinary request metadata. The seal itself exposes the recovered text, email and name to its readers.

Only Google-signed tokens with the configured audience, issuer, RS256 signature, nonce and valid time claims are accepted. `email_verified` must be the Boolean `true`. The email must be a Gmail address, or the token must contain a Google Workspace/Cloud organization `hd` claim. A Google account merely registered using an outside email address is refused; historical verification of that address is not enough for this flow. The Google `sub` account identifier is included in the signed identity, because email and profile names can change.

### Stateless sign-in and document binding

QRed keeps no per-user or per-request server records. The browser carries short-lived **authenticated-encrypted JWE cookies** (`dir` / `A256GCM`, implemented by `jose`). They are HttpOnly, Secure, SameSite=Lax, host-only cookies with a `__Host-` prefix. HKDF-SHA-256 derives a separate encryption key from the existing high-entropy authority seed, with a QRed-specific domain and the installation's origin, Google client ID and authority key ID as context. No additional secret needs to be provisioned. The server caches only configuration-derived keys and Google's public verification keys, never session records.

Before sign-in, the browser fixes the ordered page commitments. The initial encrypted cookie contains a digest of that list, a hash of a separate random secret retained only in the document window's memory, the fallback name, random nonce, PKCE verifier and a ten-minute expiration. Only random state, nonce and PKCE challenge values go to Google. Storing a digest instead of every commitment keeps cookie size bounded even for 100-page documents.

The callback requires the original request cookie, matching Google nonce, valid PKCE code exchange and a valid Google ID token. Google's `iat` must be an integer no more than **five minutes behind QRed's server clock or 30 seconds ahead**, and cannot predate the initial request by more than 30 seconds. This is the token's issuance time; it does not prove the user just entered a password. The server then fixes its own attestation timestamp. Every page and retry uses that timestamp, even if later requests arrive minutes later.

After authentication, a separate encrypted receipt cookie carries the verified identity, fixed server timestamp, Google issuance time, document-list digest, secret hash and original expiration. It replaces the pending cookie, and contains no Google token, PKCE verifier or nonce. Separate request/receipt cookies prevent a concurrent failed code exchange from overwriting a successful result. Cookie names include the random request ID, allowing separate tabs to seal different documents without mixing their identities or fingerprints.

Status and signature requests require both the cookie and the document window's secret. Every signature request resends the ordered commitments; their digest must match the authenticated cookie before the server signs the selected page. Client-supplied replacement identities, timestamps or additional request fields are rejected. Each signing request handles one page, with an additional fixed key-pair check when a Worker first loads its authority key.

Google enforces single-use authorization codes. QRed deliberately permits repeated requests for the same authorized attestation: retrying cannot change the identity, document, timestamp or expiry. A completed-cookie callback does not exchange Google's code again or renew authorization. The original Google code cannot be exchanged again using a saved pending cookie.

Completion and cancellation send a cookie-clearing request. Failed or in-flight requests can leave cookies until their original expiry. All sessions expire ten minutes after the initial request, as enforced by the server's clock. Clearing a cookie is **not** revocation of copies stolen with the matching in-memory secret; those copies remain usable only for the same document until the original expiry. No refresh token is requested, and no credential is written to localStorage/sessionStorage or navigation URLs. QRed creates no persistent login; Google's own device session remains under Google's controls.

### Service limits and logging

Removing the database also removes QRed's exact daily/per-IP sign-in counters and receipt retry counter. `QRED_DAILY_SIGNIN_LIMIT` is no longer supported. Repeated valid requests can consume service capacity; stateless cryptographic authorization does not count them. Cloudflare's plan limits still apply. Any additional traffic controls belong at the hosting layer and are not automatically purchased or configured by this code.

Request bodies are limited to 16 KiB, each document to 100 pages, and each signing request to one page. Application code does not log bodies, cookies, tokens, identity data or document commitments. Configure infrastructure logging accordingly. These transient encrypted cookies are not part of the printed QR payload and add no QR overhead.

## Compact v4 format

Local signatures keep the existing v3 format. Google attestations use `QRS4`, multipart `QRC4`, and copyable `QRED4:` strings. Ordinary camera apps still see `QRED.ORG`. QR balancing, automatic zlib/plaintext selection (with gzip fallback), and fixed print dimensions use the same rules as local seals.

The v4 record contains the existing timestamp/key-ID/page-context header, followed by:

| Field | Encoding |
| --- | --- |
| Provider | One byte, `1` = Google |
| Name source | One byte, `1` = Google profile, `0` = self-declared |
| Email, name, Google subject | Each is a two-byte big-endian UTF-8 byte length followed by its bytes; maximum 254/160/255 bytes respectively |
| Per-page salt | 32 random bytes, only in the seal/client |
| QRed signature | 64 Ed25519 bytes |
| Text | Plain UTF-8 or one bounded zlib/gzip stream; compression flags match v3 |

The page commitment is SHA-256 of `QRed private page commitment v1` plus a zero byte, salt, the v3 PDF/context flag byte with compression cleared, conditional page-index/count/root bytes, and canonical UTF-8 text. Timestamp/key ID are omitted from this commitment because the server supplies them later. Page positions/counts and the unsalted full-document root are thus committed without exposing that root to the service.

The server signs `QRed Google document attestation v1` plus a zero byte, the eight-byte timestamp, eight-byte key ID, the encoded identity above, and the 32-byte commitment. Each page has its own signature so it can be authenticated independently without carrying a Merkle inclusion proof. All pages in a request share one server timestamp and identity. Identity fields cannot be changed or relabeled without breaking verification. For example, a 20-byte email, 20-byte name and 21-byte subject add 101 bytes per record before QR framing; real names/addresses vary. The signature is stored once per page record, even when that page uses several QR codes.

Offline verifiers trust only keys bundled in `src/trustedAuthorities.json` for v4, selected automatically by the seal's key ID. The verifier has no public-key text field; its key-file import appears only after scanning a local v3 seal. Importing a key for local signatures cannot authorize an unknown Google attestation. Keep previous public keys during routine rotation; remove a compromised key through an app update. Offline copies cannot learn about new revocations until updated. Independent implementations can configure their own authority keys; there is no registry of every user's key.

## Tests and limitations

Tests use synthetic documents and synthetic Google credentials. They cover real RSA JWT verification, native Ed25519 receipts, eligibility, session/cookie/nonce binding, Google/server clock bounds, cookie tampering and browser binding, fixed-timestamp retries, expiry, rejection of changed document metadata and identities, unknown authority keys, QR image recovery and reversed multipart scans. The API tests use fresh Worker handlers for successive requests without a database. The browser-protocol test records every API body and asserts that document text, roots, salts and user keys never leave the client. A Chromium test exercises real HttpOnly cookies, an isolated sign-in window, multipage attestation, cookie cleanup and subsequent offline verification through a local synthetic Google service. Existing browser tests cover local key generation/import, PDF generation, scanning, and network-blocked/offline workflows.

This change does not enable email/SMS/voice methods, purchase services, register an OAuth application, install production secrets, or deploy automatically. Those account-specific settings must be supplied by the operator. The repository includes qred.org's public authority key; Google sealing still requires the matching authority private key and OAuth client secret in the Worker. Independent installations must configure their own authority key pair and Google client.

Primary references: [Google token validation](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [OAuth security best practices](https://www.rfc-editor.org/rfc/rfc9700.html), and [jose encrypted JWTs](https://github.com/panva/jose/blob/main/docs/jwt/encrypt/classes/EncryptJWT.md).
