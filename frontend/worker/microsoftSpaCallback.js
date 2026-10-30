// Microsoft is a public SPA client: its authorization code is redeemed in the
// callback window with PKCE. The Worker still validates the signed ID token
// and binds the resulting identity to the document's encrypted session.
//
// The verifier and client ID are public-client values, not client secrets.
// They are delivered only to the same-origin callback document, over HTTPS.
const escapeScriptJson = value => JSON.stringify(value)
  .replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
  .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function microsoftSpaCallbackPage({ id, code, verifier, clientId, sameTab = false }) {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = Array.from(nonceBytes, byte => byte.toString(16).padStart(2, "0")).join("");
  const settings = escapeScriptJson({ id, code, verifier, clientId, sameTab });
  const script = `(async () => {
    const { id, code, verifier, clientId, sameTab } = ${settings};
    const status = document.getElementById("status");
    // Remove the one-time authorization code from the browser address bar.
    history.replaceState(null, "", "/api/auth/microsoft/callback");
    const complete = body => fetch("/api/auth/microsoft/complete", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body })
    });
    try {
      const tokenResponse = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId, code, code_verifier: verifier, grant_type: "authorization_code",
          redirect_uri: location.origin + "/api/auth/microsoft/callback",
          scope: "openid email profile"
        })
      });
      if (!tokenResponse.ok) throw new Error("Microsoft declined the sign-in exchange. Check that this redirect URI is registered under Single-page application in Azure.");
      const tokens = await tokenResponse.json();
      if (typeof tokens.id_token !== "string" || !tokens.id_token) throw new Error("Microsoft did not provide an identity token.");
      const result = await complete({ id_token: tokens.id_token });
      if (!result.ok) {
        const message = await result.json();
        throw new Error(message.error || "QRed could not verify the Microsoft identity.");
      }
      if (sameTab) {
        location.replace("/?qred_auth=returned");
        return;
      }
      status.textContent = "Microsoft sign-in completed. Return to the QRed document window.";
      if (window.opener) window.opener.postMessage({ type: "qred-account-complete", id }, location.origin);
      window.close();
    } catch (error) {
      // End the document-bound session promptly instead of leaving the main
      // window polling for ten minutes. The server chooses the error message.
      await complete({ error: "failed" }).catch(() => {});
      if (sameTab) {
        location.replace("/?qred_auth=returned");
        return;
      }
      status.textContent = error instanceof Error ? error.message : "Microsoft sign-in failed. Return to QRed and try again.";
    }
  })();`;
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce + "'; connect-src 'self' https://login.microsoftonline.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  return new Response(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>QRed Microsoft sign-in</title></head>" +
    "<body><p id=\"status\" role=\"status\">Completing Microsoft sign-in securely…</p>" +
    "<script nonce=\"" + nonce + "\">" + script + "</script></body></html>",
    { headers }
  );
}
