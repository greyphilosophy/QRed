/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAuthPendingTab } from "./authPendingTab.js";

class LocalChannel {
  static peers = new Map();
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this.closed = false;
    const existing = LocalChannel.peers.get(name) || new Set();
    existing.add(this);
    LocalChannel.peers.set(name, existing);
  }
  postMessage(data) {
    for (const peer of LocalChannel.peers.get(this.name) || []) {
      if (peer !== this && !peer.closed) queueMicrotask(() => {
        if (!peer.closed) peer.onmessage?.({ data });
      });
    }
  }
  close() {
    this.closed = true;
    LocalChannel.peers.get(this.name)?.delete(this);
  }
}
const google = "https://accounts.google.com/o/oauth2/v2/auth?state=opaque";

function fixture(openWindow = vi.fn(() => ({ closed: true, opener: { old: true }, close: vi.fn() }))) {
  const tab = openAuthPendingTab({
    openWindow,
    BroadcastChannelCtor: LocalChannel,
    randomBytes: () => new Uint8Array(16).fill(7),
  });
  return { tab, openWindow, name: "qred-auth-pending-" + "07".repeat(16) };
}
afterEach(() => { LocalChannel.peers.clear(); vi.restoreAllMocks(); });

describe("isolated QRed OAuth preparation tab", () => {
  it("delivers the approved provider URL even when an opened tab reports closed", async () => {
    const { tab, openWindow, name } = fixture();
    expect(tab).toBeTruthy();
    expect(openWindow).toHaveBeenCalledWith("/auth-pending.html#" + "07".repeat(16), "_blank");
    expect(tab.popup.closed).toBe(true); // Chrome may revoke WindowProxy after opener = null.
    expect(tab.popup.opener).toBeNull();
    const child = new LocalChannel(name);
    const received = [];
    child.onmessage = ({ data }) => received.push(data);
    child.postMessage({ type: "ready" });
    expect(await tab.authorize("google", google)).toBe(true);
    await Promise.resolve();
    expect(received).toEqual([{ type: "authorize", provider: "google", url: google }]);
    tab.dispose();
    child.close();
  });

  it("does not broadcast an unapproved authorization URL", async () => {
    const { tab, name } = fixture();
    const child = new LocalChannel(name);
    const received = vi.fn();
    child.onmessage = received;
    child.postMessage({ type: "ready" });
    await expect(tab.authorize("google", "https://attacker.example/sign-in")).rejects.toThrow("Unexpected sign-in address");
    expect(received).not.toHaveBeenCalled();
    tab.cancel();
    child.close();
  });

  it("uses the native-link fallback if the new page never acknowledges readiness", async () => {
    const { tab } = fixture();
    expect(await tab.authorize("google", google, { readyTimeoutMs: 0 })).toBe(false);
    tab.cancel();
    expect(tab.popup.close).toHaveBeenCalled();
  });

  it("does not fail merely because the browser forbids setting opener", () => {
    const close = vi.fn();
    const popup = { closed: true, close };
    Object.defineProperty(popup, "opener", { set() { throw new Error("isolated"); } });
    const { tab } = fixture(vi.fn(() => popup));
    expect(tab).toBeTruthy();
    tab.cancel();
    expect(close).toHaveBeenCalled();
  });

  it("returns null when an actual popup blocker prevents opening a tab", () => {
    const { tab } = fixture(vi.fn(() => null));
    expect(tab).toBeNull();
  });
});
