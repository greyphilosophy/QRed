import { createPrivateKey, createPublicKey } from "node:crypto";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSigningKey, deriveSigningPublicKey, generateSigningKeyPair, readSigningKeyFile, validateSigningKeyPair } from "./signingKeys.js";

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

describe("saved key files", () => {
  it.each(["private", "public"])("opens saved %s keys and normalizes supported text encodings", async (kind) => {
    const key = kind === "private" ? privateKey : publicKey;
    for (const text of [key, key.replace(/=$/, ""), key.replace(/-/g, "+").replace(/_/g, "/")]) {
      const file = new File([`\uFEFF \r\n${text}\r\n`], `qred-ed25519-${kind}-key.txt`);
      await expect(readSigningKeyFile(file, kind)).resolves.toBe(key.replace(/=$/, ""));
    }
  });

  it.each(["private", "public"])("rejects the opposite QRed export in the %s picker", async (kind) => {
    const opposite = kind === "private" ? "public" : "private";
    for (const suffix of ["", " (1)"]) {
      const file = new File([privateKey], `qred-ed25519-${opposite}-key${suffix}.txt`);
      await expect(readSigningKeyFile(file, kind)).rejects.toThrow(`Choose a ${kind} key file instead`);
    }
  });

  it("rejects oversized selections without reading them", async () => {
    const file = new File(["x".repeat(4097)], "document.txt");
    const read = vi.spyOn(file, "text");
    await expect(readSigningKeyFile(file, "private")).rejects.toThrow(/4 KB or less/);
    expect(read).not.toHaveBeenCalled();
  });

  it("reports unreadable and malformed files without echoing their contents", async () => {
    await expect(readSigningKeyFile({ size: 44, text: () => Promise.reject(new Error("reader failed")) }, "private")).rejects.toThrow(/Could not read the key file/);
    const file = new File(["not a key; confidential text"], "key.txt");
    await expect(readSigningKeyFile(file, "public")).rejects.toThrow(/Base64URL- or Base64-encoded/);
    await expect(readSigningKeyFile(file, "public")).rejects.not.toThrow(/confidential/);
  });
});
