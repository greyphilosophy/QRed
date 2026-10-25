// Preserve the Google entry point for existing clients and protocol fixtures.
import { createAccountAuth } from "./accountAuth.js";
export { googleIdentity, verifyGoogleIdToken } from "./authProviders.js";

export function createGoogleAuth({ verifyToken, ...options } = {}) {
  return createAccountAuth({ ...options, ...(verifyToken ? { verifyTokens: { google: verifyToken } } : {}) });
}
export const handleGoogleAuth = createGoogleAuth();
