/**
 * RDP-specific types persisted in `SessionConfig.options_json` and surfaced
 * through the `rdp_connect` Tauri command. Mirrors the Rust struct
 * `crate::rdp::RdpOptions` in `src-tauri/src/rdp/mod.rs`.
 */
export interface RdpOptions {
  domain?: string;
  colorDepth: number;
  screenW: number;
  screenH: number;
  nla: boolean;
  /** Optional SHA-256 pin used only when operating-system trust validation fails. */
  certificateFingerprint?: string;
  performance: RdpPerformanceFlags;
  redirectClipboard: boolean;
  redirectAudio: "play" | "off";
  redirectDrive: RdpDriveRedirect;
  gateway?: RdpGatewayOptions;
}

export interface RdpPerformanceFlags {
  wallpaper: boolean;
  themes: boolean;
  fontSmooth: boolean;
  disableFullWindowDrag: boolean;
  disableMenuAnimations: boolean;
  disableCursorShadow: boolean;
}

export interface RdpDriveRedirect {
  enabled: boolean;
  /** 8-character ASCII drive label (default `"TAOMNI"`). */
  label: string;
  /** Local folder to expose. Empty when `enabled` is false. */
  path: string;
}

export interface RdpGatewayOptions {
  host: string;
  port: number;
  username: string;
  /** May be a `vault:<id>` reference. */
  password?: string;
  auth: "basic" | "ntlm";
  /** When true, reuse the RDP session credentials for the gateway. */
  useSessionCreds: boolean;
  certificateFingerprint?: string;
}

export const DEFAULT_RDP_PERFORMANCE: RdpPerformanceFlags = {
  wallpaper: false,
  themes: false,
  fontSmooth: true,
  disableFullWindowDrag: true,
  disableMenuAnimations: true,
  disableCursorShadow: true,
};

export const DEFAULT_RDP_OPTIONS: RdpOptions = {
  colorDepth: 32,
  screenW: 1920,
  screenH: 1080,
  // Default to Network Level Authentication: CredSSP authenticates with the
  // saved credentials *before* the Windows logon screen, so they actually
  // sign the user in instead of landing on "其他用户 / 用户名或密码不正确".
  // Servers without NLA support can untick the box in the session editor.
  nla: true,
  performance: DEFAULT_RDP_PERFORMANCE,
  redirectClipboard: true,
  redirectAudio: "play",
  redirectDrive: { enabled: false, label: "TAOMNI", path: "" },
};

/** Parse RDP options from a session's `options_json`. Defaults fill in. */
export function parseRdpOptions(optionsJson: string | undefined | null): RdpOptions {
  if (!optionsJson) return { ...DEFAULT_RDP_OPTIONS };
  let raw: unknown;
  try {
    raw = JSON.parse(optionsJson);
  } catch {
    return { ...DEFAULT_RDP_OPTIONS };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_RDP_OPTIONS };
  const o = raw as Record<string, unknown>;
  const performance = mergePerformance(o.performance);
  const drive = mergeDrive(o.redirectDrive);
  const gateway = mergeGateway(o.gateway);
  return {
    domain: typeof o.domain === "string" && o.domain ? o.domain : undefined,
    colorDepth: clampInt(o.colorDepth, 32, [8, 15, 16, 24, 32]),
    screenW: clampInt(o.screenW, 1920, undefined, 320, 8192),
    screenH: clampInt(o.screenH, 1080, undefined, 200, 8192),
    nla: typeof o.nla === "boolean" ? o.nla : false,
    ...(normalizeFingerprint(o.certificateFingerprint)
      ? { certificateFingerprint: normalizeFingerprint(o.certificateFingerprint) }
      : {}),
    performance,
    redirectClipboard:
      typeof o.redirectClipboard === "boolean" ? o.redirectClipboard : true,
    redirectAudio:
      o.redirectAudio === "off" ? "off" : "play",
    redirectDrive: drive,
    gateway,
  };
}

/** Serialize back into JSON suitable for `SessionConfig.options_json`. */
export function serializeRdpOptions(opts: RdpOptions): string {
  const redirectDrive = {
    ...opts.redirectDrive,
    label: sanitizeDriveLabel(opts.redirectDrive.label),
    path: opts.redirectDrive.enabled ? opts.redirectDrive.path : "",
  };
  const gateway = normalizeGatewayForStorage(opts.gateway);
  return JSON.stringify({
    ...opts,
    domain: opts.domain?.trim() || undefined,
    certificateFingerprint: normalizeFingerprint(opts.certificateFingerprint),
    redirectDrive,
    gateway,
  });
}

function clampInt(
  raw: unknown,
  fallback: number,
  allowed?: number[],
  min?: number,
  max?: number,
): number {
  const n = typeof raw === "number" ? Math.floor(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  if (allowed && !allowed.includes(n)) return fallback;
  if (min !== undefined && n < min) return fallback;
  if (max !== undefined && n > max) return fallback;
  return n;
}

function mergePerformance(raw: unknown): RdpPerformanceFlags {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_RDP_PERFORMANCE };
  const o = raw as Record<string, unknown>;
  const pick = (k: keyof RdpPerformanceFlags, fb: boolean) =>
    typeof o[k] === "boolean" ? (o[k] as boolean) : fb;
  return {
    wallpaper: pick("wallpaper", false),
    themes: pick("themes", false),
    fontSmooth: pick("fontSmooth", true),
    disableFullWindowDrag: pick("disableFullWindowDrag", true),
    disableMenuAnimations: pick("disableMenuAnimations", true),
    disableCursorShadow: pick("disableCursorShadow", true),
  };
}

function mergeDrive(raw: unknown): RdpDriveRedirect {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_RDP_OPTIONS.redirectDrive };
  }
  const o = raw as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : false,
    label:
      typeof o.label === "string" && o.label.length > 0
        ? o.label.slice(0, 8)
        : "TAOMNI",
    path: typeof o.path === "string" ? o.path : "",
  };
}

function mergeGateway(raw: unknown): RdpGatewayOptions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.host !== "string" || !o.host) return undefined;
  return {
    host: o.host,
    port: clampInt(o.port, 443, undefined, 1, 65535),
    username: typeof o.username === "string" ? o.username : "",
    password: typeof o.password === "string" ? o.password : undefined,
    auth: o.auth === "basic" ? "basic" : "ntlm",
    useSessionCreds:
      typeof o.useSessionCreds === "boolean" ? o.useSessionCreds : true,
    ...(normalizeFingerprint(o.certificateFingerprint)
      ? { certificateFingerprint: normalizeFingerprint(o.certificateFingerprint) }
      : {}),
  };
}

function normalizeGatewayForStorage(
  raw: RdpGatewayOptions | undefined,
): RdpGatewayOptions | undefined {
  if (!raw || !raw.host.trim()) return undefined;
  const useSessionCreds = raw.useSessionCreds;
  return {
    host: raw.host.trim(),
    port: clampInt(raw.port, 443, undefined, 1, 65535),
    username: useSessionCreds ? "" : raw.username.trim(),
    password: useSessionCreds ? undefined : raw.password || undefined,
    auth: raw.auth === "basic" ? "basic" : "ntlm",
    useSessionCreds,
    certificateFingerprint: normalizeFingerprint(raw.certificateFingerprint),
  };
}

function normalizeFingerprint(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.replace(/[:\-\s]/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : undefined;
}

function sanitizeDriveLabel(label: string): string {
  const trimmed = label.trim();
  return (trimmed || "TAOMNI").slice(0, 8);
}
