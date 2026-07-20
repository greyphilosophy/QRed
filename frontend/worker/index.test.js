import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";

const assetFetch = vi.fn(() => Promise.resolve(new Response("asset")));

function env(overrides = {}) {
  return {
    ASSETS: { fetch: assetFetch },
    ...overrides,
  };
}

describe("frontend worker public-key API", () => {
  it("serves only the public demo key without exposing a private key", async () => {
    const response = await worker.fetch(
      new Request("https://qred.org/api/keys/default"),
      env()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        public_key: expect.any(String),
        key_id: expect.any(String),
        source: "static-demo",
      })
    );
    expect(body.private_key).toBeUndefined();
  });

  it("derives a key ID for Worker-provided public keys when one is not configured", async () => {
    const response = await worker.fetch(
      new Request("https://qred.org/api/keys/default"),
      env({
        QRED_DEFAULT_PUBLIC_KEY: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      public_key: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
      key_id: "da522162396ab2d0",
      source: "worker-environment",
    });
  });

  it("returns /api/keys/demo identically to /api/keys/default", async () => {
    const resp1 = await worker.fetch(
      new Request("https://qred.org/api/keys/default"),
      env()
    );
    const resp2 = await worker.fetch(
      new Request("https://qred.org/api/keys/demo"),
      env()
    );

    const body1 = await resp1.json();
    const body2 = await resp2.json();

    expect(body1).toEqual(body2);
  });

  it("delegates all non-API routes to static assets", async () => {
    const response = await worker.fetch(
      new Request("https://qred.org/verifier"),
      env()
    );

    expect(assetFetch).toHaveBeenCalledTimes(1);
  });
});