import { allowedAuthorizationUrl } from "./authProviders.js";

// Amazon's mobile OAuth redirect can leave a native link-opened tab that
// Chrome refuses to close. Once PDF preparation is complete, a *direct*
// window.open(finalUrl) on the user's tap makes the tab script-created.
// Unlike the historical blank-popup bug, there is no asynchronous placeholder
// or delayed navigation: the final, allowlisted URL is supplied immediately.
//
// A returned WindowProxy temporarily has an opener: sever it synchronously,
// before the new cross-origin document can execute. If opening is blocked (or
// the opener cannot be severed), the caller leaves the native anchor intact.
export function openAmazonSignInTab(url, open = (address) => window.open(address, "_blank")) {
  if (!allowedAuthorizationUrl("amazon", url)) return false;
  let popup;
  try { popup = open(url); } catch { return false; }
  if (!popup) return false;
  try {
    popup.opener = null;
    if (popup.opener !== null) {
      try { popup.close(); } catch { /* Browser controls tab closing. */ }
      return false;
    }
  } catch {
    try { popup.close(); } catch { /* Browser controls tab closing. */ }
    return false;
  }
  return true;
}
