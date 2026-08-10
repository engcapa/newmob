export type VncSecurityPolicy =
  | "require-encryption"
  | "prefer-encryption"
  | "legacy-compatible"
  | "allow-none";

export type VncClipboardPolicy =
  | "disabled"
  | "client-to-server"
  | "server-to-client"
  | "bidirectional";

export interface VncClientOptions {
  securityPolicy: VncSecurityPolicy;
  shared: boolean;
  viewOnly: boolean;
  clipboardPolicy: VncClipboardPolicy;
  allowHtmlClipboard: boolean;
  allowRtfClipboard: boolean;
  maxClipboardBytes: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
}

export const DEFAULT_VNC_CLIENT_OPTIONS: VncClientOptions = {
  securityPolicy: "legacy-compatible",
  shared: true,
  viewOnly: false,
  clipboardPolicy: "bidirectional",
  allowHtmlClipboard: false,
  allowRtfClipboard: false,
  maxClipboardBytes: 16 * 1024 * 1024,
  autoReconnect: true,
  maxReconnectAttempts: 3,
};

const SECURITY_POLICIES = new Set<VncSecurityPolicy>([
  "require-encryption",
  "prefer-encryption",
  "legacy-compatible",
  "allow-none",
]);

const CLIPBOARD_POLICIES = new Set<VncClipboardPolicy>([
  "disabled",
  "client-to-server",
  "server-to-client",
  "bidirectional",
]);

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

export function parseVncClientOptions(value: unknown): VncClientOptions {
  const options = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const securityPolicy = SECURITY_POLICIES.has(options.vncSecurityPolicy as VncSecurityPolicy)
    ? options.vncSecurityPolicy as VncSecurityPolicy
    : DEFAULT_VNC_CLIENT_OPTIONS.securityPolicy;
  const clipboardPolicy = CLIPBOARD_POLICIES.has(
    options.vncClipboardPolicy as VncClipboardPolicy,
  )
    ? options.vncClipboardPolicy as VncClipboardPolicy
    : DEFAULT_VNC_CLIENT_OPTIONS.clipboardPolicy;

  return {
    securityPolicy,
    shared: options.vncShared !== false,
    viewOnly: options.vncViewOnly === true,
    clipboardPolicy,
    allowHtmlClipboard: options.vncAllowHtmlClipboard === true,
    allowRtfClipboard: options.vncAllowRtfClipboard === true,
    maxClipboardBytes: boundedInteger(
      options.vncMaxClipboardBytes,
      DEFAULT_VNC_CLIENT_OPTIONS.maxClipboardBytes,
      1,
      DEFAULT_VNC_CLIENT_OPTIONS.maxClipboardBytes,
    ),
    autoReconnect: options.vncAutoReconnect !== false,
    maxReconnectAttempts: boundedInteger(
      options.vncMaxReconnectAttempts,
      DEFAULT_VNC_CLIENT_OPTIONS.maxReconnectAttempts,
      0,
      10,
    ),
  };
}

export function serializeVncClientOptions(options: VncClientOptions): Record<string, unknown> {
  return {
    vncSecurityPolicy: options.securityPolicy,
    vncShared: options.shared,
    vncViewOnly: options.viewOnly,
    vncClipboardPolicy: options.clipboardPolicy,
    vncAllowHtmlClipboard: options.allowHtmlClipboard,
    vncAllowRtfClipboard: options.allowRtfClipboard,
    vncMaxClipboardBytes: options.maxClipboardBytes,
    vncAutoReconnect: options.autoReconnect,
    vncMaxReconnectAttempts: options.maxReconnectAttempts,
  };
}

export function vncAllowsClientClipboard(policy: VncClipboardPolicy): boolean {
  return policy === "client-to-server" || policy === "bidirectional";
}

export function vncAllowsServerClipboard(policy: VncClipboardPolicy): boolean {
  return policy === "server-to-client" || policy === "bidirectional";
}
