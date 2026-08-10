import { describe, expect, it } from "vitest";
import {
  codePointToKeysym,
  clientPointToFramebuffer,
  encodeWsAck,
  keyEventToKeysym,
  normalizeVncError,
  parseFrameBatch,
  pasteModifierKeysyms,
  shouldAutoReconnect,
  vncReconnectDelayMs,
} from "./vnc";
import { DEFAULT_VNC_OPTIONS, parseVncOptions, serializeVncOptions } from "../types/vnc";

function frameBatch(): ArrayBuffer {
  const bytes = new Uint8Array(22 + 12 + 8);
  const view = new DataView(bytes.buffer);
  bytes.set([0x54, 0x56, 0x4e, 0x43, 1, 1], 0);
  view.setBigUint64(8, 9n);
  view.setUint16(16, 2);
  view.setUint16(18, 1);
  view.setUint16(20, 1);
  view.setUint16(22, 0);
  view.setUint16(24, 0);
  view.setUint16(26, 2);
  view.setUint16(28, 1);
  view.setUint32(30, 8);
  bytes.set([1, 2, 3, 255, 4, 5, 6, 255], 34);
  return bytes.buffer;
}

describe("VNC relay protocol", () => {
  it("parses a complete atomic frame batch", () => {
    const parsed = parseFrameBatch(frameBatch());
    expect(parsed?.frameId).toBe(9);
    expect(parsed?.width).toBe(2);
    expect(parsed?.rects[0]?.rgba.length).toBe(8);
  });

  it("rejects truncated, trailing, and out-of-bounds batches", () => {
    const valid = new Uint8Array(frameBatch());
    expect(parseFrameBatch(valid.slice(0, valid.length - 1).buffer)).toBeNull();
    const trailing = new Uint8Array(valid.length + 1);
    trailing.set(valid);
    expect(parseFrameBatch(trailing.buffer)).toBeNull();
    const outOfBounds = new Uint8Array(valid);
    new DataView(outOfBounds.buffer).setUint16(26, 3);
    expect(parseFrameBatch(outOfBounds.buffer)).toBeNull();
  });

  it("encodes a frame id ACK and keeps legacy zero compatible", () => {
    const ack = new Uint8Array(encodeWsAck(42));
    expect(ack[0]).toBe(0);
    expect(new DataView(ack.buffer).getBigUint64(1)).toBe(42n);
    expect(new Uint8Array(encodeWsAck()).length).toBe(9);
  });
});

describe("VNC options and input", () => {
  it("rejects None and rich clipboard by default", () => {
    expect(DEFAULT_VNC_OPTIONS.allowNone).toBe(false);
    expect(DEFAULT_VNC_OPTIONS.clipboardTextOnly).toBe(true);
    const parsed = parseVncOptions(
      JSON.stringify({ allowNone: true, clipboardTextOnly: true, allowHtmlClipboard: true }),
    );
    expect(parsed.allowNone).toBe(true);
    expect(parsed.allowHtmlClipboard).toBe(false);
  });

  it("round trips bounded reconnect and clipboard settings", () => {
    const parsed = parseVncOptions(
      JSON.stringify({ reconnectMaxAttempts: 255, clipboardMaxBytes: 999999999 }),
    );
    expect(parsed.reconnectMaxAttempts).toBe(10);
    expect(parsed.clipboardMaxBytes).toBe(16 * 1024 * 1024);
    expect(parseVncOptions(serializeVncOptions(parsed))).toEqual(parsed);
  });

  it("maps macOS modifiers and Unicode keysyms", () => {
    expect(codePointToKeysym("界".codePointAt(0)!)).toBe(0x0100754c);
    expect(keyEventToKeysym(new KeyboardEvent("keydown", { key: "Meta", location: 2 }))).toBe(
      0xffec,
    );
    expect(keyEventToKeysym(new KeyboardEvent("keydown", { key: "Enter", location: 3 }))).toBe(
      0xff8d,
    );
  });

  it("preserves the exact macOS modifier side during delayed paste", () => {
    const event = new KeyboardEvent("keydown", { key: "v", metaKey: true });
    expect([...pasteModifierKeysyms(event, new Set([0xffec]))]).toEqual([0xffec]);
    expect([...pasteModifierKeysyms(event, new Set())]).toEqual([0xffeb]);
  });

  it("maps fit and 1:1 CSS coordinates to remote pixels without applying DPR", () => {
    const squareBounds = { left: 100, top: 50, width: 1000, height: 1000 };
    expect(clientPointToFramebuffer(600, 550, squareBounds, 1920, 1080, "fit")).toEqual({
      x: 960,
      y: 540,
    });
    expect(clientPointToFramebuffer(100, 50, squareBounds, 1920, 1080, "fit")).toEqual({
      x: 0,
      y: 0,
    });
    expect(
      clientPointToFramebuffer(
        1060,
        590,
        { left: 100, top: 50, width: 1920, height: 1080 },
        1920,
        1080,
        "one",
      ),
    ).toEqual({ x: 960, y: 540 });
  });
});

describe("VNC error normalization", () => {
  it("accepts Tauri object and JSON-string errors without exposing credentials", () => {
    const error = normalizeVncError(
      JSON.stringify({ code: "VNC_AUTH_FAILED", retryable: false, sanitizedMessage: "authentication failed" }),
    );
    expect(error.code).toBe("VNC_AUTH_FAILED");
    expect(error.sanitizedMessage).not.toContain("password");
  });

  it("retries only retryable network failures within the configured bound", () => {
    const network = {
      code: "VNC_CONNECTION_LOST",
      stage: "runtime",
      retryable: true,
      sanitizedMessage: "connection lost",
    };
    const certificate = { ...network, code: "VNC_TLS_FAILED", retryable: false };
    expect(shouldAutoReconnect(network, true, 0, 5)).toBe(true);
    expect(shouldAutoReconnect(network, true, 5, 5)).toBe(false);
    expect(shouldAutoReconnect(network, false, 0, 5)).toBe(false);
    expect(shouldAutoReconnect(certificate, true, 0, 5)).toBe(false);
  });

  it("uses bounded exponential reconnect delays with bounded jitter", () => {
    expect(vncReconnectDelayMs(0, 0)).toBe(500);
    expect(vncReconnectDelayMs(1, 0)).toBe(1000);
    expect(vncReconnectDelayMs(9, 1)).toBe(10_249);
    expect(vncReconnectDelayMs(100, -1)).toBe(10_000);
  });
});
