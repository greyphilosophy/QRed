import React, { useEffect, useRef, useState } from "react";
import { renderGoogleButton } from "./providerSdkAuth.js";

const MICROSOFT_BUTTON =
  "https://learn.microsoft.com/en-us/entra/identity-platform/media/howto-add-branding-in-apps/ms-symbollockup_signin_light.svg";
const AMAZON_BUTTON =
  "https://images-na.ssl-images-amazon.com/images/G/01/lwa/btnLWA_gold_156x32.png";

export function ProviderSdkButtons({
  clientIds, sdkReady, nonce, busy, onGoogleClick, onGoogleCredential,
  onMicrosoftClick, onAmazonClick, onError,
}) {
  const googleContainer = useRef(null);
  const latest = useRef({});
  const [googleReady, setGoogleReady] = useState(false);
  latest.current = { onGoogleClick, onGoogleCredential, onError };
  useEffect(() => {
    let current = true;
    setGoogleReady(false);
    if (!clientIds?.google || busy || !nonce) return () => { current = false; };
    renderGoogleButton(googleContainer.current, {
      clientId: clientIds.google, nonce,
      onClick: () => latest.current.onGoogleClick(),
      onCredential: value => latest.current.onGoogleCredential(value),
    }).then(() => { if (current) setGoogleReady(true); }).catch(error => {
      if (current) latest.current.onError(error.message);
    });
    return () => { current = false; };
  }, [clientIds?.google, nonce, busy]);

  return <div className="sealing-method-grid sdk-signin-grid" aria-label="Account sign-in options">
    <div className="sdk-signin-provider" aria-label="Sign in with Google">
      <div ref={googleContainer} className="google-signin-rendered" />
      {!googleReady && <span className="key-help" role="status">Loading Google sign-in…</span>}
    </div>
    <button type="button" className="sdk-signin-provider" onClick={onMicrosoftClick}
      disabled={busy || !sdkReady.microsoft || !clientIds?.microsoft}
      aria-label="Sign in with Microsoft">
      <img alt="Sign in with Microsoft" src={MICROSOFT_BUTTON} />
    </button>
    <button type="button" className="sdk-signin-provider" onClick={onAmazonClick}
      disabled={busy || !sdkReady.amazon || !clientIds?.amazon}
      aria-label="Login with Amazon">
      <img alt="Login with Amazon" src={AMAZON_BUTTON} />
    </button>
  </div>;
}
