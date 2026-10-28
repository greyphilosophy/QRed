// Provider IDs are part of the signed v4 identity; never reuse an assigned ID.
export const AUTH_PROVIDERS = Object.freeze({
  google: { id: 1, label: "Google", button: "Authenticate with Google login" },
  microsoft: { id: 2, label: "Microsoft", button: "Authenticate with Microsoft login" },
  amazon: { id: 4, label: "Amazon", button: "Authenticate with Amazon login" },
});

// Preserve ID 3 for verification of historical seals, not for new logins.
export const IDENTITY_PROVIDERS = Object.freeze({ ...AUTH_PROVIDERS,
  meta: { id: 3, label: "Facebook (legacy)" },
});

export function authProvider(name) {
  return Object.hasOwn(AUTH_PROVIDERS, name) ? AUTH_PROVIDERS[name] : null;
}

export function allowedAuthorizationUrl(provider, value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.hash) return false;
  if (provider === "google") return url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth";
  if (provider === "microsoft") return url.origin === "https://login.microsoftonline.com" && url.pathname === "/common/oauth2/v2.0/authorize";
  if (provider === "amazon") return url.origin === "https://www.amazon.com" && url.pathname === "/ap/oa";
  return false;
}
