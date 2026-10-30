# Account sign-in and document attestations

QRed supports Google, Microsoft, and Login with Amazon alongside offline private-key sealing. Provider buttons are enabled only after QRed has prepared document-bound sign-in sessions. Private-key sealing runs locally without an authentication request if that mode is chosen before selecting a PDF.

### Mobile browser sign-in and document preparation

After the user chooses a PDF and layout, QRed flattens the PDF, extracts the standardized page evidence **locally**, calculates SHA-256 commitments, and obtains short-lived server sessions for configured identity providers. This preparation occurs in the original QRed tab, before any authentication tab is opened. The provider buttons remain disabled until each validated, final provider URL is ready.

A tap on **Authenticate with Google login**, **Authenticate with Microsoft login**, or **Authenticate with Amazon login** opens the *actual provider authorization URL* directly using a native `<a target="_blank" rel="noopener noreferrer">`. Unlike the old flow, no `/auth-pending.html` or blank intermediary window is created, no JavaScript-based redirect needs to run in the backgrounded Android QRed tab, and no second PDF selection is needed. Provider graphics are bundled inline; no third-party login SDK is included in the document page. Users may still have to close the authentication tab manually if their browser blocks `window.close()`.

The original tab retains the PDF and prepared evidence in memory, polls the first-party Worker for the provider's authenticated callback result, then obtains document signatures and saves the finished PDF locally. The user should return to that same QRed tab after signing in, and must not reload or close it until the output file is saved. A **Check sign-in status** control distinguishes pending, ready and failed sessions. Account sessions expire five minutes after preparation, and unused sessions are cleared when possible.

The Cloudflare Worker receives only deterministic SHA-256 page commitments and authentication/session metadata, **not original PDFs, extracted document text or raw document roots**. These unsalted commitments are *not anonymous*: a server operator could recognize repeated commitments or test guesses about common pages. Identity providers receive only OAuth login requests; document commitments are never sent to them. The authenticity claim is limited to successful provider authentication, the page commitments, the returned profile identity and QRed's server timestamp. The finished seals can be verified offline with QRed's trusted authority keys.

## What a seal attests

QRed authenticated the recorded provider account and signed the prepared document commitments at the recorded QRed server time. The name comes from the provider's profile, not a freeform field. Profile names do not prove legal identity, organizational authority, authorship, or the truth of a document. Anyone who scans the seal can read its name, email, and recovered document content.

| Method | Signed account identifier | Email assurance |
| --- | --- | --- |
| Google | Google `sub` | Requires `email_verified: true` and a Gmail address or Workspace `hd` claim. The existing Gmail/Workspace eligibility rule is unchanged. |
| Microsoft | `tid:sub` | Microsoft-reported email. It is mutable and not guaranteed correct. No fallback to `preferred_username` or UPN. |
| Amazon | Amazon `user_id` | Email returned by Amazon's authenticated profile service. QRed does not independently verify mailbox control. |

The verifier names the provider. Microsoft and Amazon seals explicitly label the email as provider-reported. A missing name or email stops sealing with an actionable error. QRed never substitutes a manually entered name or email. Subjects are provider-scoped; Microsoft subjects additionally include the tenant ID.

## Configuration on Cloudflare

Keep the existing `QRED_ORIGIN`, `QRED_ATTESTATION_KEY_ID`, and secret `QRED_ATTESTATION_PRIVATE_KEY`. The corresponding authority public key must already be in `frontend/src/trustedAuthorities.json`. **Do not create a new authority key for each provider.** Independent installations should follow the authority-key instructions in [Google attestation setup](GOOGLE_ATTESTATION.md).

Add the following public settings to the Wrangler configuration used by your deployment. This repository has root and frontend configurations; keep their values consistent. Microsoft needs only its public application ID and a **Single-page application** redirect registered in Azure; do not create a Microsoft client secret. Google and Amazon still require encrypted client secrets in the deployed Worker's **Variables and Secrets**, or through `wrangler secret put NAME` from the corresponding project directory. Do not put secrets in Wrangler `vars`, source control, `VITE_*` variables, frontend code, or this guide.

