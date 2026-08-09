import type { AuthMethod, SessionConfig } from "./ipc";
import {
  DEFAULT_NETWORK_SETTINGS,
  type IpVersion,
  type NetworkForward,
  type NetworkSettings,
} from "./networkSettings";

const DEFAULT_PORTS: Record<string, number> = {
  SSH: 22,
  Telnet: 23,
  Rlogin: 513,
  RDP: 3389,
  VNC: 5900,
  FTP: 21,
  SFTP: 22,
  Serial: 0,
  Browser: 0,
  Mosh: 60001,
  Mail: 993,
  LocalShell: 0,
};

const PROTOCOL_ALIASES: Record<string, string> = {
  ssh: "SSH",
  sftp: "SFTP",
  ftp: "FTP",
  telnet: "Telnet",
  rlogin: "Rlogin",
  mosh: "Mosh",
  rdp: "RDP",
  vnc: "VNC",
  serial: "Serial",
  browser: "Browser",
  http: "Browser",
  https: "Browser",
  mail: "Mail",
  imap: "Mail",
  shell: "LocalShell",
  local: "LocalShell",
  bash: "LocalShell",
  sh: "LocalShell",
};

export interface ParsedQuickConnect {
  config: SessionConfig;
  authData: string | null;
  transient: boolean;
}

export interface ParsedSshConnectionCommand {
  host: string;
  port: number;
  username: string | null;
  authMethod: AuthMethod;
  keyPath: string;
  options: {
    x11: boolean;
    x11Trusted: boolean;
    compression?: boolean;
    startupCmd?: string;
    doNotExit?: boolean;
    networkSettings?: NetworkSettings;
  };
}

export function parseQuickConnectInput(input: string): ParsedQuickConnect {
  const raw = input.trim();
  if (!raw) {
    throw new Error("Enter a host, URL, or local shell command.");
  }

  const now = Math.floor(Date.now() / 1000);
  const sshCommand = parseSshConnectionCommand(raw);
  if (sshCommand) return sshCommandToQuickConnect(sshCommand, now);

  const { sessionType, target } = splitProtocol(raw);

  if (sessionType === "LocalShell") {
    return {
      transient: true,
      authData: null,
      config: {
        id: `quick-local-${Date.now()}`,
        name: "Local terminal",
        session_type: "LocalShell",
        group_path: null,
        host: "",
        port: 0,
        username: null,
        auth_method: "None",
        options_json: "{}",
        created_at: now,
        updated_at: now,
        last_connected_at: null,
        sort_order: 0,
      },
    };
  }

  if (sessionType === "Browser") {
    const url = normalizeBrowserTarget(target);
    if (!url) {
      throw new Error("Browser URL or host is required.");
    }
    return {
      transient: true,
      authData: null,
      config: {
        id: `quick-browser-${Date.now()}`,
        name: url,
        session_type: "Browser",
        group_path: null,
        host: url,
        port: 0,
        username: null,
        auth_method: "None",
        options_json: "{}",
        created_at: now,
        updated_at: now,
        last_connected_at: null,
        sort_order: 0,
      },
    };
  }

  const parsed = parseTarget(target);
  if (!parsed.host) {
    throw new Error(sessionType === "Serial" ? "Serial device path is required." : "Remote host is required.");
  }

  const serialBaud = sessionType === "Serial" && parsed.port ? parsed.port : null;
  const port = sessionType === "Serial" ? 0 : (parsed.port ?? DEFAULT_PORTS[sessionType] ?? 22);
  const username = parsed.username ?? (sessionType === "SSH" || sessionType === "SFTP" ? "root" : null);
  const authMethod: AuthMethod =
    sessionType === "SSH" || sessionType === "RDP" || sessionType === "VNC" || sessionType === "Mail"
      ? "Password"
      : "None";
  const titlePrefix = username ? `${username}@` : "";
  const optionsJson = sessionType === "Mail"
    ? JSON.stringify({
        mailSignature: "",
        mailImapSecurity: "TLS",
        mailSmtpHost: "",
        mailSmtpPort: "465",
        mailSmtpSecurity: "TLS",
        mailSmtpUseImapAuth: true,
        mailCacheEnabled: true,
        mailSaveDirectory: "",
        mailHeaderRetentionDays: "30",
        mailHeaderLimitPerFolder: "2000",
        mailBodyRecentLimit: "200",
        mailBodyMaxBytes: "262144",
        mailAttachmentCache: false,
        mailSyncOnOpen: true,
        mailSyncIntervalMinutes: "5",
        mailMaxFetchPerSync: "200",
        mailAiEnabled: true,
        mailAiSkipBodyConfirm: false,
      })
    : serialBaud ? JSON.stringify({ serialBaud: String(serialBaud) }) : "{}";

  return {
    transient: true,
    authData: null,
    config: {
      id: `quick-${sessionType.toLowerCase()}-${Date.now()}`,
      name: `${sessionType.toLowerCase()}://${titlePrefix}${parsed.host}${port ? `:${port}` : ""}`,
      session_type: sessionType,
      group_path: null,
      host: parsed.host,
      port,
      username,
      auth_method: authMethod,
      options_json: optionsJson,
      created_at: now,
      updated_at: now,
      last_connected_at: null,
      sort_order: 0,
    },
  };
}

