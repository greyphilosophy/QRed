import { expect, it } from "vitest";
import { encodeIdentity } from "./attestation.js";
import { qredPayloadCapacity } from "./qredQr.js";
import { encodeEnvelope, sealEnvelopeOverhead } from "./sealFormat.js";
import { recordCapacity, recordQrCount } from "./sealBudget.js";

it.each([false, true].flatMap(attested => [false, true].map(multiple => [attested, multiple])))( "matches encoded envelope overhead (Attested: %s, multipage: %s)", (attested, multiple) => {
    const identity = { provider: "google", email: "test@example.org", subject: "123", name: "Test signer", name_source: "google" };
    const metadata = { version: attested ? "4" : "3", timestamp: "2026-10-23T12:00:00Z", key_id: "0011223344556677",
      pdf: true, page_number: 1, page_count: multiple ? 2 : 1, document_root: multiple ? "a1".repeat(32) : null,
      identity };
    const body = new Uint8Array([1, 2, 3]);
    const envelope = encodeEnvelope(metadata, new Uint8Array(64), body, "plaintext");
    expect(envelope.length - body.length).toBe(sealEnvelopeOverhead({ attested, multiple, identityBytes: encodeIdentity(identity).length }));
    if (attested) {
      // QRS4 holds the identity directly followed by the signature: unlike
      // its pre-release predecessor, there are no 32 salt bytes per page.
      expect(envelope.length - body.length).toBe(4 + (multiple ? 53 : 17) + encodeIdentity(identity).length + 64);
    }
  });

it("agrees with the QR encoder at the single and multipart capacity boundaries", () => {
  expect(recordCapacity(1)).toBe(qredPayloadCapacity(40));
  for (const count of [1, 2, 3]) {
    expect(recordQrCount(recordCapacity(count))).toBe(count);
    expect(recordQrCount(recordCapacity(count) + 1)).toBe(count + 1);
  }
});
