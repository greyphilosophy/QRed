import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readProjectFile = relativePath => readFileSync(new URL(relativePath, import.meta.url), "utf8");
const pages = ["privacy", "data-deletion", "terms", "security"];
const nav = pages.map(slug => "/" + slug + ".html");

describe("public QRed policy and security pages", () => {
  it.each(pages)("%s is a complete, standalone, navigable HTML page", slug => {
    const html = readProjectFile("../public/" + slug + ".html");
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toMatch(/<title>[^<]+\| QRed<\/title>/);
    expect(html).toContain('<main id="main"');
    expect(html).toContain('href="/legal.css"');
    expect(html).toContain('href="mailto:greyphilosophy@gmail.com"');
    expect(html).toContain("Last updated: October 26, 2026");
    for (const link of nav) expect(html).toContain('href="' + link + '"');
    expect(html).toContain('aria-current="page"');
    // Sensitive readers should never load third-party JavaScript or tracking
    // merely by opening legal/security documentation.
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).not.toContain("TODO");
  });

  it("describes locally held documents and potentially public seal evidence", () => {
    const html = readProjectFile("../public/privacy.html");
    expect(html).toContain("on the user's device");
    expect(html).toContain("randomly salted page commitments");
    expect(html).toContain("anybody who receives a copy");
    expect(html).toContain("hosting infrastructure");
  });

  it("makes account data deletion instructions public and actionable", () => {
    const html = readProjectFile("../public/data-deletion.html");
    expect(html).toContain("QRed data deletion request");
    expect(html).toContain("identity provider");
    expect(html).toContain("cannot remotely erase or revoke every copy");
  });

  it("avoids implying CJIS authorization or a legal guarantee", () => {
    const html = readProjectFile("../public/terms.html");
    expect(html).toContain("not</strong> claim");
    expect(html).toContain("CJIS");
    expect(html).toContain("as is");
  });

  it("provides an accessible self-hosted diagram with equivalent textual flow details", () => {
    const html = readProjectFile("../public/security.html");
    const svg = readProjectFile("../public/qred-network-data-flow.svg");
    expect(html).toContain('src="/qred-network-data-flow.svg"');
    expect(html).toContain("Trust boundaries");
    expect(html).toContain("Microsoft");
    expect(svg).toContain("<title");
    expect(svg).toContain("<desc");
    expect(svg).toContain("Keeps PDFs, text, and salts local");
    expect(svg).not.toMatch(/<script\b/i);
    expect(svg).not.toMatch(/<foreignObject\b/i);
  });

  it("links the four pages from both the React homepage and the standalone verifier", () => {
    const files = ["./App.jsx", "../verifier.html"];
    for (const name of files) {
      const html = readProjectFile(name);
      for (const link of nav) expect(html).toContain('href="' + link + '"');
    }
  });
});