export function parseSshConnectionCommand(command: string): ParsedSshConnectionCommand | null {
  const tokens = shellSplit(command);
  const sshIndex = tokens.findIndex(isSshExecutable);
  if (sshIndex < 0) return null;

  let port = 22;
  let explicitPort = false;
  let username: string | null = null;
  let keyPath = "";
  let hostOverride = "";
  let hostToken = "";
  let startupTokens: string[] = [];
  let compression = false;
  let x11 = false;
  let x11Trusted = true;
  let ipVersion: IpVersion = "auto";
  let keepAliveIntervalSecs = "";
  let jumpSpec = "";
  const localForwards: NetworkForward[] = [];

  const readValue = (index: number, attached = ""): { value: string; nextIndex: number } | null => {
    if (attached) return { value: attached, nextIndex: index };
    const value = tokens[index + 1];
    return value ? { value, nextIndex: index + 1 } : null;
  };

  for (let i = sshIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    if (token === "--") {
      hostToken = tokens[i + 1] ?? "";
      startupTokens = tokens.slice(i + 2);
      break;
    }

    if (!hostToken && token.startsWith("-") && token !== "-") {
      if (token === "-p" || token.startsWith("-p")) {
        const value = readValue(i, token.length > 2 ? token.slice(2) : "");
        if (value) {
          port = parseNumber(value.value, 22);
          explicitPort = true;
          i = value.nextIndex;
        }
        continue;
      }
      if (token === "-l" || token.startsWith("-l")) {
        const value = readValue(i, token.length > 2 ? token.slice(2) : "");
        if (value) {
          username = value.value.trim() || username;
          i = value.nextIndex;
        }
        continue;
      }
      if (token === "-i" || token.startsWith("-i")) {
        const value = readValue(i, token.length > 2 ? token.slice(2) : "");
        if (value) {
          keyPath = value.value.trim();
          i = value.nextIndex;
        }
        continue;
      }
      if (token === "-J" || token.startsWith("-J")) {
        const value = readValue(i, token.length > 2 ? token.slice(2) : "");
        if (value) {
          jumpSpec = value.value.trim();
          i = value.nextIndex;
        }
        continue;
      }
      if (token === "-L" || token.startsWith("-L")) {
        const value = readValue(i, token.length > 2 ? token.slice(2) : "");
        if (value) {
          const forward = parseLocalForward(value.value);
          if (forward) localForwards.push(forward);
          i = value.nextIndex;
        }
        continue;
      }
      if (token === "-o" || token.startsWith("-o")) {
        const value = readValue(i, token.length > 2 ? token.slice(2) : "");
        if (value) {
          const option = parseOpenSshOption(value.value);
          if (option) {
            switch (option.key) {
              case "compression":
                compression = option.value === "yes" || option.value === "true";
                break;
              case "forwardx11":
                x11 = option.value === "yes" || option.value === "true";
                break;
              case "forwardx11trusted":
                x11 = true;
                x11Trusted = option.value !== "no" && option.value !== "false";
                break;
              case "hostname":
                hostOverride = option.value;
                break;
              case "identityfile":
                keyPath = option.value;
                break;
              case "localforward": {
                const forward = parseLocalForward(option.value);
                if (forward) localForwards.push(forward);
                break;
              }
              case "port":
                port = parseNumber(option.value, 22);
                explicitPort = true;
                break;
              case "proxyjump":
                jumpSpec = option.value;
                break;
              case "serveraliveinterval": {
                const interval = parseNumber(option.value, 0);
                keepAliveIntervalSecs = interval > 0 ? String(interval) : "";
                break;
              }
              case "user":
                username = option.value || username;
                break;
              case "addressfamily":
                if (option.value === "inet") ipVersion = "ipv4";
                else if (option.value === "inet6") ipVersion = "ipv6";
                else ipVersion = "auto";
                break;
            }
          }
          i = value.nextIndex;
        }
        continue;
      }
      if (token === "-C" || token.includes("C")) {
        compression = true;
      }
      if (token === "-X") {
        x11 = true;
        x11Trusted = false;
      } else if (token === "-Y") {
        x11 = true;
        x11Trusted = true;
      } else if (token === "-4") {
        ipVersion = "ipv4";
      } else if (token === "-6") {
        ipVersion = "ipv6";
      }
      if (optionConsumesValue(token)) i += 1;
      continue;
    }

    hostToken = token;
    startupTokens = tokens.slice(i + 1);
    break;
  }

  if (!hostToken) return null;

  let target: ReturnType<typeof parseTarget>;
  try {
    target = parseTarget(hostToken);
  } catch {
    return null;
  }
  if (!target.host) return null;
  if (target.username) username = target.username;
  if (target.port && !explicitPort) port = target.port;

  const jump = firstJumpTarget(jumpSpec);
  const needsNetworkSettings =
    !!jump ||
    localForwards.length > 0 ||
    !!keepAliveIntervalSecs ||
    ipVersion !== "auto";

  const options: ParsedSshConnectionCommand["options"] = {
    x11,
    x11Trusted,
  };
  if (compression) options.compression = true;
  if (startupTokens.length > 0) {
    options.startupCmd = startupTokens.map(quoteCommandToken).join(" ");
    options.doNotExit = false;
  }
  if (needsNetworkSettings) {
    options.networkSettings = cloneNetworkSettings({
      ...DEFAULT_NETWORK_SETTINGS,
      ...(jump
        ? {
            proxyKind: "ssh-tunnel",
            jumpHost: jump.host,
            jumpPort: String(jump.port ?? 22),
            jumpUser: jump.username ?? "",
            jumpSessionId: "",
          }
        : {}),
      ...(keepAliveIntervalSecs ? { keepAlive: true, keepAliveIntervalSecs } : {}),
      ipVersion,
      localForwards,
    });
  }

  return {
    host: hostOverride || target.host,
    port,
    username,
    authMethod: keyPath ? { PrivateKey: { key_path: keyPath } } : "Password",
    keyPath,
    options,
  };
}

