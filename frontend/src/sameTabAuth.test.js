/* @vitest-environment jsdom */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { clearPendingAuth, navigateToProvider, PENDING_KEY, readPendingAuth, savePendingAuth } from "./sameTabAuth.js";

const token = "a".repeat(43);
const session = () => ({
  provider: "amazon", id: token, secret: "b".repeat(43),
  startedAt: 10_000,
  authorize_url: "https://www.amazon.com/ap/oa?state=" + token,
  salts: [new Uint8Array(32).fill(3)],
  commitments: ["c".repeat(43)],
});
let storage;
beforeEach(() => {
  storage = new Map();
});
afterEach(() => vi.restoreAllMocks());
const store = () => ({
  setItem: (key, value) => storage.set(key, value),
  getItem: key => storage.get(key) || null,
  removeItem: key => storage.delete(key),
});

it("persists only authentication metadata, never PDF contents, text, or keys", () => {
  const s = session();
  const fake = store();
  savePendingAuth(s, "automatic", fake);
  const raw = storage.get(PENDING_KEY);
  for (const prohibited of ["%PDF", "invoice contents", "privateKey", "pageEvidence", "file", "blob", "extractedText"]) {
    expect(raw).not.toContain(prohibited);
  }
  const restored = readPendingAuth(fake, s.startedAt + 1000);
  expect(restored).toMatchObject({
    provider: "amazon", id: token, commitments: s.commitments,
    pageScalingStrategy: "automatic",
  });
  expect(restored.salts[0]).toEqual(s.salts[0]);
  clearPendingAuth(fake);
  expect(storage.size).toBe(0);
});

it("uses same-tab navigation without opening a window", () => {
  const navigate = vi.fn();
  const fake = store();
  const s = session();
  navigateToProvider(s, "automatic", { storage: fake, navigate });
  expect(navigate).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledWith(s.authorize_url);
  expect(storage.has(PENDING_KEY)).toBe(true);
});

it("rejects unexpected redirects and clears expired or malformed sessions", () => {
  const fake = store();
  const s = session();
  expect(() => navigateToProvider({ ...s, authorize_url: "https://evil.example/login" },
    "automatic", { storage: fake, navigate: vi.fn() })).toThrow("Unexpected provider");
  expect(storage.size).toBe(0);
  savePendingAuth(s, "automatic", fake);
  expect(readPendingAuth(fake, s.startedAt + 301_000)).toBeNull();
  expect(storage.size).toBe(0);
  fake.setItem(PENDING_KEY, '{"file":"private-document.pdf"}');
  expect(readPendingAuth(fake, s.startedAt + 2000)).toBeNull();
  expect(storage.size).toBe(0);
});
