import { describe, expect, it } from "vitest";

import {
  applyExtended,
  encodeAck,
  encodeKey,
  encodePing,
  encodePointer,
  encodeResize,
  encodeWheel,
  extractRdpCertificateChallenge,
  formatRdpCertificateFingerprint,
  IN_ACK,
  IN_KEY,
  IN_PING,
  IN_POINTER,
  IN_RESIZE,
  IN_WHEEL,
  isRetryableRdpConnectError,
  keyEventToScancode,
  mouseButtonMask,
  normalizeRdpResizeSize,
  OUT_AUDIO,
  OUT_CURSOR,
  OUT_FRAME,
  parseAudioFrame,
  parseFrameTile,
  parseRdpCursorFrame,
  parseRdpWsText,
  RdpFrameBatchBuffer,
  RDP_CURSOR_BITMAP,
  RDP_CURSOR_DEFAULT,
  RDP_CURSOR_HIDDEN,
  rdpCursorToCss,
  wheelDeltaToRotationUnits,
} from "./rdp";
import {
  DEFAULT_RDP_OPTIONS,
  parseRdpOptions,
  serializeRdpOptions,
  type RdpOptions,
} from "../types/rdp";

describe("rdp WS encoders", () => {
  it("encodes ping/ack as single tag bytes", () => {
    expect(new Uint8Array(encodePing())).toEqual(new Uint8Array([IN_PING]));
    expect(new Uint8Array(encodeAck())).toEqual(new Uint8Array([IN_ACK]));
  });

  it("encodes a key event as [tag, down, scan_be]", () => {
    const buf = new Uint8Array(encodeKey(true, 0x1c)); // Enter
    expect(buf[0]).toBe(IN_KEY);
    expect(buf[1]).toBe(1);
    expect(buf[2]).toBe(0x00);
    expect(buf[3]).toBe(0x1c);
  });

  it("encodes a pointer event with big-endian coordinates", () => {
    const buf = new Uint8Array(encodePointer(0x0190, 0x012c, 0x05));
    expect(buf[0]).toBe(IN_POINTER);
    expect(buf[1]).toBe(0x05);
    expect(buf[2]).toBe(0x01);
    expect(buf[3]).toBe(0x90);
    expect(buf[4]).toBe(0x01);
    expect(buf[5]).toBe(0x2c);
  });

  it("encodes a resize event", () => {
    const buf = new Uint8Array(encodeResize(1920, 1080));
    expect(buf[0]).toBe(IN_RESIZE);
    expect(buf[1]).toBe(0x07);
    expect(buf[2]).toBe(0x80);
    expect(buf[3]).toBe(0x04);
    expect(buf[4]).toBe(0x38);
  });

  it("encodes a wheel event", () => {
    const buf = new Uint8Array(encodeWheel(0x0190, 0x012c, -120, true));
    expect(buf[0]).toBe(IN_WHEEL);
    expect(buf[1]).toBe(0);
    expect(buf[2]).toBe(0x01);
    expect(buf[3]).toBe(0x90);
    expect(buf[4]).toBe(0x01);
    expect(buf[5]).toBe(0x2c);
    expect(buf[6]).toBe(0xff);
    expect(buf[7]).toBe(0x88);
  });

  it("applyExtended sets bit 0x100 when extended", () => {
    expect(applyExtended(0x1d, false)).toBe(0x1d);
    expect(applyExtended(0x1d, true)).toBe(0x11d);
  });

  it("normalizes resize sizes to Display Control limits", () => {
    expect(normalizeRdpResizeSize(1367.4, 119.2)).toEqual({ width: 1366, height: 200 });
    expect(normalizeRdpResizeSize(8193, 9000)).toEqual({ width: 8192, height: 8192 });
    expect(normalizeRdpResizeSize(0, 1080)).toBeNull();
    expect(normalizeRdpResizeSize(Number.NaN, 1080)).toBeNull();
  });

  it("normalizes browser wheel deltas to RDP rotation units", () => {
    // One physical notch ≈ 100px (pixel mode) or 3 lines, and must map to
    // one RDP notch (WHEEL_DELTA = 120) so the server scrolls a full step.
    expect(wheelDeltaToRotationUnits(100, 0)).toBe(120);
    expect(wheelDeltaToRotationUnits(-100, 0)).toBe(-120);
    expect(wheelDeltaToRotationUnits(120, 0)).toBe(144);
    expect(wheelDeltaToRotationUnits(3, 1)).toBe(120);
    // Small/high-resolution deltas stay proportional for smooth scrolling.
    expect(wheelDeltaToRotationUnits(10, 0)).toBe(12);
    // Large deltas clamp to the 9-bit signed wire range.
    expect(wheelDeltaToRotationUnits(5000, 0)).toBe(255);
    expect(wheelDeltaToRotationUnits(Number.NaN, 0)).toBe(0);
  });
});

