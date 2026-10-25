import { authProvider } from "./authProviders.js";
import google from "./assets/google-sign-in-light.png";
import microsoft from "./assets/microsoft-sign-in-light.svg";
import amazon from "./assets/amazon-login.png";
import facebook from "./assets/facebook-icon.png";

const artwork = { google: [google, 180, 40], microsoft: [microsoft, 215, 41], amazon: [amazon, 195, 40] };

export function ProviderSignInButton({ provider, ...props }) {
  const asset = artwork[provider];
  return <button {...props} type="button" className={"account-signin-button" + (provider === "meta" ? " facebook-signin-button" : "")}>
    {asset ? <img src={asset[0]} width={asset[1]} height={asset[2]} alt={authProvider(provider).button} />
      : <><img src={facebook} width="24" height="24" alt="" />Continue with Facebook</>}
  </button>;
}
