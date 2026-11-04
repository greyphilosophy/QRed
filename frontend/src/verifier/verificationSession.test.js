import { expect, it, vi } from "vitest";
import { createVerificationSession } from "./verificationSession.js";
import { createQRedSeals } from "../qredSealer.js";

const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" };
const seal = async content => (await createQRedSeals({ ...keys, content })).seals[0];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

it("does not restore results when verification finishes after clearing the collection", async () => {
  const session = createVerificationSession();
  session.add(await seal("Previous collection"));
  const pending = deferred();
  const verifying = session.verify("", () => pending.promise);
  session.clear();
  pending.resolve({ status: "VALID", content: "Previous collection" });
  await verifying;
  expect(session.getSnapshot()).toMatchObject({ seals: [], results: [], busy: false, session: 1, progress: null });
});

it("keeps the newest key check when an older successful check resolves later", async () => {
  const session = createVerificationSession();
  session.add(await seal("Key change"));
  const pending = deferred();
  const oldCheck = session.verify("old key", () => pending.promise);
  await session.verify("new key", async () => ({ status: "INVALID" }));
  pending.resolve({ status: "VALID" });
  await oldCheck;
  expect(session.getSnapshot().results[0].status).toBe("INVALID");
  expect(session.getSnapshot().busy).toBe(false);
});

it("deduplicates scans without cancelling a pending check, but new scans invalidate it", async () => {
  const session = createVerificationSession();
  const first = await seal("First"), second = await seal("Second");
  session.add(first);
  const verify = vi.fn(async () => ({ status: "VALID" }));
  const checking = session.verify("", verify);
  expect(session.add(first)).toBe(false);
  await checking;
  expect(session.getSnapshot().results).toHaveLength(1);
  const pending = deferred();
  const oldCheck = session.verify("", () => pending.promise);
  session.add(second);
  pending.resolve({ status: "VALID" });
  await oldCheck;
  expect(session.getSnapshot().results).toEqual([]);
  await session.verify(keys.publicKey);
  expect(session.getSnapshot().results.map(result => result.content)).toEqual(["First", "Second"]);
});

it("keeps other pages usable when one verifier fails", async () => {
  const session = createVerificationSession();
  const first = await seal("First"), second = await seal("Second");
  session.add([first, second]);
  await session.verify("", async seals => {
    if (seals[0] === first) throw new Error("Cannot read this record");
    return { status: "UNVERIFIED" };
  });
  expect(session.getSnapshot().results.map(result => result.status)).toEqual(["ERROR", "UNVERIFIED"]);
  expect(session.getSnapshot().results[0].error_message).toBe("Cannot read this record");
});

it("bounds raw input before parsing and invalidates a pending verification on rejection", async () => {
  const session = createVerificationSession();
  expect(session.add(Array(4097).fill("ignored"))).toBe(false);
  expect(session.getSnapshot()).toMatchObject({ seals: [], busy: false, results: [{ status: "ERROR" }] });
  expect(session.add("x".repeat(8193))).toBe(false);
});

it("deduplicates the same transport bytes across different bootstrap URLs", async () => {
  const value = await seal("Same bytes"), session = createVerificationSession();
  expect(session.add(value)).toBe(true);
  expect(session.add("https://example.org/" + value.slice(value.indexOf("#")))).toBe(false);
  expect(session.getSnapshot().seals).toHaveLength(1);
});
it("cannot restore successful results after an oversized-input rejection", async () => {
  const session = createVerificationSession(); session.add(await seal("Pending"));
  const pending = deferred(), running = session.verify(keys.publicKey, () => pending.promise);
  session.add(Array(4097).fill("ignored")); pending.resolve({ status: "VALID", content: "Pending" });
  await running;
  expect(session.getSnapshot()).toMatchObject({ busy: false, results: [{ status: "ERROR" }] });
});
