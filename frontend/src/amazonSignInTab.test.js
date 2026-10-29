import { describe, expect, it, vi } from "vitest";
import { openAmazonSignInTab } from "./amazonSignInTab.js";

const authorizeUrl = "https://www.amazon.com/ap/oa?client_id=public-app&state=example";

describe("Amazon's direct prepared-URL tab handoff", () => {
  it("opens exactly the validated final URL synchronously and severs its opener", () => {
    const tab = { opener: { location: "private-pdf-window" }, close: vi.fn() };
    const open = vi.fn(() => tab);
    expect(openAmazonSignInTab(authorizeUrl, open)).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith(authorizeUrl);
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
  });

  it("refuses arbitrary URLs without opening a tab", () => {
    for (const url of [
      "https://attacker.example/ap/oa", "http://www.amazon.com/ap/oa",
      "https://www.amazon.com/ap/oa#secret", "https://amazon.com/ap/oa",
      "https://www.amazon.com/ap/oa?user=private@invalid.example#fragment",
    ]) {
      const open = vi.fn();
      expect(openAmazonSignInTab(url, open)).toBe(false);
      expect(open).not.toHaveBeenCalled();
    }
  });

  it("allows native link navigation if the browser blocks a scripted window", () => {
    expect(openAmazonSignInTab(authorizeUrl, () => null)).toBe(false);
    expect(openAmazonSignInTab(authorizeUrl, () => { throw new Error("blocked"); })).toBe(false);
  });

  it("does not leave Amazon with a reference to the original PDF tab", () => {
    const close = vi.fn();
    const tab = { close };
    Object.defineProperty(tab, "opener", { get: () => ({ privateData: true }), set: () => {} });
    expect(openAmazonSignInTab(authorizeUrl, () => tab)).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    const throwing = { close };
    Object.defineProperty(throwing, "opener", { set: () => { throw new Error("denied"); } });
    expect(openAmazonSignInTab(authorizeUrl, () => throwing)).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
