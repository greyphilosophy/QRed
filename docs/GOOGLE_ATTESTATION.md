# Google document attestations

QRed can attest documents after Google sign-in, with no email/SMS service or paid authentication subscription. Local private-key sealing remains available and works offline. Google is disabled until this installation has a trusted authority key and the server configuration below.

The claim is deliberately limited: QRed authenticated a Google account associated with the recorded email, and attested the prepared document fingerprints at the recorded server time. The display name comes from the Google profile, or is explicitly marked self-declared when Google supplies no name. Neither proves legal identity, organization authority, authorship, or the truth of the document. Existing text-only coverage applies: images, handwriting and page appearance are not authenticated.

## Enable it on the existing Cloudflare Free plan

Keep Workers on the Free plan. No paid plan, email provider, SMS account, or identity broker is required by this implementation. Workers Free has a daily request allowance and a per-request CPU limit. The service caps documents at 100 pages and performs one native Ed25519 signature per request. Production CPU usage still needs to be measured in Cloudflare after deployment; local tests cannot certify its CPU accounting. At a limit, the operation fails with an error; the app does not upgrade a plan or purchase capacity.

1. Register a **Web application** OAuth client in a Google Cloud project. Configure the consent screen with the application homepage and privacy policy. Request only `openid email profile`. Add the exact authorized redirect URI `https://qred.org/api/auth/google/callback`. Publish the OAuth application for its intended audience; while it is in testing, only configured test users can use it. Google Workspace administrators can still prohibit this application.

2. Generate a dedicated QRed authority key **on your own machine**, from `frontend/`:

   ```sh
   node scripts/createAttestationKey.mjs /secure/path/qred-authority.private-key.txt
   ```

   Choose an existing secure directory. The script writes a new private seed file with owner-only permissions and refuses to overwrite a file. It prints only the file path and public key ID. It also adds the public key to `src/trustedAuthorities.json`. Back up the private file securely. Commit the **public JSON file only**, so every verifier build carries the same trust anchor. The private filename is ignored by Git. Never use the demo/test key as the authority.

3. Create a D1 database, using the existing account's included D1 allowance:

   ```sh
   npx wrangler d1 create qred-auth
   ```

   In the Wrangler configuration used for deployment, add the returned database ID:

   ```json
   "d1_databases": [{
     "binding": "QRED_AUTH_DB",
     "database_name": "qred-auth",
     "database_id": "COPY_THE_RETURNED_ID",
     "migrations_dir": "worker/migrations"
   }]
   ```

   That path is for `frontend/wrangler.jsonc`. In the repository-root configuration use `frontend/worker/migrations`. Keep both configurations consistent if both are used. Then, from `frontend/`, apply the schema:

   ```sh
   npx wrangler d1 migrations apply qred-auth --remote
   ```

4. Set these non-secret Worker variables in the configuration actually used to deploy:

   | Variable | Value |
   | --- | --- |
   | `QRED_ORIGIN` | `https://qred.org`, without a trailing slash |
   | `QRED_GOOGLE_CLIENT_ID` | The Google web client's ID |
   | `QRED_ATTESTATION_KEY_ID` | The ID printed by the key-generation script |
   | `QRED_DAILY_SIGNIN_LIMIT` | `100` initially; accepted range 1–1000 |

   Set `QRED_GOOGLE_CLIENT_SECRET` and `QRED_ATTESTATION_PRIVATE_KEY` as **encrypted Worker secrets**, not plain variables or `VITE_` variables. From `frontend/`, Wrangler can read the key through stdin without placing it in shell history or command arguments:

   ```sh
   npx wrangler secret put QRED_GOOGLE_CLIENT_SECRET
   npx wrangler secret put QRED_ATTESTATION_PRIVATE_KEY < /secure/path/qred-authority.private-key.txt
   ```

5. Build and deploy the frontend and Worker together. The existing root/`frontend` Worker configurations support static assets and have an hourly cleanup trigger. The Pages build bundles the Worker dependencies into `_worker.js`; `_routes.json` limits invocation to `/api/*`, leaving static app resources outside the Functions request allowance. If retaining **Pages** hosting, bind D1 and set secrets on that Pages project using its configuration/dashboard rather than the Worker commands above. Pages does not run the Worker's scheduled handler: configure a separate free cleanup Worker or migrate to the existing Worker/static-assets configuration for automatic hourly cleanup. Normal completion deletes its request immediately, and new sign-ins also prune expired records.

6. Test a Gmail account and an eligible Workspace account on the real deployment. Check that an unrelated external email address is refused, cancellation works, and both verifier routes can verify the resulting QR with networking disabled after loading. Check Cloudflare CPU and request metrics while sealing representative multipage documents. A local fixture tests the protocol but cannot establish real Google consent-screen configuration, domain routing, or Free-tier CPU usage.

## User experience and privacy

