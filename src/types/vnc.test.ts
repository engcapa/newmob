import { describe, expect, it } from "vitest";
import {
  DEFAULT_VNC_CLIENT_OPTIONS,
  parseVncClientOptions,
  serializeVncClientOptions,
  vncAllowsClientClipboard,
  vncAllowsServerClipboard,
} from "./vnc";

describe("VNC client options", () => {
  it("uses safe compatibility defaults and rejects implicit None", () => {
    expect(parseVncClientOptions(undefined)).toEqual(DEFAULT_VNC_CLIENT_OPTIONS);
    expect(parseVncClientOptions({ vncSecurityPolicy: "invalid" }).securityPolicy).toBe(
      "legacy-compatible",
    );
  });

  it("round-trips persisted session options and clamps resource limits", () => {
    const parsed = parseVncClientOptions({
      vncSecurityPolicy: "allow-none",
      vncShared: false,
      vncViewOnly: true,
      vncClipboardPolicy: "server-to-client",
      vncAllowHtmlClipboard: true,
      vncMaxClipboardBytes: 99 * 1024 * 1024,
      vncAutoReconnect: false,
      vncMaxReconnectAttempts: 99,
    });

    expect(parsed.maxClipboardBytes).toBe(16 * 1024 * 1024);
    expect(parsed.maxReconnectAttempts).toBe(10);
    expect(parseVncClientOptions(serializeVncClientOptions(parsed))).toEqual(parsed);
  });

  it("enforces clipboard direction helpers", () => {
    expect(vncAllowsClientClipboard("client-to-server")).toBe(true);
    expect(vncAllowsClientClipboard("server-to-client")).toBe(false);
    expect(vncAllowsServerClipboard("server-to-client")).toBe(true);
    expect(vncAllowsServerClipboard("disabled")).toBe(false);
  });
});
