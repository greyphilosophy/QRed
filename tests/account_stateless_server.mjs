// Local-only browser test bridge. All providers, identities, codes and keys are synthetic.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";

const frontend = fileURLToPath(new URL("../frontend/", import.meta.url));
const require = createRequire(resolve(frontend, "package.json"));
const { build } = require("esbuild");
const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import(pathToFileURL(require.resolve("jose")));
const compile = async options => (await build({ bundle: true, format: "esm", write: false, ...options })).outputFiles[0].text;
const backend = await compile({ platform: "node", stdin: { resolveDir: frontend, loader: "js", contents:
  'export { createAccountAuth } from "./worker/accountAuth.js"; export { verifyGoogleIdToken, verifyMicrosoftIdToken, verifyMetaIdToken } from "./worker/authProviders.js";' } });
const { createAccountAuth, verifyGoogleIdToken, verifyMicrosoftIdToken, verifyMetaIdToken } = await import("data:text/javascript;base64," + Buffer.from(backend).toString("base64"));
const origin = "https://qred.test";
const provider = process.argv[2] || "google";
const providerOrigins = { google: "https://accounts.google.com", microsoft: "https://login.microsoftonline.com", meta: "https://www.facebook.com", amazon: "https://www.amazon.com" };
if (!Object.hasOwn(providerOrigins, provider)) throw new Error("Unknown synthetic provider");
const tenant = "11111111-2222-3333-4444-555555555555";
const issuer = provider === "microsoft" ? "https://login.microsoftonline.com/" + tenant + "/v2.0" : providerOrigins[provider];
const seed = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const keyId = "da522162396ab2d0";
const trusted = { [keyId]: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q" };
const env = { QRED_ORIGIN: origin, QRED_GOOGLE_CLIENT_ID: "browser-test-client", QRED_GOOGLE_CLIENT_SECRET: "synthetic-secret",
  QRED_MICROSOFT_CLIENT_ID: "browser-test-client",
  QRED_META_APP_ID: "browser-test-client", QRED_META_APP_SECRET: "synthetic-secret",
  QRED_AMAZON_CLIENT_ID: "browser-test-client", QRED_AMAZON_CLIENT_SECRET: "synthetic-secret",
  QRED_ATTESTATION_PRIVATE_KEY: seed, QRED_ATTESTATION_KEY_ID: keyId };
const rsa = await generateKeyPair("RS256", { extractable: true });
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(rsa.publicKey), kid: "synthetic-provider-key", alg: "RS256", issuer: "https://login.microsoftonline.com/{tenantid}/v2.0" }] });
const codes = new Map(); // This is the fake provider's state, not QRed's.
async function exchange(url, options) {
  if (provider === "meta" && url.startsWith("https://graph.facebook.com/v26.0/debug_token?")) {
    const params = new URL(url).searchParams;
    if (params.get("input_token") !== "synthetic-meta-token" || params.get("access_token") !== "browser-test-client|synthetic-secret") {
      return new Response("Invalid Meta token", { status: 403 });
    }
    return Response.json({ data: { is_valid: true, app_id: "browser-test-client", type: "USER",
      user_id: "browser-test-user", expires_at: Math.floor(Date.now() / 1000) + 3600, scopes: ["email"] } });
  }
  if (provider === "meta" && url.startsWith("https://graph.facebook.com/v26.0/me?")) {
    const params = new URL(url).searchParams;
    if (options.headers.Authorization !== "Bearer synthetic-meta-token" || !/^[0-9a-f]{64}$/.test(params.get("appsecret_proof") || "")) {
      return new Response("Invalid Meta profile proof", { status: 403 });
    }
    return Response.json({ id: "browser-test-user", email: "browser.test@example.org", name: "Browser Test" });
  }
  if (provider === "amazon" && url.startsWith("https://api.amazon.com/auth/o2/tokeninfo?")) return Response.json({
    iss: "https://www.amazon.com", aud: "browser-test-client", user_id: "browser-test-user", exp: 3599 });
  if (provider === "amazon" && url === "https://api.amazon.com/user/profile") return Response.json({
    user_id: "browser-test-user", email: "browser.test@example.org", name: "Browser Test" });
  const params = provider === "meta" ? new URL(url).searchParams : options.body;
  const code = params.get("code"), grant = codes.get(code);
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(params.get("code_verifier")))).toString("base64url");
  if (!grant || grant.challenge !== challenge || params.get("client_id") !== "browser-test-client" ||
      (provider !== "microsoft" && params.get("client_secret") !== "synthetic-secret") ||
      (provider === "microsoft" && params.has("client_secret")) ||
      params.get("redirect_uri") !== origin + "/api/auth/" + provider + "/callback") return new Response("invalid_grant", { status: 400 });
  codes.delete(code);
  if (provider === "amazon") return Response.json({ access_token: "opaque-token", token_type: "bearer", expires_in: 3600 });
  if (provider === "meta") return Response.json({ access_token: "synthetic-meta-token", token_type: "bearer", expires_in: 3600 });
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sub: "browser-test-user", email: "browser.test@gmail.com", email_verified: true,
    name: "Browser Test", nonce: grant.nonce, ...(provider === "microsoft" ? { tid: tenant, ver: "2.0" } : {}) })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-provider-key" }).setIssuer(issuer)
    .setAudience("browser-test-client").setIssuedAt(now).setExpirationTime(now + 3600).sign(rsa.privateKey);
  return Response.json({ id_token: token });
}
// The optional Node PNG renderer is not used by browser sealing/verification.
const client = await compile({ platform: "browser", external: ["qrcode/lib/renderer/png"], stdin: { resolveDir: frontend, loader: "js", contents: `
  import { attestPagesWithAccount } from "./src/accountSealing.js";
  import { createQRedSeals } from "./src/qredSealer.js";
  import { encodePageEvidence } from "./src/pageEvidence.js";
  import { verifyQRedSeals } from "./src/qredVerifier.js";
  const trusted = ${JSON.stringify(trusted)};
  const contents = ["Synthetic private page one",
    encodePageEvidence({ width: 612, height: 792, visual: { codebook: 1, columns: 2, rows: 2, indices: new Uint8Array([0, 15, 7, 8]) } }),
    encodePageEvidence({ width: 612, height: 792, blank: true })];
  const pages = contents.map((content, i) => ({
    content, metadata: { pdf: true, ...(i ? { page_evidence: true } : {}), page_number: i + 1, page_count: 3, document_root: "d4".repeat(32) }
  }));
  let seals;
  window.verifyOffline = () => Promise.all(seals.map(seal => verifyQRedSeals(seal.seals, "", trusted)));
  document.querySelector("button").onclick = async () => {
    const output = document.querySelector("output");
    try {
      const receipts = await attestPagesWithAccount(${JSON.stringify(provider)}, pages, { popup: window.open("about:blank", "qred-account"), trusted });
      seals = await Promise.all(pages.map((page, index) => createQRedSeals({ content: index ? "" : page.content, pageEvidence: index ? page.content : null, attestation: receipts[index],
        pageContext: { pageNumber: index + 1, pageCount: 3, documentRoot: page.metadata.document_root } })));
      const results = await window.verifyOffline();
      output.textContent = JSON.stringify(results);
      output.dataset.status = results.every(result => result.status === "VALID") ? "valid" : "invalid";
    } catch (error) { output.textContent = error.message; output.dataset.status = "error"; }
  };
` } });

