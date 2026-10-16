import { expect, it } from "vitest";
import { DEMO_SIGNING_KEYS } from "./demoKeys.js";
import { decodeSigningKey, validateSigningKeyPair } from "./signingKeys.js";
import { createQRedSeals } from "./qredSealer.js";
import { verifyQRedSeals } from "./qredVerifier.js";
import worker from "../worker/index.js";

it("signs with the demo preset and verifies with the Worker's built-in default public key", async () => {
  const response = await worker.fetch(new Request("https://qred.org/api/keys/default"), {});
  const defaults = await response.json();
  expect(defaults.source).toBe("static-demo");
  expect(defaults.private_key).toBeUndefined();
  expect(decodeSigningKey(DEMO_SIGNING_KEYS.publicKey, "public")).toEqual(decodeSigningKey(defaults.public_key, "public"));
  await expect(validateSigningKeyPair(DEMO_SIGNING_KEYS)).resolves.toBeTruthy();
  const { seals } = await createQRedSeals({ content: "Shared demo document", issuer: "QRed Demo Authority", ...DEMO_SIGNING_KEYS });
  await expect(verifyQRedSeals(seals, defaults.public_key)).resolves.toMatchObject({
    status: "VALID", key_id: defaults.key_id, content: "Shared demo document",
  });
});
