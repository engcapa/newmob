import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
    expect(validateExternalDocUrl("http://example.dev")).toEqual({
      kind: "allowed",
      url: "http://example.dev/",
    });
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
});
