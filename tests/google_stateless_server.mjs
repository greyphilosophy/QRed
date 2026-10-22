// Local-only browser test bridge. All identities, codes and keys are synthetic.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";

const frontend = fileURLToPath(new URL("../frontend/", import.meta.url));
const require = createRequire(resolve(frontend, "package.json"));
const { build } = require("esbuild");
const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import(pathToFileURL(require.resolve("jose")));
const compile = async options => (await build({ bundle: true, format: "esm", write: false, ...options })).outputFiles[0].text;
const backend = await compile({ entryPoints: [resolve(frontend, "worker/googleAuth.js")], platform: "node" });
const { createGoogleAuth, verifyGoogleIdToken } = await import("data:text/javascript;base64," + Buffer.from(backend).toString("base64"));
const origin = "https://qred.test";
const seed = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const keyId = "da522162396ab2d0";
const trusted = { [keyId]: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q" };
const env = { QRED_ORIGIN: origin, QRED_GOOGLE_CLIENT_ID: "browser-test-client", QRED_GOOGLE_CLIENT_SECRET: "synthetic-secret",
  QRED_ATTESTATION_PRIVATE_KEY: seed, QRED_ATTESTATION_KEY_ID: keyId };
const rsa = await generateKeyPair("RS256", { extractable: true });
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(rsa.publicKey), kid: "synthetic-google-key", alg: "RS256" }] });
const codes = new Map(); // This is the fake Google service's state, not QRed's.
async function exchange(_url, options) {
  const code = options.body.get("code"), grant = codes.get(code);
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(options.body.get("code_verifier")))).toString("base64url");
  if (!grant || grant.challenge !== challenge) return new Response("invalid_grant", { status: 400 });
  codes.delete(code);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sub: "browser-test-user", email: "browser.test@gmail.com", email_verified: true,
    name: "Browser Test", nonce: grant.nonce }).setProtectedHeader({ alg: "RS256", kid: "synthetic-google-key" })
    .setIssuer("https://accounts.google.com").setAudience(env.QRED_GOOGLE_CLIENT_ID).setIssuedAt(now).setExpirationTime(now + 3600).sign(rsa.privateKey);
  return Response.json({ id_token: token });
}
// The optional Node PNG renderer is not used by browser sealing/verification.
const client = await compile({ platform: "browser", external: ["qrcode/lib/renderer/png"], stdin: { resolveDir: frontend, loader: "js", contents: `
  import { attestPagesWithGoogle } from "./src/googleSealing.js";
  import { createQRedSeals } from "./src/qredSealer.js";
  import { verifyQRedSeals } from "./src/qredVerifier.js";
  const trusted = ${JSON.stringify(trusted)};
  const pages = ["Synthetic private page one", "Synthetic private page two"].map((content, i) => ({
    content, metadata: { pdf: true, page_number: i + 1, page_count: 2, document_root: "d4".repeat(32) }
  }));
  let seals;
  window.verifyOffline = () => Promise.all(seals.map(seal => verifyQRedSeals(seal.seals, "", trusted)));
  document.querySelector("button").onclick = async () => {
    const output = document.querySelector("output");
    try {
      const receipts = await attestPagesWithGoogle(pages, { popup: window.open("about:blank", "qred-google"), trusted });
      seals = await Promise.all(pages.map((page, index) => createQRedSeals({ content: page.content, attestation: receipts[index],
        pageContext: { pageNumber: index + 1, pageCount: 2, documentRoot: page.metadata.document_root } })));
      const results = await window.verifyOffline();
      output.textContent = JSON.stringify(results);
      output.dataset.status = results.every(result => result.status === "VALID") ? "valid" : "invalid";
    } catch (error) { output.textContent = error.message; output.dataset.status = "error"; }
  };
` } });

async function respond(request) {
  const url = new URL(request.url);
  if (url.origin === "https://accounts.google.com") {
    const code = crypto.randomUUID();
    codes.set(code, { nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge") });
    const callback = origin + "/api/auth/google/callback?state=" + url.searchParams.get("state") + "&code=" + code;
    // An actual cross-origin document severs window.opener, as an identity
    // provider can. Cookie-based status polling must still complete.
    return new Response(`<!doctype html><button>Continue</button><script>document.querySelector('button').onclick=()=>location.href=${JSON.stringify(callback)}</script>`, {
      headers: { "Content-Type": "text/html", "Cross-Origin-Opener-Policy": "same-origin" },
    });
  }
  if (url.pathname === "/") return new Response('<!doctype html><button>Seal synthetic document</button><output></output><script type="module" src="/client.js"></script>', { headers: { "Content-Type": "text/html" } });
  if (url.pathname === "/client.js") return new Response(client, { headers: { "Content-Type": "text/javascript" } });
  return createGoogleAuth({ fetchImpl: exchange, trusted,
    verifyToken: (token, clientId, now) => verifyGoogleIdToken(token, clientId, now, keys) })(request, env);
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
