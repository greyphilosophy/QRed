import { EncryptJWT, jwtDecrypt } from "jose";
import { decodeFixedBase64 } from "../src/attestation.js";
import { utf8 } from "../src/sealFormat.js";

export const SESSION_SECONDS = 600;
let cachedKey;

async function encryptionKey(env, origin) {
  const seed = env.QRED_ATTESTATION_PRIVATE_KEY?.trim();
  const context = JSON.stringify([origin, env.QRED_GOOGLE_CLIENT_ID, env.QRED_ATTESTATION_KEY_ID]);
  if (cachedKey?.seed === seed && cachedKey?.context === context) return cachedKey.promise;
  // Derive a separate encryption key from the high-entropy authority seed.
  // Neither this key nor the seed is ever sent to the browser.
  const promise = (async () => {
    const key = await crypto.subtle.importKey("raw", decodeFixedBase64(seed, 32), "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256",
      salt: utf8.encode("QRed stateless Google session v1"), info: utf8.encode(context) }, key, 256));
  })();
  cachedKey = { seed, context, promise };
  return promise;
}

const cookieName = (id, kind) => `__Host-qred-${kind}-${id}`;
const attributes = "; Path=/; HttpOnly; Secure; SameSite=Lax";
const tokenType = kind => `qred-google-${kind}+jwt`;

export function cookieSessions(env, origin, now) {
  return {
    async read(request, id, kind) {
      const name = cookieName(id, kind) + "=";
      const matches = (request.headers.get("Cookie") || "").split(";").map(v => v.trim()).filter(v => v.startsWith(name));
      if (!matches.length) return null;
      if (matches.length !== 1) throw new Error("Ambiguous session cookie");
      const token = matches[0].slice(name.length);
      if (token.length > 3500) throw new Error("Session cookie is too large");
      const { payload } = await jwtDecrypt(token, await encryptionKey(env, origin), {
        keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"], typ: tokenType(kind),
        issuer: origin, audience: env.QRED_GOOGLE_CLIENT_ID,
        requiredClaims: ["iat", "exp", "id", "status", "secret_hash", "key_id"], currentDate: new Date(now()),
      });
      if (payload.id !== id || payload.key_id !== env.QRED_ATTESTATION_KEY_ID ||
          !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
          payload.iat > Math.floor(now() / 1000) || payload.exp <= payload.iat || payload.exp - payload.iat > SESSION_SECONDS ||
          !/^[A-Za-z0-9_-]{43}$/.test(payload.secret_hash)) throw new Error("Invalid session cookie");
      return payload;
    },
    async write(id, kind, payload) {
      const token = await new EncryptJWT({ ...payload, id, key_id: env.QRED_ATTESTATION_KEY_ID })
        .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: tokenType(kind) })
        .setIssuer(origin).setAudience(env.QRED_GOOGLE_CLIENT_ID).encrypt(await encryptionKey(env, origin));
      if (token.length > 3500) throw new Error("Session cookie is too large");
      return cookieName(id, kind) + "=" + token + attributes + "; Max-Age=" + Math.max(0, payload.exp - Math.floor(now() / 1000));
    },
    clear: (id, kind) => cookieName(id, kind) + "=" + attributes + "; Max-Age=0",
  };
}
