# Account sign-in and document attestations

QRed supports Google, Microsoft, Facebook (Meta), and Login with Amazon alongside offline private-key sealing. Each account method is enabled independently after its server credentials are configured. The form checks availability when an account method is selected; private-key sealing does not make that request.

All four use the existing Cloudflare Worker and authority key. No database, user-key registry, authentication subscription, or provider JavaScript SDK is added. The PDF, extracted text, page images, and randomized page salts stay on the device. QRed receives randomized page commitments and account details. The provider receives a sign-in request, without document commitments. Account sealing needs a connection for each document; the resulting seals verify offline with QRed's bundled trusted authority keys.

## What a seal attests

QRed authenticated the recorded provider account and signed the prepared document commitments at the recorded QRed server time. The name comes from the provider's profile, not a freeform field. Profile names do not prove legal identity, organizational authority, authorship, or the truth of a document. Anyone who scans the seal can read its name, email, and recovered document content.

| Method | Signed account identifier | Email assurance |
| --- | --- | --- |
| Google | Google `sub` | Requires `email_verified: true` and a Gmail address or Workspace `hd` claim. The existing Gmail/Workspace eligibility rule is unchanged. |
| Microsoft | `tid:sub` | Microsoft-reported email. It is mutable and not guaranteed correct. No fallback to `preferred_username` or UPN. |
| Facebook (Meta) | App-scoped Graph `user_id` | Email reported by Facebook's authenticated `/me` profile. QRed does not independently verify mailbox control. |
| Amazon | Amazon `user_id` | Email returned by Amazon's authenticated profile service. QRed does not independently verify mailbox control. |

The verifier names the provider. Microsoft, Facebook, and Amazon seals explicitly label the email as provider-reported. A missing name or email stops sealing with an actionable error. QRed never substitutes a manually entered name or email. Subjects are provider-scoped; Microsoft subjects additionally include the tenant ID.

## Configuration on Cloudflare

Keep the existing `QRED_ORIGIN`, `QRED_ATTESTATION_KEY_ID`, and secret `QRED_ATTESTATION_PRIVATE_KEY`. The corresponding authority public key must already be in `frontend/src/trustedAuthorities.json`. **Do not create a new authority key for each provider.** Independent installations should follow the authority-key instructions in [Google attestation setup](GOOGLE_ATTESTATION.md).

Add the following public settings to the Wrangler configuration used by your deployment. This repository has root and frontend configurations; keep their values consistent. Microsoft needs only its public application ID and a **Single-page application** redirect registered in Azure; do not create a Microsoft client secret. Google, Meta, and Amazon still require encrypted client secrets in the deployed Worker's **Variables and Secrets**, or through `wrangler secret put NAME` from the corresponding project directory. Do not put secrets in Wrangler `vars`, source control, `VITE_*` variables, frontend code, or this guide.

| Method | Public setting | Encrypted secret | Exact callback URI for qred.org |
| --- | --- | --- | --- |
| Google (existing) | `QRED_GOOGLE_CLIENT_ID` | `QRED_GOOGLE_CLIENT_SECRET` | `https://qred.org/api/auth/google/callback` |
| Microsoft | `QRED_MICROSOFT_CLIENT_ID` | None — browser PKCE | `https://qred.org/api/auth/microsoft/callback` |
| Facebook (Meta) | `QRED_META_APP_ID` | `QRED_META_APP_SECRET` | `https://qred.org/api/auth/meta/callback` |
| Amazon | `QRED_AMAZON_CLIENT_ID` | `QRED_AMAZON_CLIENT_SECRET` | `https://qred.org/api/auth/amazon/callback` |

Meta also uses `QRED_META_GRAPH_VERSION`, initially `v26.0`. Match it to a version supported by your Meta app. Changing it affects both authorization and token exchange. Missing credentials keep only that provider unavailable. `GET /api/auth/config` exposes four booleans, never credentials. These settings run on Cloudflare; you do not need to host a server on your laptop.

