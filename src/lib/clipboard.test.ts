import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  readMultiFormat,
  writeMultiFormat,
  writeText,
  writeImagePng,
} from "./clipboard";

describe("clipboard.writeText", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
      configurable: true,
    });
  });

  it("calls navigator.clipboard.writeText", async () => {
    await writeText("hello");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
  });

  it("is a no-op for empty input", async () => {
    await writeText("");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe("clipboard.writeMultiFormat", () => {
  it("uses ClipboardItem when html provided", async () => {
    const writeMock = vi.fn().mockResolvedValue(undefined);
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { write: writeMock, writeText: writeTextMock } },
      configurable: true,
    });
    // jsdom provides ClipboardItem when navigator.clipboard exists, but be safe.
    if (typeof ClipboardItem === "undefined") {
      (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = class {
        constructor(public items: Record<string, Blob>) {}
      };
    }

    await writeMultiFormat({ text: "plain", html: "<b>x</b>" });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).not.toHaveBeenCalled();
  });

  it("falls back to writeText when only text provided", async () => {
    const writeMock = vi.fn().mockResolvedValue(undefined);
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { write: writeMock, writeText: writeTextMock } },
      configurable: true,
    });
    await writeMultiFormat({ text: "plain" });
    expect(writeTextMock).toHaveBeenCalledWith("plain");
  });
});

describe("clipboard.readMultiFormat", () => {
  it("returns plain text when read() unavailable", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { readText: vi.fn().mockResolvedValue("hello") } },
      configurable: true,
    });
    const result = await readMultiFormat();
    expect(result.text).toBe("hello");
    expect(result.html).toBeUndefined();
  });

  it("collects html when present in clipboard items", async () => {
    const htmlBlob = new Blob(["<p>x</p>"], { type: "text/html" });
    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: {
          readText: vi.fn().mockResolvedValue("x"),
          read: vi.fn().mockResolvedValue([
            {
              types: ["text/plain", "text/html"],
              getType: vi.fn(async (t: string) =>
                t === "text/html" ? htmlBlob : new Blob(["x"]),
              ),
            },
          ]),
        },
      },
      configurable: true,
    });
    const result = await readMultiFormat();
    expect(result.text).toBe("x");
    expect(result.html).toBe("<p>x</p>");
  });
});

describe("clipboard.writeImagePng", () => {
  it("rejects when ClipboardItem unavailable", async () => {
    const original = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: {} },
      configurable: true,
    });
    await expect(writeImagePng(new Blob([]))).rejects.toThrow();
    if (original) (globalThis as { ClipboardItem?: unknown }).ClipboardItem = original;
  });
});
