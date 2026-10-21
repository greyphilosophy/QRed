import { generateKeyPairSync, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = process.argv[2];
if (!output || !output.endsWith(".private-key.txt")) {
  console.error("Usage: node scripts/createAttestationKey.mjs /secure/path/qred-authority.private-key.txt");
  process.exit(1);
}
const destination = resolve(output);
const authoritiesFile = fileURLToPath(new URL("../src/trustedAuthorities.json", import.meta.url));
const authorities = JSON.parse(readFileSync(authoritiesFile, "utf8"));
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateJwk = privateKey.export({ format: "jwk" });
const publicJwk = publicKey.export({ format: "jwk" });
const keyId = createHash("sha256").update(Buffer.from(publicJwk.x, "base64url")).digest("hex").slice(0, 16);
// Never print the private seed or replace an existing key file.
writeFileSync(destination, privateJwk.d + "\n", { flag: "wx", mode: 0o600 });
authorities[keyId] = publicJwk.x;
writeFileSync(authoritiesFile, JSON.stringify(authorities, null, 2) + "\n");
console.log("Created authority key " + keyId + ". Private seed saved to " + destination + ".");
console.log("The public key was added to src/trustedAuthorities.json. Keep previous trusted keys when rotating.");
