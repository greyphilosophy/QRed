import { authProvider } from "./authProviders.js";

// Keep the same action wording and geometry for every account provider.
// This button opens the real provider page after the local PDF preparation step;
// it does not request or process documents through an external sign-in SDK.
export function ProviderSignInButton({ provider, ...props }) {
  return <button {...props} type="button" className="account-signin-button">
    {authProvider(provider).button}
  </button>;
}