### Microsoft

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), register an application. For QRed's intended audience, choose accounts in any organizational directory **and personal Microsoft accounts**.
2. Under **Authentication**, remove the existing **Web** redirect URI if it uses the Microsoft callback above. Add **Single-page application** as the platform with the **exact same callback URL**. The URI must be registered under SPA for Microsoft's token endpoint to permit a browser CORS request. Do not enable implicit/hybrid ID-token or access-token grants.
3. Copy the public **Application (client) ID** into `QRED_MICROSOFT_CLIENT_ID` (both Wrangler configurations or the matching deployment variable). **Do not generate a client secret**: the authorization-code exchange uses PKCE in the callback window, while QRed's Worker validates the resulting Microsoft-signed ID token and binds it to the encrypted, document-specific session. This change removes routine Microsoft client-secret rotation.
4. Configure branding, homepage, privacy information, publisher details, and consent as required by the portal. QRed requests only `openid email profile`; it does not call Microsoft Graph, request mail access, or request `offline_access`. Organization policies may still require an administrator's consent or prohibit the app.
5. Test both a personal account and an allowed work/school account. Some Microsoft accounts do not supply an email claim; those accounts cannot seal through this method.

References: [app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [ID-token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference), and [issuer and signing-key validation](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens#validate-the-issuer).

### Facebook (Meta)

1. Create a Meta developer app with **Facebook Login** for a website. Configure qred.org as the app domain/site and the exact Meta callback above as a valid OAuth redirect URI. Enable the web/server OAuth settings required by the app dashboard.
2. Configure the app's name, contact details, privacy-policy URL, and user-data deletion information. QRed requests only `public_profile,email`. Complete the access/review/publishing requirements shown for this app and its intended audience; development-mode access is limited to eligible app roles/test accounts.
3. Put the App ID in `QRED_META_APP_ID` and App Secret in `QRED_META_APP_SECRET`.
4. **Test standard Facebook Login with an app-role account before enabling public access.** The standard OAuth code exchange returns an opaque user access token, not necessarily an OpenID Connect `id_token`. QRed exchanges the one-time authorization code on the Worker, calls Meta's Graph `debug_token` with its private app credential, requires a valid non-expired USER token issued to QRed's exact App ID with the email scope, and checks that the authenticated `/me?fields=id,name,email` profile has the matching app-scoped user ID. Missing account name or email fails closed. The account token is neither included in a QRed seal nor retained in QRed's encrypted session receipt.
5. Test consent denial, missing/withheld email, and a real successful sign-in. Enable the public method only after the app's access requirements and this live test pass.

The web flow uses Meta's standard server-side authorization code exchange and Graph API; it does not rely on experimental browser OIDC issuance or mobile-only Limited Login. The Worker authenticates the resulting token directly with Meta and does not interpret a returned email address as verified proof of mailbox ownership. Reference: [Facebook Login manual OAuth flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow), [Meta token debugging](https://developers.facebook.com/docs/facebook-login/guides/access-tokens#debug), and [Facebook Login user experience](https://developers.facebook.com/documentation/facebook-login/userexperience).

### Amazon

1. In the [Amazon Developer Console](https://developer.amazon.com/), create a security profile and enable **Login with Amazon**. Supply the profile name, description, and privacy notice required by the console.
2. In that profile's Web Settings, add the exact Amazon callback above to **Allowed Return URLs**. QRed uses server-side authorization code exchange with scope `profile`; it does not need the Amazon JavaScript SDK, shipping-address access, Amazon Pay, or an Alexa integration.
3. Put the Client ID in `QRED_AMAZON_CLIENT_ID` and the Client Secret in `QRED_AMAZON_CLIENT_SECRET`.
4. Test a real Amazon account, consent denial, and offline verification of the resulting seal.

References: [security profiles](https://developer.amazon.com/docs/login-with-amazon/security-profile.html), [authorization code grant](https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html), and [customer profile information](https://developer.amazon.com/docs/login-with-amazon/obtain-customer-profile.html).

## Shared protocol and isolation

The [stateless Google protocol](GOOGLE_ATTESTATION.md#stateless-sign-in-and-document-binding) now has a shared implementation in `frontend/worker/accountAuth.js`, `accountSession.js`, and `authProviders.js`. Existing Google entry points remain thin compatibility wrappers.

Each provider has its own `/api/auth/{provider}/start`, `callback`, `status`, and `finish` routes and `/api/attest/{provider}` route. Microsoft additionally has a POST `/api/auth/microsoft/complete` endpoint for its SPA token handoff. The start request fixes the ordered page commitments before login. PKCE, random state, an encrypted HttpOnly pending cookie, and a separate in-memory browser secret bind the flow to that browser and document. The ten-minute cookie expiration is fixed at start; retries cannot renew it or change the identity, page commitments, or server timestamp. Each request can use a fresh Worker instance.

Microsoft receives the one-time PKCE verifier and client ID in a nonce-protected, no-store, same-origin callback page, after the Worker validates the state and pending encrypted cookie. The callback redeems the authorization code directly against Microsoft's CORS-enabled SPA token endpoint and posts **only the ID token** back to QRed's Worker. The Worker checks the ID token signature, audience, issuer, nonce, issuance time and account identity before issuing an attestation receipt. No Microsoft refresh/access token or client secret is kept by QRed. The callback page requires a strict CSP, does not use storage, and strips the one-time authorization code from its address bar.

Provider, client ID, origin, and authority key bind the encrypted sessions. New providers also have distinct cookie-name prefixes, so their cleanup requests cannot clear another provider's session. Renaming a cookie cannot defeat its encryption binding. The callback never accepts a provider or account identity supplied by the browser. Authorization and exchange URLs are fixed allowlists, and server-side provider requests reject redirects. Failure after authentication cannot replace a successful receipt with a new identity.

Google and Microsoft require valid RS256 ID tokens with the configured audience, exact allowed issuer, nonce, expiration, and a recent integer issuance time. Token issuance may be at most five minutes behind QRed, 30 seconds ahead, and cannot predate the request by more than 30 seconds. Microsoft additionally requires a GUID tenant, a v2 token, and a signing key whose issuer scope matches that tenant. Key discovery always uses a fixed Microsoft endpoint, never an untrusted token's URL. Facebook instead uses short-lived OAuth authorization codes bound to server-side session state and verifies the resulting opaque access token with Meta's token debugger before looking up a matching profile; this validates the Meta account but not the time of the user's most recent password entry.

Amazon returns an opaque access token. QRed checks it with Amazon's token-info service for the configured audience, Amazon issuer, and remaining lifetime, then obtains the profile using a Bearer header and checks the matching user ID. Amazon's token-info `exp` is remaining seconds, not a Unix timestamp. QRed records its own server time after that check and does not claim Amazon supplied a recent OIDC authentication timestamp. No provider access token, refresh token, or ID token is retained in the receipt cookie or embedded in a seal.

Clearing cookies is not revocation of stolen copies accompanied by the browser secret. Those remain constrained to the same document until the original expiry. Offline verifiers cannot learn of authority-key revocation until the app is updated. These limits are unchanged from Google sealing.

## Compact format and compatibility

Local signatures remain v3. Account attestations use the existing v4 envelope. The provider byte now means `1 = Google`, `2 = Microsoft`, `3 = Meta`, `4 = Amazon`; no additional field is added. Name-source byte `1` means that provider's profile. Byte `0` remains readable for legacy self-declared Google names.

Google's signing domain and identity encoding are unchanged, preserving existing Google seals. New providers use `QRed account document attestation v1` followed by a zero byte, then the same timestamp, key ID, encoded identity, and page commitment fields. The provider byte is signed, so changing the claimed provider invalidates the seal. Existing older app copies will not understand new provider IDs; update before verifying these new seals offline.

The name, email, and subject still have limits of 160, 254, and 255 UTF-8 bytes. Their actual sizes affect the QR budget. Microsoft's tenant prefix adds 37 bytes to its subject, within the existing limit. Shared evidence budgeting still reserves bounded identity space before sign-in; it does not add a QR solely to store extra visual evidence.

## Validation before release

Automated tests use synthetic provider responses, real RSA JWT signatures, real Ed25519 document signatures, and real Chromium HttpOnly-cookie/popup behavior. They cover each provider's token rules, cross-provider substitution, renamed cookies, changed client configuration, private document processing, cookie cleanup, and offline verification. Both verifier interfaces display provider-specific identity and email assurance. Existing Google protocol regression tests remain in place.

These tests do not prove that a particular provider app is approved or configured correctly. After setting each provider's credentials, seal a synthetic multipage document through a real account, cancel one attempt, retry, and verify the finished seal through both `/` and `/verify.htm` after disconnecting. Check that the profile name/email/provider are correct, and that private-key sealing still works with the network unavailable. Provider setup, live consent checks, and production deployment are separate operator steps.
