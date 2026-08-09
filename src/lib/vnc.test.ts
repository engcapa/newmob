import { describe, expect, it } from "vitest";
import {
  codePointToKeysym,
  encodeWsAck,
  encodeWsKey,
  encodeWsPointer,
  iterCodePoints,
  keyEventToKeysym,
  parseFrameHeader,
} from "./vnc";

function keyboard(key: string, code = ""): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, code });
}

describe("VNC wire helpers", () => {
  it("encodes binary key and pointer controls in network byte order", () => {
    expect([...new Uint8Array(encodeWsAck(0x12345678))]).toEqual([
      0, 0x12, 0x34, 0x56, 0x78,
    ]);
    expect([...new Uint8Array(encodeWsKey(true, 0x01004e2d))]).toEqual([
      2, 1, 1, 0, 0x4e, 0x2d,
    ]);
    expect([...new Uint8Array(encodeWsPointer(0x1234, 0x5678, 5))]).toEqual([
      3, 5, 0x12, 0x34, 0x56, 0x78,
    ]);
  });

  it("maps Linux-relevant modifiers, AltGr, keypad, locks, and extended function keys", () => {
    expect(keyEventToKeysym(keyboard("Control", "ControlRight"))).toBe(0xffe4);
    expect(keyEventToKeysym(keyboard("AltGraph", "AltRight"))).toBe(0xfe03);
    expect(keyEventToKeysym(keyboard("7", "Numpad7"))).toBe(0xffb7);
    expect(keyEventToKeysym(keyboard("Enter", "NumpadEnter"))).toBe(0xff8d);
    expect(keyEventToKeysym(keyboard("NumLock", "NumLock"))).toBe(0xff7f);
    expect(keyEventToKeysym(keyboard("F24", "F24"))).toBe(0xffd5);
  });

  it("uses X11 Unicode keysyms and preserves surrogate-pair code points", () => {
    expect(codePointToKeysym(0x4e2d)).toBe(0x01004e2d);
    expect([...iterCodePoints("A😀")]).toEqual([0x41, 0x1f600]);
  });

  it("rejects truncated framebuffer headers", () => {
    expect(parseFrameHeader(new Uint8Array(11).buffer)).toBeNull();
  });

  it("reads the logical frame id from framebuffer headers", () => {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setUint32(8, 42);
    expect(parseFrameHeader(bytes.buffer)?.frameId).toBe(42);
  });
});
