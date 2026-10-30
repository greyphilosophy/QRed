import { allowedAuthorizationUrl } from "./authProviders.js";
// Only randomized commitments and the short-lived auth session are retained.
// NEVER put PDF bytes, extracted text, page evidence, or private keys here.
// sessionStorage is tab-scoped and survives a same-tab OAuth navigation.
export const PENDING_KEY = "qred:pending-auth:v1";
export const PENDING_MAX_MS = 5 * 60 * 1000;

const validBase64Url = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

export function clearPendingAuth(storage = sessionStorage) {
  storage.removeItem(PENDING_KEY);
}

export function savePendingAuth(session, pageScalingStrategy, storage = sessionStorage) {
  if (!["google", "microsoft", "amazon"].includes(session.provider) ||
      !Array.isArray(session.salts) || !session.salts.length ||
      !Array.isArray(session.commitments) ||
      session.salts.length !== session.commitments.length ||
      !validBase64Url(session.id) || !validBase64Url(session.secret) ||
      !Number.isSafeInteger(session.startedAt) ||
      session.salts.some(salt => !(salt instanceof Uint8Array) || salt.length !== 32) ||
      session.commitments.some(value => !validBase64Url(value))) {
    throw new Error("Invalid document-bound authentication session");
  }
  const data = {
    provider: session.provider, id: session.id, secret: session.secret,
    startedAt: session.startedAt, commitments: session.commitments,
    salts: session.salts.map(salt => Array.from(salt)),
    pageScalingStrategy,
  };
  storage.setItem(PENDING_KEY, JSON.stringify(data));
  return data;
}

export function readPendingAuth(storage = sessionStorage, now = Date.now()) {
  const raw = storage.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || !["google", "microsoft", "amazon"].includes(data.provider) ||
        !validBase64Url(data.id) || !validBase64Url(data.secret) ||
        !Number.isSafeInteger(data.startedAt) ||
        data.startedAt > now || now - data.startedAt >= PENDING_MAX_MS ||
        !Array.isArray(data.salts) || !data.salts.length ||
        !Array.isArray(data.commitments) || data.salts.length !== data.commitments.length ||
        data.commitments.some(value => !validBase64Url(value)) ||
        data.salts.some(salt => !Array.isArray(salt) || salt.length !== 32 ||
          salt.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) ||
        !["automatic", "watermark", "legal-footer", "shrink-footer"].includes(data.pageScalingStrategy)) {
      clearPendingAuth(storage); return null;
    }
    return { ...data, salts: data.salts.map(salt => new Uint8Array(salt)) };
  } catch {
    clearPendingAuth(storage);
    return null;
  }
}

export function navigateToProvider(session, layout, {
  storage = sessionStorage,
  navigate = url => window.location.assign(url),
} = {}) {
  if (!allowedAuthorizationUrl(session.provider, session.authorize_url)) {
    throw new Error("Unexpected provider authorization URL");
  }
  savePendingAuth(session, layout, storage);
  try {
    // No popup, no new tab and no third-party code in QRed.
    navigate(session.authorize_url);
  } catch (error) {
    clearPendingAuth(storage);
    throw error;
  }
}
