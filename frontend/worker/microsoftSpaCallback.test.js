import { beforeAll, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { microsoftSpaCallbackPage } from "./microsoftSpaCallback.js";

const id = "Z".repeat(43);
const settings = { id, code: "one-use-code", verifier: "v".repeat(43), clientId: "public-client" };
beforeAll(() => vi.stubGlobal("crypto", webcrypto));

async function scriptFrom(options) {
  const page = microsoftSpaCallbackPage(options);
  const html = await page.text();
  const match = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  expect(match).toBeTruthy();
  return { page, html, script: match[1] };
}

it("exchanges Microsoft's code in the browser without secrets or stored tokens", async () => {
  const { page, html, script } = await scriptFrom(settings);
  const csp = page.headers.get("Content-Security-Policy");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'self' https://login.microsoftonline.com");
  expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(html).not.toContain("client_secret");
  expect(html).not.toContain("localStorage");
  expect(html).not.toContain("sessionStorage");

  const requests = [], status = { textContent: "" };
  const close = vi.fn(), clearUrl = vi.fn();
  await runInNewContext(script, {
    document: { getElementById: () => status },
    history: { replaceState: clearUrl },
    location: { origin: "https://qred.test" },
    window: { opener: null, close },
    URLSearchParams, Error,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.startsWith("https://login.microsoftonline.com/")) return Response.json({
        id_token: "signed-microsoft-id-token", access_token: "not-forwarded", refresh_token: "not-forwarded",
      });
      return Response.json({ status: "ready" });
    },
  });
  expect(clearUrl).toHaveBeenCalledWith(null, "", "/api/auth/microsoft/callback");
  const exchange = requests[0];
  expect(exchange.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
  expect(exchange.options.credentials).toBe("omit");
  expect(Object.fromEntries(exchange.options.body)).toEqual({
    client_id: "public-client", code: "one-use-code", code_verifier: "v".repeat(43),
    grant_type: "authorization_code", redirect_uri: "https://qred.test/api/auth/microsoft/callback",
    scope: "openid email profile",
  });
  expect(requests[1].url).toBe("/api/auth/microsoft/complete");
  expect(JSON.parse(requests[1].options.body)).toEqual({ id, id_token: "signed-microsoft-id-token" });
  expect(close).toHaveBeenCalledOnce();
  expect(status.textContent).toContain("completed");
});

it("escapes provider-controlled code in callback HTML, preventing script injection", async () => {
  const malicious = "</script><img src=x onerror=alert(1)>";
  const { html, script } = await scriptFrom({ ...settings, code: malicious });
  expect(html).not.toContain(malicious);
  expect(html.match(/<script nonce=/g)).toHaveLength(1);
  expect(script).toContain("\\u003c");
});

it("marks the pending session failed if the browser cannot redeem the code", async () => {
  const { script } = await scriptFrom(settings);
  const requests = [], status = { textContent: "" }, close = vi.fn();
  await runInNewContext(script, {
    document: { getElementById: () => status },
    history: { replaceState: vi.fn() },
    location: { origin: "https://qred.test" },
    window: { opener: null, close }, URLSearchParams, Error,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.startsWith("https://login.microsoftonline.com/")) return new Response("invalid_grant", { status: 400 });
      return Response.json({ error: "failed" }, { status: 403 });
    },
  });
  expect(JSON.parse(requests[1].options.body)).toEqual({ id, error: "failed" });
  expect(close).not.toHaveBeenCalled();
  expect(status.textContent).toContain("Single-page application");
});