export function parseOpenSshConfig(text: string): SessionConfig[] {
  const now = Math.floor(Date.now() / 1000);
  const sessions: SessionConfig[] = [];
  let current: Record<string, string> | null = null;

  const flush = () => {
    if (!current?.alias || current.alias.includes("*")) return;
    const host = current.hostname ?? current.alias;
    sessions.push({
      id: crypto.randomUUID(),
      name: current.alias,
      session_type: "SSH",
      group_path: "Imported",
      host,
      port: parseNumber(current.port, 22),
      username: current.user ?? null,
      auth_method: current.identityfile
        ? { PrivateKey: { key_path: current.identityfile } }
        : "Password",
      options_json: "{}",
      created_at: now,
      updated_at: now,
      last_connected_at: null,
      sort_order: 0,
    });
  };

  for (const originalLine of text.split(/\r?\n/)) {
    const line = originalLine.replace(/#.*/, "").trim();
    if (!line) continue;

    const [keyPart, ...rest] = line.split(/\s+/);
    const key = keyPart.toLowerCase();
    const value = rest.join(" ").trim();

    if (key === "host") {
      flush();
      current = { alias: value.split(/\s+/)[0] };
      continue;
    }

    if (current && value) {
      current[key] = stripQuotes(value);
    }
  }

  flush();
  return sessions;
}

export function parseUserHostPort(value: string): {
  username?: string;
  host: string;
  port?: number;
} | null {
  const target = value.trim();
  if (!target) return null;
  return parseTarget(target);
}

function splitProtocol(raw: string): { sessionType: string; target: string } {
  const commandMatch = raw.match(/^([a-z][a-z0-9+.-]*)\s+(.+)$/i);
  if (commandMatch) {
    const protocol = PROTOCOL_ALIASES[commandMatch[1].toLowerCase()];
    if (protocol) return { sessionType: protocol, target: commandMatch[2].trim() };
  }

  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const protocol = PROTOCOL_ALIASES[schemeMatch[1].toLowerCase()] ?? "SSH";
    return { sessionType: protocol, target: raw };
  }

  const alias = PROTOCOL_ALIASES[raw.toLowerCase()];
  if (alias === "LocalShell") {
    return { sessionType: "LocalShell", target: "" };
  }

  return { sessionType: "SSH", target: raw };
}

function normalizeBrowserTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) return "";
  if (/^browser:\/\//i.test(trimmed)) {
    return `https://${trimmed.replace(/^browser:\/\//i, "")}`;
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, "")}`;
}

function parseTarget(target: string): { username?: string; host: string; port?: number } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    const url = new URL(target);
    return {
      username: url.username ? decodeURIComponent(url.username) : undefined,
      host: url.hostname,
      port: url.port ? parseNumber(url.port, undefined) : undefined,
    };
  }

  let rest = target.trim();
  let username: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at > 0) {
    username = rest.slice(0, at).trim() || undefined;
    rest = rest.slice(at + 1).trim();
  }

  const ipv6Match = rest.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (ipv6Match) {
    return {
      username,
      host: ipv6Match[1],
      port: ipv6Match[2] ? parseNumber(ipv6Match[2], undefined) : undefined,
    };
  }

  const portMatch = rest.match(/^(.+):(\d+)$/);
  if (portMatch && !portMatch[1].includes(":")) {
    return {
      username,
      host: portMatch[1].trim(),
      port: parseNumber(portMatch[2], undefined),
    };
  }

  return { username, host: rest };
}

function parseNumber(value: string | undefined, fallback: number | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : (fallback ?? 0);
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function sshCommandToQuickConnect(parsed: ParsedSshConnectionCommand, now: number): ParsedQuickConnect {
  const titlePrefix = parsed.username ? `${parsed.username}@` : "";
  return {
    transient: true,
    authData: null,
    config: {
      id: `quick-ssh-${Date.now()}`,
      name: `ssh://${titlePrefix}${parsed.host}${parsed.port ? `:${parsed.port}` : ""}`,
      session_type: "SSH",
      group_path: null,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      auth_method: parsed.authMethod,
      options_json: JSON.stringify(parsed.options),
      created_at: now,
      updated_at: now,
      last_connected_at: null,
      sort_order: 0,
    },
  };
}

function shellSplit(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: string | null = null;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function isSshExecutable(token: string): boolean {
  const normalized = token.toLowerCase();
  return normalized === "ssh" ||
    normalized === "ssh.exe" ||
    normalized.endsWith("/ssh") ||
    normalized.endsWith("\\ssh.exe");
}

function optionConsumesValue(token: string): boolean {
  return /^-[bcDeFIimOoQRSWw]$/.test(token);
}

function parseOpenSshOption(value: string): { key: string; value: string } | null {
  const equals = value.indexOf("=");
  if (equals < 0) return null;
  const key = value.slice(0, equals).trim().toLowerCase();
  const optionValue = stripQuotes(value.slice(equals + 1).trim());
  return key ? { key, value: optionValue } : null;
}

function parseLocalForward(value: string): NetworkForward | null {
  const parts = splitColonOutsideBrackets(value.trim());
  if (parts.length < 3) return null;
  const remote = parts.slice(-2).join(":").trim();
  const rawLocal = parts.slice(0, -2).join(":").trim();
  const local = /^\d+$/.test(rawLocal) ? `127.0.0.1:${rawLocal}` : rawLocal;
  if (!local || !remote) return null;
  return {
    id: createId("ssh-forward"),
    local,
    remote,
    desc: "",
  };
}

function firstJumpTarget(value: string): { username?: string; host: string; port?: number } | null {
  const first = value.split(",")[0]?.trim();
  if (!first) return null;
  try {
    const parsed = parseTarget(first);
    return parsed.host ? parsed : null;
  } catch {
    return null;
  }
}

function splitColonOutsideBrackets(value: string): string[] {
  const parts: string[] = [];
  let part = "";
  let bracketDepth = 0;
  for (const char of value) {
    if (char === "[") bracketDepth += 1;
    if (char === "]" && bracketDepth > 0) bracketDepth -= 1;
    if (char === ":" && bracketDepth === 0) {
      parts.push(part);
      part = "";
      continue;
    }
    part += char;
  }
  parts.push(part);
  return parts.map((item) => item.trim()).filter(Boolean);
}

function quoteCommandToken(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./~\-[\]]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function cloneNetworkSettings(settings: NetworkSettings): NetworkSettings {
  return {
    ...settings,
    localForwards: settings.localForwards.map((forward) => ({ ...forward })),
  };
}

function createId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
