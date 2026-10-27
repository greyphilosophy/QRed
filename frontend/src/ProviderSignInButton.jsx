import { authProvider } from "./authProviders.js";

// The prepared OAuth URL is already verified against an exact provider origin.
// A native user-clicked link avoids window.open()'s initial about:blank page,
// which can remain blank when Android pauses the originating browser tab.
export function ProviderSignInButton({ provider, href, disabled = false, onClick, ...props }) {
  const label = authProvider(provider).button;
  if (href && !disabled) return <a {...props} className="account-signin-button"
    href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
    {label}
  </a>;
  return <button {...props} type="button" className="account-signin-button"
    disabled={disabled} onClick={onClick}>{label}</button>;
}