async function respond(request) {
  const url = new URL(request.url);
  if (url.origin === providerOrigins[provider]) {
    if (provider === "microsoft" && url.pathname === "/common/oauth2/v2.0/token" && request.method === "POST") {
      // Simulate the real SPA CORS token endpoint. Unlike a confidential
      // Worker request, this browser code exchange carries no client secret.
      const result = await exchange(url.href, { body: new URLSearchParams(await request.text()) });
      const headers = new Headers(result.headers);
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
      return new Response(await result.arrayBuffer(), { status: result.status, headers });
    }
    const code = crypto.randomUUID();
    codes.set(code, { nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge") });
    const callback = origin + "/api/auth/" + provider + "/callback?state=" + url.searchParams.get("state") + "&code=" + code;
    // An actual cross-origin document severs window.opener, as an identity
    // provider can. Cookie-based status polling must still complete.
    return new Response(`<!doctype html><button>Continue</button><script>document.querySelector('button').onclick=()=>location.href=${JSON.stringify(callback)}</script>`, {
      headers: { "Content-Type": "text/html", "Cross-Origin-Opener-Policy": "same-origin" },
    });
  }
  if (url.pathname === "/") return new Response('<!doctype html><button>Seal synthetic document</button><output></output><script type="module" src="/client.js"></script>', { headers: { "Content-Type": "text/html" } });
  if (url.pathname === "/client.js") return new Response(client, { headers: { "Content-Type": "text/javascript" } });
  return createAccountAuth({ fetchImpl: exchange, trusted, verifyTokens: {
    google: (token, clientId, now) => verifyGoogleIdToken(token, clientId, now, keys),
    microsoft: (token, clientId, now) => verifyMicrosoftIdToken(token, clientId, now, keys),
    meta: (token, clientId, now) => verifyMetaIdToken(token, clientId, now, keys),
  } })(request, env);
}
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
    const request = new Request(headers.get("x-qred-test-url"), {
      method: incoming.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await respond(request);
    outgoing.statusCode = response.status;
    for (const [name, value] of response.headers) if (name !== "set-cookie") outgoing.setHeader(name, value);
    if (response.headers.has("set-cookie")) outgoing.setHeader("Set-Cookie", response.headers.getSetCookie());
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.statusCode = 500;
    outgoing.end(String(error));
  }
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n"));
