import { generateKeyPairSync, createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function main() {
  const [output, flag, prefix = "", ...extra] = process.argv.slice(2);
  if (!output || !output.endsWith(".private-key.txt") || extra.length ||
      (flag !== undefined && (flag !== "--prefix" || !/^[A-Za-z0-9_-]{1,4}$/.test(prefix)))) {
    throw new Error("Usage: node scripts/createAttestationKey.mjs /secure/path/qred-authority.private-key.txt [--prefix QRed]\n" +
      "The optional prefix is case-sensitive and must contain 1–4 Base64URL characters.");
  }
  const destination = resolve(output);
  // Fail before an expensive search; the exclusive write also checks at completion.
  if (existsSync(destination)) throw new Error("Refusing to overwrite existing private key: " + destination);
  accessSync(dirname(destination), constants.W_OK);
  const authoritiesFile = fileURLToPath(new URL("../src/trustedAuthorities.json", import.meta.url));
  const readAuthorities = () => {
    const authorities = JSON.parse(readFileSync(authoritiesFile, "utf8"));
    if (!authorities || typeof authorities !== "object" || Array.isArray(authorities)) throw new Error("Invalid trusted-authority file");
    return authorities;
  };
  readAuthorities();
  accessSync(authoritiesFile, constants.W_OK);
  if (prefix) {
    console.log(`Searching for a public key beginning with ${prefix} (case-sensitive).`);
    console.log(`Expected attempts on average: ${(64 ** prefix.length).toLocaleString("en-US")}. Search time varies; Ctrl+C cancels.`);
  }
  const start = Date.now();
  let lastReport = start, attempts = 0, match;
  do {
    // Generate a fresh random Ed25519 pair each time. Only filter the public
    // encoding; never edit key bytes or export rejected private seeds.
    const pair = generateKeyPairSync("ed25519");
    const publicJwk = pair.publicKey.export({ format: "jwk" });
    attempts++;
    if (publicJwk.x.startsWith(prefix)) match = { privateKey: pair.privateKey, publicJwk };
    if (!match && attempts % 25000 === 0 && Date.now() - lastReport >= 5000) {
      lastReport = Date.now();
      const rate = Math.round(attempts * 1000 / (lastReport - start));
      console.log(`${attempts.toLocaleString("en-US")} attempts; ${rate.toLocaleString("en-US")} keys/second.`);
    }
  } while (!match);
  const privateJwk = match.privateKey.export({ format: "jwk" });
  const publicKey = match.publicJwk.x;
  const keyId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 16);
  // Re-read after the search so keys added while it ran are preserved.
  const authorities = readAuthorities();
  if (authorities[keyId] && authorities[keyId] !== publicKey) throw new Error("Authority key ID collision; generate another key");
  // Never print the private seed or replace an existing key file.
  writeFileSync(destination, privateJwk.d + "\n", { flag: "wx", mode: 0o600 });
  console.log("Created authority key " + keyId + ". Private seed saved to " + destination + ".");
  console.log("Public key: " + publicKey);
  authorities[keyId] = publicKey;
  writeFileSync(authoritiesFile, JSON.stringify(authorities, null, 2) + "\n");
  console.log("The public key was added to src/trustedAuthorities.json. Keep previous trusted keys when rotating.");
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
