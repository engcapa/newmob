import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractProviderDocLinks,
  openExternalDocumentation,
  referenceHrefFromEventTarget,
  validateExternalDocUrl,
} from "./referenceDocumentation";

const originalOpen = window.open;

afterEach(() => {
  window.open = originalOpen;
  vi.restoreAllMocks();
});

describe("referenceDocumentation", () => {
  it("allows canonical absolute HTTP(S) URLs", () => {
    expect(validateExternalDocUrl(" https://docs.example.dev/api ")).toEqual({
      kind: "allowed",
      url: "https://docs.example.dev/api",
    });
    // §8.18.6: plain http requires the explicit workspace policy opt-in.
    expect(validateExternalDocUrl("http://example.dev", { allowHttp: true })).toEqual({
      kind: "allowed",
      url: "http://example.dev/",
    });
    expect(validateExternalDocUrl("http://example.dev").kind).toBe("unavailable");
  });

  it.each([
    ["javascript:alert(1)", "invalid-scheme"],
    ["file:///etc/passwd", "invalid-scheme"],
    ["data:text/html,hello", "invalid-scheme"],
    ["relative/path", "malformed"],
    ["", "no-url"],
  ])("rejects untrusted URL %s", (url, reason) => {
    expect(validateExternalDocUrl(url)).toEqual({ kind: "unavailable", reason });
  });

  it("does not call the opener for rejected URLs and distinguishes open failure", async () => {
    const opener = vi.fn(async () => {});
    await expect(openExternalDocumentation("javascript:alert(1)", opener)).resolves.toEqual({
      kind: "unavailable",
      reason: "invalid-scheme",
    });
    expect(opener).not.toHaveBeenCalled();

    await expect(openExternalDocumentation("https://docs.example.dev", async () => {
      throw new Error("blocked");
    })).resolves.toEqual({ kind: "unavailable", reason: "open-failed" });
  });

  it("extracts only a nearest anchor href from an event target", () => {
    const anchor = document.createElement("a");
    anchor.href = "https://docs.example.dev/reference";
    const child = document.createElement("span");
    anchor.appendChild(child);
    expect(referenceHrefFromEventTarget(child)).toBe("https://docs.example.dev/reference");
    expect(referenceHrefFromEventTarget(document.createElement("button"))).toBeNull();
  });

  it("§8.20.2: extracts candidate links from provider documentation bodies", () => {
    // Markdown links, html anchors and bare https URLs are all provider facts.
    expect(extractProviderDocLinks(
      "See [java.util.Map](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Map.html) docs.\n"
      + "<a href='https://example.dev/guide'>Guide</a>\n"
      + "Spec: https://spec.example.dev/rfc/1.",
    )).toEqual([
      "https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Map.html",
      "https://example.dev/guide",
      "https://spec.example.dev/rfc/1",
    ]);
    // Duplicates collapse; order preserved.
    expect(extractProviderDocLinks(
      "[a](https://x.dev/a) [b](https://x.dev/a)",
    )).toEqual(["https://x.dev/a"]);
  });

  it("§8.20.2: never synthesizes or accepts non-provider URL shapes", () => {
    // No body / no URLs → empty. A symbol name alone must never produce one.
    expect(extractProviderDocLinks(null)).toEqual([]);
    expect(extractProviderDocLinks("")).toEqual([]);
    expect(extractProviderDocLinks("StringUtils.isBlank(CharSequence)")).toEqual([]);
    // Non-http(s) schemes are dropped — the controller re-validates anyway.
    expect(extractProviderDocLinks("[x](javascript:alert(1)) file:///etc/passwd")).toEqual([]);
    // Trailing punctuation is trimmed so markdown sentences do not corrupt.
    expect(extractProviderDocLinks("See https://x.dev/doc.")).toEqual(["https://x.dev/doc"]);
  });
});
