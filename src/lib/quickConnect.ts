import type { AuthMethod, SessionConfig } from "./ipc";

const DEFAULT_PORTS: Record<string, number> = {
  SSH: 22,
  Telnet: 23,
  RDP: 3389,
  VNC: 5900,
  FTP: 21,
  SFTP: 22,
  Serial: 0,
  LocalShell: 0,
};

const PROTOCOL_ALIASES: Record<string, string> = {
  ssh: "SSH",
  sftp: "SFTP",
  ftp: "FTP",
  telnet: "Telnet",
  rdp: "RDP",
  vnc: "VNC",
  serial: "Serial",
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

export function parseQuickConnectInput(input: string): ParsedQuickConnect {
  const raw = input.trim();
  if (!raw) {
    throw new Error("Enter a host, URL, or local shell command.");
  }

  const now = Math.floor(Date.now() / 1000);
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

  const parsed = parseTarget(target);
  if (!parsed.host) {
    throw new Error("Remote host is required.");
  }

  const port = parsed.port ?? DEFAULT_PORTS[sessionType] ?? 22;
  const username = parsed.username ?? (sessionType === "SSH" || sessionType === "SFTP" ? "root" : null);
  let authMethod: AuthMethod = "None";
  let authData: string | null = null;
  if (sessionType === "SSH") {
    authMethod = "Password";
  } else if (sessionType === "VNC") {
    authMethod = "Password";
    // If the URL contained a password in the query string, capture it
    try {
      const url = new URL(target);
      if (url.searchParams.has("password")) {
        authData = url.searchParams.get("password");
      }
    } catch {
      // not a valid URL, ignore
    }
  }
  const titlePrefix = username ? `${username}@` : "";

  return {
    transient: true,
    authData,
    config: {
      id: `quick-${sessionType.toLowerCase()}-${Date.now()}`,
      name: `${sessionType.toLowerCase()}://${titlePrefix}${parsed.host}${port ? `:${port}` : ""}`,
      session_type: sessionType,
      group_path: null,
      host: parsed.host,
      port,
      username,
      auth_method: authMethod,
      options_json: "{}",
      created_at: now,
      updated_at: now,
      last_connected_at: null,
      sort_order: 0,
    },
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
