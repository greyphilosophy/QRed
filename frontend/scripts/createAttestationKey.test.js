import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "qred-test-authority-"));
  temporary.push(dir);
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "src"));
  const script = join(dir, "scripts/createAttestationKey.mjs");
  copyFileSync(new URL("./createAttestationKey.mjs", import.meta.url), script);
  const trust = join(dir, "src/trustedAuthorities.json");
  const previous = { da522162396ab2d0: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q" };
  writeFileSync(trust, JSON.stringify(previous));
  const output = join(dir, "test.private-key.txt");
  return { dir, trust, previous, output, run: (...args) => spawnSync(process.execPath, [script, output, ...args], { encoding: "utf8", timeout: 10000 }) };
}

describe("local authority key generator", () => {
  it.each([[], ["--prefix", "Q"]])("saves a matching key pair without exposing the private seed (%j)", (...args) => {
    const f = fixture();
    const result = f.run(...args);
    expect(result.status, result.stderr).toBe(0);
    const seed = readFileSync(f.output, "utf8").trim();
    const publicKey = /Public key: ([A-Za-z0-9_-]{43})/.exec(result.stdout)?.[1];
    expect(publicKey).toBeTruthy();
    if (args.length) expect(publicKey.startsWith("Q")).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(seed);
    const privateObject = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", d: seed, x: publicKey } });
    expect(createPublicKey(privateObject).export({ format: "jwk" }).x).toBe(publicKey);
    const message = Buffer.from("Synthetic authority test; never use this test key for production");
    expect(verify(null, message, createPublicKey(privateObject), sign(null, message, privateObject))).toBe(true);
    const keyId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 16);
    expect(JSON.parse(readFileSync(f.trust, "utf8"))).toEqual({ ...f.previous, [keyId]: publicKey });
    if (process.platform !== "win32") expect(statSync(f.output).mode & 0o777).toBe(0o600);
  });

  it("refuses an existing key before starting a vanity search", () => {
    const f = fixture();
    writeFileSync(f.output, "keep-existing-key");
    const result = f.run("--prefix", "QRed");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to overwrite");
    expect(result.stdout).not.toContain("Searching");
    expect(readFileSync(f.output, "utf8")).toBe("keep-existing-key");
    expect(JSON.parse(readFileSync(f.trust, "utf8"))).toEqual(f.previous);
  });

  it.each([["--prefix"], ["--prefix", "QR+"], ["--prefix", "QRedx"], ["--prefix", "Q", "extra"], ["--unknown", "Q"]])(
    "rejects invalid options without changing files (%j)", (...args) => {
      const f = fixture();
      const result = f.run(...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage:");
      expect(existsSync(f.output)).toBe(false);
      expect(JSON.parse(readFileSync(f.trust, "utf8"))).toEqual(f.previous);
    });
});
