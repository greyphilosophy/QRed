import { beforeAll, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAccountAuth } from "./accountAuth.js";
import { cookieSessions } from "./accountSession.js";
import { verifyMicrosoftIdToken } from "./authProviders.js";

const origin = "https://qred.test", epoch = Date.parse("2026-10-25T12:00:00Z");
const tenant = "11111111-2222-3333-4444-555555555555";
const issuer = "https://login.microsoftonline.com/" + tenant + "/v2.0";
const keyId = "da522162396ab2d0";
const env = { QRED_ORIGIN: origin, QRED_MICROSOFT_CLIENT_ID: "microsoft-client",
  QRED_ATTESTATION_PRIVATE_KEY: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", QRED_ATTESTATION_KEY_ID: keyId };
const trusted = { [keyId]: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q" };
const commitments = ["AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"];
let rsa, keys;
beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);
  rsa = await generateKeyPair("RS256", { extractable: true });
  keys = createLocalJWKSet({ keys: [{ ...await exportJWK(rsa.publicKey), kid: "test-key", alg: "RS256", issuer }] });
});

function fixture() {
  let time = epoch, afterVerification;
  const verify = vi.fn(async (value, clientId, now) => {
    const payload = await verifyMicrosoftIdToken(value, clientId, now, keys);
    afterVerification?.();
    return payload;
  });
  const handler = createAccountAuth({ trusted, now: () => time, verifyTokens: { microsoft: verify } });
  const post = (action, body, cookie = "") => handler(new Request(origin + "/api/auth/microsoft/" + action, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  }), env);
  return {
    post, verify,
    at: next => { time = next; },
    afterVerify: callback => { afterVerification = callback; },
    async start() {
      const response = await post("start", { commitments });
      expect(response.status).toBe(200);
      const session = await response.json();
      return { ...session, cookie: response.headers.getSetCookie()[0].split(";")[0],
        nonce: new URL(session.authorize_url).searchParams.get("nonce") };
    },
    token: (session, changes = {}) => new SignJWT({
      sub: "test-account", tid: tenant, ver: "2.0", name: "Test Account", email: "test@example.org",
      nonce: session.nonce, iat: epoch / 1000 - 35 * 60, nbf: epoch / 1000 - 300,
      exp: epoch / 1000 + 3600, ...changes,
    }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(issuer)
      .setAudience(env.QRED_MICROSOFT_CLIENT_ID).sign(rsa.privateKey),
  };
}

it("accepts earlier Microsoft authentication time without renewing the document deadline or receipt", async () => {
  const flow = fixture(), session = await flow.start(), idToken = await flow.token(session);
  flow.at(epoch + 299_000);
  const response = await flow.post("complete", { id: session.id, id_token: idToken }, session.cookie);
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().find(value => value.includes("receipt-")).split(";")[0];
  const receipt = await cookieSessions(env, origin, () => epoch + 299_000, "microsoft", env.QRED_MICROSOFT_CLIENT_ID)
    .read(new Request(origin, { headers: { Cookie: cookie } }), session.id, "receipt");
  expect(receipt.exp).toBe(epoch / 1000 + 300);
  expect(receipt.iat).toBe(epoch / 1000 + 299);
  expect(receipt.provider_iat).toBe(epoch / 1000 - 35 * 60);
  expect(receipt.issued_at).toBe(new Date(epoch + 299_000).toISOString());
  // Duplicate completion cannot mint a new timestamp or extend the session.
  const duplicate = await flow.post("complete", { id: session.id, id_token: idToken }, cookie);
  expect(duplicate.status).toBe(200);
  expect(duplicate.headers.getSetCookie()).toEqual([]);
  expect(flow.verify).toHaveBeenCalledOnce();
  flow.at(epoch + 300_000);
  expect((await flow.post("status", { id: session.id, secret: session.secret }, cookie)).status).toBe(403);
});

it("rejects a cached signed token from a different document attempt", async () => {
  const flow = fixture(), first = await flow.start(), second = await flow.start();
  expect(second.nonce).not.toBe(first.nonce);
  const response = await flow.post("complete", { id: second.id, id_token: await flow.token(first) }, second.cookie);
  expect(response.status).toBe(403);
  expect((await response.json()).error).toContain("nonce did not match");
});

it("rejects a matching signed token at the exact five-minute document deadline", async () => {
  const flow = fixture(), session = await flow.start(), idToken = await flow.token(session);
  flow.at(epoch + 300_000);
  expect((await flow.post("complete", { id: session.id, id_token: idToken }, session.cookie)).status).toBe(403);
  expect(flow.verify).not.toHaveBeenCalled();
});

it("rejects matching tokens when verification crosses the document deadline", async () => {
  const flow = fixture(), session = await flow.start(), idToken = await flow.token(session);
  flow.at(epoch + 299_000);
  flow.afterVerify(() => flow.at(epoch + 300_000));
  const response = await flow.post("complete", { id: session.id, id_token: idToken }, session.cookie);
  expect(response.status).toBe(403);
  expect((await response.json()).error).toContain("request expired");
  expect(response.headers.getSetCookie().some(value => value.includes("receipt-"))).toBe(false);
});