describe("RDP certificate challenges", () => {
  it("extracts an untrusted certificate fingerprint from a TLS error", () => {
    const observed = "ab".repeat(32);
    expect(
      extractRdpCertificateChallenge(
        `rdp TLS upgrade failed: RDP_CERTIFICATE_UNTRUSTED host=rdp.example.com port=3389 observed=${observed} system_error=unknown issuer`,
      ),
    ).toEqual({
      changed: false,
      host: "rdp.example.com",
      port: 3389,
      expected: undefined,
      observed,
    });
    expect(formatRdpCertificateFingerprint(observed)).toMatch(/^AB:AB:/);
  });

  it("extracts changed pins and ignores unrelated errors", () => {
    const expected = "11".repeat(32);
    const observed = "22".repeat(32);
    expect(
      extractRdpCertificateChallenge(
        `RDP_CERTIFICATE_CHANGED host=10.0.0.8 port=443 expected=${expected} observed=${observed}`,
      ),
    ).toEqual({ changed: true, host: "10.0.0.8", port: 443, expected, observed });
    expect(extractRdpCertificateChallenge("bad credentials")).toBeNull();
  });
});

describe("rdp WS frame parser", () => {
  it("parses a tile with the expected geometry", () => {
    const w = 4;
    const h = 2;
    const rgba = new Uint8Array([
      // 4×2 pixels, 32 bytes
      ...new Array(32).fill(0).map((_, i) => i % 256),
    ]);
    const buf = new Uint8Array(9 + rgba.length);
    buf[0] = OUT_FRAME;
    new DataView(buf.buffer).setUint16(1, 10);
    new DataView(buf.buffer).setUint16(3, 20);
    new DataView(buf.buffer).setUint16(5, w);
    new DataView(buf.buffer).setUint16(7, h);
    buf.set(rgba, 9);
    const tile = parseFrameTile(buf.buffer);
    expect(tile).not.toBeNull();
    expect(tile?.x).toBe(10);
    expect(tile?.y).toBe(20);
    expect(tile?.w).toBe(w);
    expect(tile?.h).toBe(h);
    expect(tile?.rgba.length).toBe(rgba.length);
  });

  it("returns null for non-FRAME frames", () => {
    const buf = new Uint8Array([99, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseFrameTile(buf.buffer)).toBeNull();
  });

  it("returns null when frame is too short", () => {
    const buf = new Uint8Array([OUT_FRAME, 0, 0]);
    expect(parseFrameTile(buf.buffer)).toBeNull();
  });

  it("keeps incremental tiles in order until the frame boundary", () => {
    const batch = new RdpFrameBatchBuffer();
    const first = {
      tag: OUT_FRAME,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      rgba: new Uint8ClampedArray([1, 2, 3, 255]),
    };
    const second = {
      ...first,
      x: 1,
      rgba: new Uint8ClampedArray([4, 5, 6, 255]),
    };
    batch.push(first, 2, 1);
    batch.push(second, 2, 1);
    expect(batch.finish()).toEqual({ tiles: [first, second], refreshRequired: false });
  });

  it("rejects a corrupt tile batch and requests a full refresh", () => {
    const batch = new RdpFrameBatchBuffer();
    batch.push({
      tag: OUT_FRAME,
      x: 0,
      y: 0,
      w: 2,
      h: 1,
      rgba: new Uint8ClampedArray([1, 2, 3, 255]),
    }, 2, 1);
    expect(batch.finish()).toEqual({ tiles: [], refreshRequired: true });
  });
});

describe("rdp WS audio parser", () => {
  it("parses a PCM audio packet with metadata", () => {
    const pcm = new Uint8Array([0, 1, 2, 3]);
    const buf = new Uint8Array(17 + pcm.length);
    const dv = new DataView(buf.buffer);
    buf[0] = OUT_AUDIO;
    dv.setUint32(1, 44_100);
    dv.setUint16(5, 2);
    dv.setUint16(7, 16);
    dv.setUint32(9, 0x1234_5678);
    dv.setUint16(13, 7);
    buf.set(pcm, 17);

    const frame = parseAudioFrame(buf.buffer);
    expect(frame).not.toBeNull();
    expect(frame?.sampleRate).toBe(44_100);
    expect(frame?.channels).toBe(2);
    expect(frame?.bitsPerSample).toBe(16);
    expect(frame?.timestamp).toBe(0x1234_5678);
    expect(frame?.formatNo).toBe(7);
    expect([...frame!.pcm]).toEqual([...pcm]);
  });

  it("returns null for non-audio packets", () => {
    const buf = new Uint8Array(17);
    buf[0] = OUT_FRAME;
    expect(parseAudioFrame(buf.buffer)).toBeNull();
  });
});

describe("rdp cursor channel", () => {
  it("maps default and hidden cursor messages to local CSS cursors", () => {
    expect(
      parseRdpCursorFrame(new Uint8Array([OUT_CURSOR, RDP_CURSOR_DEFAULT]).buffer),
    ).toEqual({ kind: "default" });
    const hidden = parseRdpCursorFrame(
      new Uint8Array([OUT_CURSOR, RDP_CURSOR_HIDDEN]).buffer,
    );
    expect(hidden).toEqual({ kind: "hidden" });
    expect(rdpCursorToCss(hidden!)).toBe("none");
  });

  it("parses a bounded PNG cursor with its remote hotspot", () => {
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const bytes = new Uint8Array(10 + pngSignature.length);
    const view = new DataView(bytes.buffer);
    bytes[0] = OUT_CURSOR;
    bytes[1] = RDP_CURSOR_BITMAP;
    view.setUint16(2, 3);
    view.setUint16(4, 4);
    view.setUint16(6, 32);
    view.setUint16(8, 32);
    bytes.set(pngSignature, 10);

    const cursor = parseRdpCursorFrame(bytes.buffer);

    expect(cursor).toMatchObject({
      kind: "bitmap",
      hotspotX: 3,
      hotspotY: 4,
      width: 32,
      height: 32,
    });
    expect(rdpCursorToCss(cursor!)).toMatch(
      /^url\("data:image\/png;base64,[A-Za-z0-9+/=]+"\) 3 4, default$/,
    );
  });

  it("rejects malformed or unbounded cursor messages", () => {
    const invalid = new Uint8Array(18);
    const view = new DataView(invalid.buffer);
    invalid[0] = OUT_CURSOR;
    invalid[1] = RDP_CURSOR_BITMAP;
    view.setUint16(6, 513);
    view.setUint16(8, 32);
    expect(parseRdpCursorFrame(invalid.buffer)).toBeNull();
    expect(parseRdpCursorFrame(new Uint8Array([OUT_FRAME, 0]).buffer)).toBeNull();
  });
});

describe("rdp WS text parser", () => {
  it("parses a connected event", () => {
    const msg = parseRdpWsText(
      JSON.stringify({
        type: "connected",
        width: 1920,
        height: 1080,
        protocol: "TLS",
        server_name: "host",
      }),
    );
    expect(msg?.type).toBe("connected");
    if (msg?.type === "connected") {
      expect(msg.width).toBe(1920);
      expect(msg.protocol).toBe("TLS");
    }
  });

  it("returns null for invalid JSON", () => {
    expect(parseRdpWsText("not json")).toBeNull();
  });

  it("preserves retryability on structured session errors", () => {
    const msg = parseRdpWsText(
      JSON.stringify({ type: "error", code: "rdp-session", message: "timed out", retryable: true }),
    );
    expect(msg).toMatchObject({ type: "error", retryable: true });
  });
});

describe("RDP connect retry classification", () => {
  it("retries transient network failures", () => {
    expect(isRetryableRdpConnectError("connection refused")).toBe(true);
    expect(isRetryableRdpConnectError("RDP proxy connection timed out after 30 seconds")).toBe(
      true,
    );
  });

  it("does not retry configuration, credential, or certificate failures", () => {
    expect(isRetryableRdpConnectError("invalid credentials")).toBe(false);
    expect(isRetryableRdpConnectError("certificate changed")).toBe(false);
    expect(isRetryableRdpConnectError("proxy type is not implemented")).toBe(false);
  });
});

describe("keyEventToScancode", () => {
  it("maps known key codes", () => {
    expect(keyEventToScancode({ code: "Enter" } as KeyboardEvent)).toEqual({
      scancode: 0x1c,
      extended: false,
    });
    expect(keyEventToScancode({ code: "ArrowUp" } as KeyboardEvent)).toEqual({
      scancode: 0x48,
      extended: true,
    });
    expect(keyEventToScancode({ code: "KeyA" } as KeyboardEvent)).toEqual({
      scancode: 0x1e,
      extended: false,
    });
    expect(keyEventToScancode({ code: "NumpadDivide" } as KeyboardEvent)).toEqual({
      scancode: 0x35,
      extended: true,
    });
    expect(keyEventToScancode({ code: "IntlBackslash" } as KeyboardEvent)).toEqual({
      scancode: 0x56,
      extended: false,
    });
  });

  it("returns null for unmapped codes", () => {
    expect(keyEventToScancode({ code: "AbsentKey" } as KeyboardEvent)).toBeNull();
  });
});

describe("mouseButtonMask", () => {
  it("translates DOM button bits to RDP mask", () => {
    expect(mouseButtonMask({ buttons: 1 } as MouseEvent)).toBe(0x01);
    expect(mouseButtonMask({ buttons: 2 } as MouseEvent)).toBe(0x02);
    expect(mouseButtonMask({ buttons: 4 } as MouseEvent)).toBe(0x04);
    expect(mouseButtonMask({ buttons: 7 } as MouseEvent)).toBe(0x07);
    expect(mouseButtonMask({ buttons: 0 } as MouseEvent)).toBe(0x00);
  });
});

describe("RdpOptions parse/serialize", () => {
  it("returns defaults for empty / invalid input", () => {
    expect(parseRdpOptions(undefined)).toEqual(DEFAULT_RDP_OPTIONS);
    expect(parseRdpOptions("")).toEqual(DEFAULT_RDP_OPTIONS);
    expect(parseRdpOptions("{not: json}")).toEqual(DEFAULT_RDP_OPTIONS);
    expect(parseRdpOptions("[1,2,3]")).toEqual(DEFAULT_RDP_OPTIONS);
  });

  it("defaults missing NLA to enabled while preserving explicit legacy TLS mode", () => {
    expect(parseRdpOptions('{"screenW":1280}').nla).toBe(true);
    expect(parseRdpOptions('{"nla":false}').nla).toBe(false);
  });

  it("round-trips a configuration with gateway", () => {
    const opts: RdpOptions = {
      ...DEFAULT_RDP_OPTIONS,
      domain: "CORP",
      colorDepth: 16,
      screenW: 1366,
      screenH: 768,
      nla: false,
      redirectClipboard: false,
      redirectAudio: "off",
      redirectDrive: { enabled: true, label: "SHARED", path: "/data", readOnly: false },
      gateway: {
        host: "rdg.example.com",
        port: 443,
        username: "alice@CORP",
        password: "vault:abc",
        auth: "ntlm",
        useSessionCreds: false,
      },
    };
    const json = serializeRdpOptions(opts);
    const back = parseRdpOptions(json);
    expect(back).toEqual(opts);
  });

  it("drops empty gateways and strips gateway password when reusing session credentials", () => {
    const emptyGatewayJson = serializeRdpOptions({
      ...DEFAULT_RDP_OPTIONS,
      gateway: {
        host: "",
        port: 443,
        username: "stale",
        password: "plain",
        auth: "ntlm",
        useSessionCreds: true,
      },
    });
    expect(JSON.parse(emptyGatewayJson)).not.toHaveProperty("gateway");

    const sessionCredGatewayJson = serializeRdpOptions({
      ...DEFAULT_RDP_OPTIONS,
      gateway: {
        host: " rdg.example.com ",
        port: 443,
        username: "stale",
        password: "plain",
        auth: "ntlm",
        useSessionCreds: true,
      },
    });
    expect(JSON.parse(sessionCredGatewayJson).gateway).toEqual({
      host: "rdg.example.com",
      port: 443,
      username: "",
      auth: "ntlm",
      useSessionCreds: true,
    });
  });

  it("clamps invalid color depth and screen sizes back to defaults", () => {
    const json = JSON.stringify({
      colorDepth: 7, // not in the allow-list
      screenW: 100, // below min
      screenH: 99999,
    });
    const o = parseRdpOptions(json);
    expect(o.colorDepth).toBe(32);
    expect(o.screenW).toBe(1920);
    expect(o.screenH).toBe(1080);
  });

  it("drops gateway when host is missing", () => {
    const json = JSON.stringify({ gateway: { port: 443 } });
    expect(parseRdpOptions(json).gateway).toBeUndefined();
  });

  it("truncates drive label longer than 8 chars", () => {
    const json = JSON.stringify({
      redirectDrive: { enabled: true, label: "VERYLONGLABEL", path: "/x" },
    });
    const drive = parseRdpOptions(json).redirectDrive;
    expect(drive.label).toBe("VERYLONG");
    expect(drive.readOnly).toBe(true);
  });
});