| Method | Public setting | Encrypted secret | Exact callback URI for qred.org |
| --- | --- | --- | --- |
| Google (existing) | `QRED_GOOGLE_CLIENT_ID` | `QRED_GOOGLE_CLIENT_SECRET` | `https://qred.org/api/auth/google/callback` |
| Microsoft | `QRED_MICROSOFT_CLIENT_ID` | None — browser PKCE | `https://qred.org/api/auth/microsoft/callback` |
| Amazon | `QRED_AMAZON_CLIENT_ID` | `QRED_AMAZON_CLIENT_SECRET` | `https://qred.org/api/auth/amazon/callback` |

`GET /api/auth/config` exposes availability for the three active account methods, never credentials. The settings run on Cloudflare; you do not need to host a server on your laptop.

### Microsoft

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), register an application. For QRed's intended audience, choose accounts in any organizational directory **and personal Microsoft accounts**.
2. Under **Authentication**, remove the existing **Web** redirect URI if it uses the Microsoft callback above. Add **Single-page application** as the platform with the **exact same callback URL**. The URI must be registered under SPA for Microsoft's token endpoint to permit a browser CORS request. Do not enable implicit/hybrid ID-token or access-token grants.
3. Copy the public **Application (client) ID** into `QRED_MICROSOFT_CLIENT_ID` (both Wrangler configurations or the matching deployment variable). **Do not generate a client secret**: the authorization-code exchange uses PKCE in the callback window, while QRed's Worker validates the resulting Microsoft-signed ID token and binds it to the encrypted, document-specific session. This change removes routine Microsoft client-secret rotation.
4. Configure branding, homepage, privacy information, publisher details, and consent as required by the portal. QRed requests only `openid email profile`; it does not call Microsoft Graph, request mail access, or request `offline_access`. Organization policies may still require an administrator's consent or prohibit the app.
5. Test both a personal account and an allowed work/school account. Some Microsoft accounts do not supply an email claim; those accounts cannot seal through this method.

**Microsoft callback troubleshooting:** If Microsoft's own sign-in completes but the QRed callback reports failure, QRed's `/api/auth/microsoft/complete` shows only fixed, sanitized verification categories: unavailable or mismatched signing key, invalid signature or token claims, **exact document-session nonce mismatch**, expired authentication, missing profile name/email, or failure creating a verified receipt. QRed validates Microsoft's signed `iat` as an integer Unix timestamp in UTC seconds and applies a separate five-minute ID-token issuance limit, in addition to the five-minute prepared-document session. A stale issued-at timestamp, an invalid timestamp, and a token issued more than 30 seconds in the future now produce distinct, fixed diagnostics. This distinguishes clocks and token freshness without exposing the JWT or raw claim values; an old token cannot authorize a new document. Never share ID tokens, complete callback URLs, cookies, or browser authorization codes. The `email` scope does **not** guarantee that Microsoft returns an `email` claim. QRed intentionally refuses a seal without one; it does not substitute the mutable `preferred_username` for an email identity. If the browser instead reports a token **exchange** or CORS error, confirm that the redirect URI is registered as **Single-page application** and that its exact URL matches.

