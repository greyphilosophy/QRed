import { createHash } from "node:crypto";
import QRCode from "qrcode";
import { expect, it } from "vitest";
import { createQRedSeals } from "../qredSealer.js";
import { createQRedQrData } from "../qredQr.js";
import { createVerificationSession } from "../verifier/verificationSession.js";
import { decodePhoto } from "./decodePhoto.js";
import { shadowedPrint } from "./testSupport/shadowedPrint.js";

const keys = {
  publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q",
  privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes",
};

it("carries a real curved-page recovery through photo dispatch and session authentication", async () => {
  const content = "Synthetic bowed print. ".repeat(40).trimEnd();
  const { seals } = await createQRedSeals({ ...keys, content, encodingStrategy: "plaintext",
    timestamp: "2026-11-04T12:00:00Z" });
  const symbol = QRCode.create([{ data: createQRedQrData(seals[0]).payloadBytes, mode: "byte" }],
    { version: 31, errorCorrectionLevel: "L" });
  const image = shadowedPrint(symbol, 8, { bow: .03 });
  const hash = () => createHash("sha256").update(image.data).digest("hex");
  const before = hash(), stages = [];
  // No geometry, sampler, decoder, payload or verifier is replaced. Merely
  // testing the curved helper would miss a disconnected top-level retry.
  const action = decodePhoto(image, { returnPayload: true,
    onStage: ({ stage }) => stages.push(stage) });
  expect(stages).toEqual(["rectified-fast", "curved-page"]);
  expect(action).toEqual({ status: "found", text: seals[0] });
  expect(hash()).toBe(before);
  const session = createVerificationSession();
  expect(session.add(action.text)).toBe(true);
  await session.verify(keys.publicKey);
  expect(session.getSnapshot().results).toMatchObject([{ status: "VALID", signature_valid: true, content }]);
  await session.verify("Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI");
  expect(session.getSnapshot().results).toMatchObject([{ status: "INVALID" }]);
  session.clear();
  expect(session.getSnapshot()).toMatchObject({ seals: [], results: [], progress: null });
}, 30_000);
