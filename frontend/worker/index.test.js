import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";

const assetFetch = vi.fn(() => Promise.resolve(new Response("asset")));

function env(overrides = {}) {
  return {
    ASSETS: { fetch: assetFetch },
    ...overrides,
  };
}

describe("frontend worker API handling", () => {
  it("serves default demo keys without requiring a backend origin", async () => {
    const response = await worker.fetch(new Request("https://qred.org/api/keys/default"), env());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      private_key: expect.any(String),
      public_key: expect.any(String),
      key_id: expect.any(String),
      source: "worker-static-demo",
    }));
  });

  it("derives a key ID for Worker-provided default keys when one is not configured", async () => {
    const response = await worker.fetch(new Request("https://qred.org/api/keys/default"), env({
      QRED_DEFAULT_PRIVATE_KEY: "private-key",
      QRED_DEFAULT_PUBLIC_KEY: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      private_key: "private-key",
      public_key: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
      key_id: "da522162396ab2d0",
      source: "worker-environment",
    });
  });

  it("still returns a clear 503 for backend API routes when no backend origin is configured", async () => {
    const response = await worker.fetch(new Request("https://qred.org/api/pdf/upload-seal", { method: "POST" }), env());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toContain("QRED_API_ORIGIN");
  });

  it("proxies API-backed demo routes to the configured backend origin", async () => {
    const proxiedFetch = vi.fn(async (request) => new Response(JSON.stringify({
      url: request.url,
      method: request.method,
      forwardedHost: request.headers.get("X-Forwarded-Host"),
      forwardedProto: request.headers.get("X-Forwarded-Proto"),
    }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", proxiedFetch);

    const response = await worker.fetch(
      new Request("https://qred.org/api/pdf/upload-seal?demo=1", { method: "POST", body: "pdf" }),
      env({ QRED_API_ORIGIN: "https://api.qred.example/base-path" }),
    );
    const body = await response.json();

    expect(proxiedFetch).toHaveBeenCalledOnce();
    expect(body).toEqual({
      url: "https://api.qred.example/api/pdf/upload-seal?demo=1",
      method: "POST",
      forwardedHost: "qred.org",
      forwardedProto: "https",
    });
  });
});
