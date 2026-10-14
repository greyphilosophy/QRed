import { createPrivateKey, createPublicKey } from "node:crypto";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSigningKey, deriveSigningPublicKey, generateSigningKeyPair, validateSigningKeyPair } from "./signingKeys.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

afterEach(() => vi.unstubAllGlobals());

describe("Ed25519 signing keys", () => {
  it("generates fresh keys whose public bytes match an independent Node crypto derivation", async () => {
    const first = await generateSigningKeyPair();
    const second = await generateSigningKeyPair();
    expect(first.privateKey).not.toBe(second.privateKey);
    expect(first.publicKey).not.toBe(second.publicKey);
    const privateBytes = decodeSigningKey(first.privateKey, "private");
    const publicBytes = decodeSigningKey(first.publicKey, "public");
    const key = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateBytes]),
      type: "pkcs8", format: "der",
    });
    const derived = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
    expect(Buffer.from(publicBytes).equals(derived)).toBe(true);
    await expect(validateSigningKeyPair(first)).resolves.toMatchObject({ privateBytes, publicBytes });
  });

  it("accepts existing padded/unpadded Base64 and Base64URL keys with surrounding whitespace", async () => {
    for (const padded of [false, true]) {
      for (const standard of [false, true]) {
        const convert = (key) => {
          let value = padded ? key : key.replace(/=$/, "");
          if (standard) value = value.replace(/-/g, "+").replace(/_/g, "/");
          return ` \n${value}\n `;
        };
        await expect(validateSigningKeyPair({ privateKey: convert(privateKey), publicKey: convert(publicKey) })).resolves.toBeTruthy();
        expect(await deriveSigningPublicKey(convert(privateKey))).toBe(publicKey.replace(/=$/, ""));
      }
    }
  });

  it.each(["", "password", "0".repeat(64), "A".repeat(86), "-----BEGIN PRIVATE KEY-----", "ssh-ed25519 AAAA", "!".repeat(43), "A".repeat(42) + "B", null])("rejects unsupported input with format guidance (%#)", (input) => {
    for (const kind of ["private", "public"]) {
      expect(() => decodeSigningKey(input, kind)).toThrow(/Base64URL- or Base64-encoded 32-byte Ed25519/);
    }
  });

  it("fails explicitly when a secure random generator or Web Crypto is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);
    await expect(generateSigningKeyPair()).rejects.toThrow(/HTTPS.*Web Crypto/);
  });
});