The user chooses a PDF and **Sign in with Google**. QRed flattens supported fields, extracts/canonicalizes page text, computes the document root and generates a fresh 32-byte random salt per page locally. The browser opens Google's sign-in in a separate window. No Google SDK or other provider script is loaded into the document-processing page.

The backend receives randomized page commitments and an optional fallback name. It never receives PDF bytes, filenames, document text, unsalted document roots, salts, or user private keys. Google receives a normal authentication request with random state, nonce and PKCE values; it does not receive document commitments. QRed necessarily processes Google account identity and ordinary request metadata. The seal itself exposes the recovered text, email and name to its readers.

Only Google-signed tokens with the configured audience, issuer, RS256 signature, nonce and valid time claims are accepted. `email_verified` must be the Boolean `true`. The email must be a Gmail address, or the token must contain a Google Workspace/Cloud organization `hd` claim. A Google account merely registered using an outside email address is refused; historical verification of that address is not enough for this flow. The Google `sub` account identifier is included in the signed identity, because email and profile names can change.

State and PKCE bind the callback to its initial request; an HttpOnly, Secure, SameSite=Lax cookie binds it to the original browser. A separate random secret, held in browser memory, authorizes status/receipt requests. Cookies must work for Google sign-in. The callback is claimed atomically in D1 and cannot be reused. No refresh token is requested and no Google token, session secret or private key is retained in browser storage. QRed uses an account chooser and creates no persistent QRed login; the provider's own device session remains under Google's controls.

Requests expire after ten minutes, are deleted on completion, and have bounded receipt retries. Hourly Worker cleanup removes expired records and rate-limit records older than two days. In Pages deployments without a cleanup schedule, expired records are inaccessible but remain stored until a subsequent sign-in prunes them. Application code does not log bodies, tokens, identity data or document commitments. Configure infrastructure logging accordingly. The default limit is 100 sign-in starts per day for the installation, plus ten starts per IP per ten-minute window. IP rate keys use a daily secret-dependent hash; raw IPs are not stored in D1. Limits can deny service to users sharing a network and should be monitored.

## Compact v4 format

Local signatures keep the existing v3 format. Google attestations use `QRS4`, multipart `QRC4`, and copyable `QRED4:` strings. Ordinary camera apps still see `QRED.ORG`. QR balancing, automatic gzip/plaintext selection and fixed print dimensions are unchanged.

The v4 record contains the existing timestamp/key-ID/page-context header, followed by:

| Field | Encoding |
| --- | --- |
| Provider | One byte, `1` = Google |
| Name source | One byte, `1` = Google profile, `0` = self-declared |
| Email, name, Google subject | Each is a two-byte big-endian UTF-8 byte length followed by its bytes; maximum 254/160/255 bytes respectively |
| Per-page salt | 32 random bytes, only in the seal/client |
| QRed signature | 64 Ed25519 bytes |
| Text | Plain UTF-8 or one bounded gzip stream |

The page commitment is SHA-256 of `QRed private page commitment v1` plus a zero byte, salt, the v3 PDF/context flag byte with compression cleared, conditional page-index/count/root bytes, and canonical UTF-8 text. Timestamp/key ID are omitted from this commitment because the server supplies them later. Page positions/counts and the unsalted full-document root are thus committed without exposing that root to the service.

The server signs `QRed Google document attestation v1` plus a zero byte, the eight-byte timestamp, eight-byte key ID, the encoded identity above, and the 32-byte commitment. Each page has its own signature so it can be authenticated independently without carrying a Merkle inclusion proof. All pages in a request share one server timestamp and identity. Identity fields cannot be changed or relabeled without breaking verification. For example, a 20-byte email, 20-byte name and 21-byte subject add 101 bytes per record before QR framing; real names/addresses vary. The signature is stored once per page record, even when that page uses several QR codes.

Offline verifiers trust only keys bundled in `src/trustedAuthorities.json` for v4. A public key pasted into the local-signature field cannot authorize an unknown Google attestation. Keep previous public keys during routine rotation; remove a compromised key through an app update. Offline copies cannot learn about new revocations until updated. Independent implementations can configure their own authority keys; there is no registry of every user's key.

## Tests and limitations

Tests use synthetic documents and synthetic Google credentials. They cover real RSA JWT verification, native Ed25519 receipts, eligibility, session/cookie/nonce binding, callback replay, expiry, rate limits, rejection of changed document metadata and identities, unknown authority keys, QR image recovery and reversed multipart scans. The browser-protocol test records every API body and asserts that document text, roots, salts and user keys never leave the client. Existing real-browser tests cover local key generation/import, PDF generation, scanning, and network-blocked/offline workflows.

This change does not enable email/SMS/voice methods, purchase services, register an OAuth application, install production secrets, or deploy automatically. Those account-specific settings must be supplied by the operator. The empty default trust list deliberately leaves Google disabled until setup is complete.

Primary references: [Google token validation](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
