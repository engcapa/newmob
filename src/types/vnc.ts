export type VncSecurityPolicy =
  | "require-encryption"
  | "prefer-encryption"
  | "legacy-compatible";

export type VncClipboardPolicy =
  | "disabled"
  | "client-to-server"
  | "server-to-client"
  | "bidirectional";

export interface VncOptions {
  securityPolicy: VncSecurityPolicy;
  allowNone: boolean;
  shared: boolean;
  viewOnly: boolean;
  clipboardPolicy: VncClipboardPolicy;
  clipboardTextOnly: boolean;
  allowHtmlClipboard: boolean;
  allowRtfClipboard: boolean;
  clipboardMaxBytes: number;
  autoReconnect: boolean;
  reconnectMaxAttempts: number;
  commandKeyMode: "remote-meta" | "local-shortcuts";
}

export const DEFAULT_VNC_OPTIONS: VncOptions = {
  securityPolicy: "prefer-encryption",
  allowNone: false,
  shared: true,
  viewOnly: false,
  clipboardPolicy: "bidirectional",
  clipboardTextOnly: true,
  allowHtmlClipboard: false,
  allowRtfClipboard: false,
  clipboardMaxBytes: 16 * 1024 * 1024,
  autoReconnect: true,
  reconnectMaxAttempts: 5,
  commandKeyMode: "remote-meta",
};

const SECURITY_POLICIES = new Set<VncSecurityPolicy>([
  "require-encryption",
  "prefer-encryption",
  "legacy-compatible",
]);
const CLIPBOARD_POLICIES = new Set<VncClipboardPolicy>([
  "disabled",
  "client-to-server",
  "server-to-client",
  "bidirectional",
]);

export function parseVncOptions(optionsJson: string | null | undefined): VncOptions {
  if (!optionsJson) return { ...DEFAULT_VNC_OPTIONS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    return { ...DEFAULT_VNC_OPTIONS };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...DEFAULT_VNC_OPTIONS };
  }
  const raw = parsed as Record<string, unknown>;
  const securityPolicy = SECURITY_POLICIES.has(raw.securityPolicy as VncSecurityPolicy)
    ? (raw.securityPolicy as VncSecurityPolicy)
    : DEFAULT_VNC_OPTIONS.securityPolicy;
  const clipboardPolicy = CLIPBOARD_POLICIES.has(
    raw.clipboardPolicy as VncClipboardPolicy,
  )
    ? (raw.clipboardPolicy as VncClipboardPolicy)
    : DEFAULT_VNC_OPTIONS.clipboardPolicy;
  const clipboardTextOnly = raw.clipboardTextOnly !== false;
  return {
    securityPolicy,
    allowNone: raw.allowNone === true,
    shared: raw.shared !== false,
    viewOnly: raw.viewOnly === true,
    clipboardPolicy,
    clipboardTextOnly,
    allowHtmlClipboard: !clipboardTextOnly && raw.allowHtmlClipboard === true,
    allowRtfClipboard: !clipboardTextOnly && raw.allowRtfClipboard === true,
    clipboardMaxBytes: clampInteger(raw.clipboardMaxBytes, 1, 16 * 1024 * 1024),
    autoReconnect: raw.autoReconnect !== false,
    reconnectMaxAttempts: clampInteger(raw.reconnectMaxAttempts, 0, 10, 5),
    commandKeyMode:
      raw.commandKeyMode === "local-shortcuts" ? "local-shortcuts" : "remote-meta",
  };
}

export function serializeVncOptions(options: VncOptions): string {
  const clipboardTextOnly = options.clipboardTextOnly;
  return JSON.stringify({
    ...options,
    allowHtmlClipboard: !clipboardTextOnly && options.allowHtmlClipboard,
    allowRtfClipboard: !clipboardTextOnly && options.allowRtfClipboard,
    clipboardMaxBytes: clampInteger(options.clipboardMaxBytes, 1, 16 * 1024 * 1024),
    reconnectMaxAttempts: clampInteger(options.reconnectMaxAttempts, 0, 10, 5),
  });
}

export function vncClipboardSends(policy: VncClipboardPolicy): boolean {
  return policy === "client-to-server" || policy === "bidirectional";
}

export function vncClipboardReceives(policy: VncClipboardPolicy): boolean {
  return policy === "server-to-client" || policy === "bidirectional";
}

function clampInteger(value: unknown, min: number, max: number, fallback = max): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}