References: [app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [ID-token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference), and [issuer and signing-key validation](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens#validate-the-issuer).

### Cloudflare Worker outbound OAuth requests

QRed's Worker uses Cloudflare-supported `redirect: "manual"` when exchanging a provider authorization code. **Cloudflare Workers does not implement the browser Fetch API's `redirect: "error"` mode**: that option throws `TypeError` before Google or Amazon receives any request. In the previous implementation, QRed caught this as a supposed network timeout, making every confidential code exchange fail.

Manual mode **does not** mean QRed trusts or follows provider redirects: every HTTP 3xx code-exchange response is explicitly rejected, and its `Location` header is never followed, returned, or logged. OAuth codes and application secrets are transmitted only to their fixed allowlisted provider token endpoint in the initial request. Cloudflare documents the supported modes in its [Request runtime reference](https://developers.cloudflare.com/workers/runtime-apis/request/).

The bundled tests cover the supported mode, both confidential providers, HTTP code errors, and rejecting 301/302/303/307/308 without forwarding credentials. Re-test a live provider account only after deploying the Worker; no synthetic test substitutes for verifying actual provider access.

### Google callback diagnostics

If an account login reaches `/api/auth/google/callback` but the seal fails, the callback now distinguishes the following stages without displaying codes, tokens, raw provider error messages or secrets:

- **Provider code exchange:** Google displays a bounded HTTP status and allowlisted OAuth protocol code (for example `invalid_client` for rejected app credentials or `invalid_grant` for an invalid/expired code or redirect mismatch).
- **Network request / provider reply:** request timeouts and invalid JSON are identified separately from a provider's HTTP rejection.
- **Google signed identity-token verification:** a failure to validate Google's signed ID token names only the verification category (e.g. signing key unavailable, invalid signature or invalid claims). The raw JWT and provider exception message are never displayed.
- **QRed receipt creation:** unexpected failures after provider verification are distinguished from earlier provider-validation failures.

These are **diagnostic categories**, not evidence that an OAuth provider was compromised. `GET /api/auth/config` checks only whether QRed has the corresponding app ID and secret configured; it **does not verify the correctness** of provider credentials. Always register exactly `https://qred.org/api/auth/google/callback` as the matching provider redirect URI. Only share the sanitized callback page's error text, never the full callback URL (it can contain a single-use OAuth code), provider secrets, cookies or `id_token` values.

### Amazon

1. Open the [Login with Amazon Developer Console](https://developer.amazon.com/loginwithamazon/console/site/lwa/overview.html). Create a **Security Profile** named QRed (or enable Login with Amazon on an existing QRed security profile). Provide a short QRed description, the site's [privacy notice](https://qred.org/privacy.html), and consent-screen branding if requested. This is a **Login with Amazon website integration**, not an Alexa skill or Amazon Pay merchant account.
2. In that security profile, choose **Web Settings → Edit** and add **`https://qred.org/api/auth/amazon/callback`** under **Allowed Return URLs** (not merely Allowed JavaScript Origins). Save the exact HTTPS URL, with no trailing slash, fragment or query string. QRed uses a direct top-level redirect, server-side authorization-code exchange, scope `profile` and PKCE; it doesn't load the Amazon JavaScript SDK, request shipping information, or need Amazon Pay.
3. Copy its **public Client ID** into `QRED_AMAZON_CLIENT_ID` in **both** the repository-root and frontend Wrangler `vars` configurations used for deployment. Set `QRED_AMAZON_CLIENT_SECRET` only as an **encrypted Cloudflare Worker secret** on the deployed `qred` Worker. Never commit the secret, paste it into an issue/PR/chat, place it in `vars` or send it to the browser. The production `/api/auth/config` endpoint should then report `amazon: true`; that reports presence of credentials, not whether Amazon has accepted them.
4. After deployment, test with a harmless PDF and a real Amazon account: the second tab should usually close on success (otherwise use the tab switcher), the original browser tab should finish sealing and save the PDF, and the verifier should identify the provider as Amazon when offline. Also test cancelled consent. QRed's existing five-minute PDF-bound session deadline applies; use **Prepare again** if it expires.

**Troubleshooting:** Amazon failures now distinguish an authorization-code exchange, token-info validation, and customer profile lookup. Exchange failures show only fixed HTTP status and allowlisted OAuth error identifiers (e.g. `invalid_client` for credentials, `invalid_grant` for a rejected/expired code, or `unauthorized_client`). Network timeouts, invalid JSON, unexpected redirects, missing names/emails and profile-account mismatches are classified without leaking codes, client secrets, access tokens, request URLs or untrusted Amazon error descriptions. Share only the sanitized error text, **never** the full callback URL or secret.

References: [security profiles](https://developer.amazon.com/docs/login-with-amazon/security-profile.html), [authorization code grant](https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html), and [customer profile information](https://developer.amazon.com/docs/login-with-amazon/obtain-customer-profile.html).

## Shared protocol and isolation

The [stateless Google protocol](GOOGLE_ATTESTATION.md#stateless-sign-in-and-document-binding) now has a shared implementation in `frontend/worker/accountAuth.js`, `accountSession.js`, and `authProviders.js`. Existing Google entry points remain thin compatibility wrappers.

Each provider has its own `/api/auth/{provider}/start`, `callback`, `status`, and `finish` routes and `/api/attest/{provider}` route. Microsoft additionally has a POST `/api/auth/microsoft/complete` endpoint for its SPA token handoff. The start request fixes the ordered page commitments before login. PKCE, random state, an encrypted HttpOnly pending cookie, and a separate in-memory browser secret bind the flow to that browser and document. The ten-minute cookie expiration is fixed at start; retries cannot renew it or change the identity, page commitments, or server timestamp. Each request can use a fresh Worker instance.

Microsoft receives the one-time PKCE verifier and client ID in a nonce-protected, no-store, same-origin callback page, after the Worker validates the state and pending encrypted cookie. The callback redeems the authorization code directly against Microsoft's CORS-enabled SPA token endpoint and posts **only the ID token** back to QRed's Worker. The Worker checks the ID token signature, audience, issuer, nonce, issuance time and account identity before issuing an attestation receipt. No Microsoft refresh/access token or client secret is kept by QRed. The callback page requires a strict CSP, does not use storage, and strips the one-time authorization code from its address bar.

Provider, client ID, origin, and authority key bind the encrypted sessions. New providers also have distinct cookie-name prefixes, so their cleanup requests cannot clear another provider's session. Renaming a cookie cannot defeat its encryption binding. The callback never accepts a provider or account identity supplied by the browser. Authorization and exchange URLs are fixed allowlists, and server-side provider requests reject redirects. Failure after authentication cannot replace a successful receipt with a new identity.

Google and Microsoft require valid RS256 ID tokens with the configured audience, exact allowed issuer, nonce, expiration, and an integer issuance time. For Google, token issuance may be at most five minutes behind QRed, 30 seconds ahead, and cannot predate the request by more than 30 seconds. For Microsoft, QRed likewise requires an integer Unix-seconds issued-at claim no more than five minutes old, no more than 30 seconds in the future, a valid signed token expiry, and the exact signed random nonce from the separate five-minute document-specific session. Microsoft timestamp failures are categorized without sharing raw JWT claims. Microsoft additionally requires a GUID tenant, a v2 token, and a signing key whose issuer scope matches that tenant. Key discovery always uses a fixed Microsoft endpoint, never an untrusted token's URL. 

Amazon returns an opaque access token. QRed checks it with Amazon's token-info service for the configured audience, Amazon issuer, and remaining lifetime, then obtains the profile using a Bearer header and checks the matching user ID. Amazon's token-info `exp` is remaining seconds, not a Unix timestamp. QRed records its own server time after that check and does not claim Amazon supplied a recent OIDC authentication timestamp. No provider access token, refresh token, or ID token is retained in the receipt cookie or embedded in a seal.

Clearing cookies is not revocation of stolen copies accompanied by the browser secret. Those remain constrained to the same document until the original expiry. Offline verifiers cannot learn of authority-key revocation until the app is updated. These limits are unchanged from Google sealing.

## Compact format and compatibility

Local signatures remain v3. Account attestations use the existing v4 envelope. The provider byte now means `1 = Google`, `2 = Microsoft`, `3 = retired Facebook (verification only)`, `4 = Amazon`; no additional field is added. Name-source byte `1` means that provider's profile. Byte `0` remains readable for legacy self-declared Google names.

Google's signing domain and identity encoding are unchanged, preserving existing Google seals. New providers use `QRed account document attestation v1` followed by a zero byte, then the same timestamp, key ID, encoded identity, and page commitment fields. The provider byte is signed, so changing the claimed provider invalidates the seal. Existing older app copies will not understand new provider IDs; update before verifying these new seals offline.

The name, email, and subject still have limits of 160, 254, and 255 UTF-8 bytes. Their actual sizes affect the QR budget. Microsoft's tenant prefix adds 37 bytes to its subject, within the existing limit. Shared evidence budgeting still reserves bounded identity space before sign-in; it does not add a QR solely to store extra visual evidence.

## Validation before release

Automated tests use synthetic provider responses, real RSA JWT signatures, real Ed25519 document signatures, and real Chromium HttpOnly-cookie/popup behavior. They cover each provider's token rules, cross-provider substitution, renamed cookies, changed client configuration, private document processing, cookie cleanup, and offline verification. Both verifier interfaces display provider-specific identity and email assurance. Existing Google protocol regression tests remain in place.

These tests do not prove that a particular provider app is approved or configured correctly. After setting each provider's credentials, seal a synthetic multipage document through a real account, cancel one attempt, retry, and verify the finished seal through both `/` and `/verify.htm` after disconnecting. Check that the profile name/email/provider are correct, and that private-key sealing still works with the network unavailable. Provider setup, live consent checks, and production deployment are separate operator steps.
