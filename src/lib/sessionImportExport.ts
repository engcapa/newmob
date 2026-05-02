import type { AuthMethod, SessionConfig } from "./ipc";
import {
  groupPathContains,
  leafGroupName,
  normalizeGroupPath,
  toStoredGroupPath,
} from "./sessionPaths";
import { normalizeTerminalProfile, parseSessionOptions } from "./terminalProfile";

const NEWMOB_FORMAT = "newmob.sessions";
const NEWMOB_SCHEMA_VERSION = 1;
const MAX_IMPORT_CHARS = 2_000_000;
const MAX_SESSIONS = 5_000;
const MAX_NAME_LENGTH = 160;
const MAX_HOST_LENGTH = 512;
const MAX_PATH_LENGTH = 1_024;
const MAX_OPTION_LENGTH = 4_000;

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

const MOBAXTERM_TYPE_TO_SESSION: Record<string, string> = {
  "0": "SSH",
  "4": "RDP",
  "5": "VNC",
  "7": "SFTP",
};

const MOBAXTERM_EXPORT_TYPES: Record<string, { code: string; icon: string }> = {
  SSH: { code: "0", icon: "109" },
  RDP: { code: "4", icon: "91" },
  VNC: { code: "5", icon: "128" },
  SFTP: { code: "7", icon: "140" },
};

export interface SessionImportOptions {
  targetFolder?: string | null;
  existingSessions?: readonly SessionConfig[];
  now?: number;
}

export interface SessionImportResult {
  sessions: SessionConfig[];
  warnings: string[];
  skipped: number;
}

export interface SessionExportResult {
  filename: string;
  text: string;
  mimeType: string;
  warnings: string[];
  skipped: number;
}

interface PortableSession {
  name: string;
  type: string;
  folder_path: string | null;
  host: string;
  port: number;
  username: string | null;
  auth: PortableAuth;
  options: Record<string, unknown>;
  sort_order: number;
}

type PortableAuth =
  | { kind: "password" }
  | { kind: "private-key"; private_key_path: string }
  | { kind: "agent" }
  | { kind: "none" };

let fallbackIdCounter = 0;

export function parseNewMobSessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }

  const warnings: string[] = [];
  const now = resolveNow(options.now);
  const parsedRows = extractNewMobRows(parsed, warnings);
  const sessions = parsedRows.items
    .map(({ row, folderMode, scopeFolder }) =>
      rowToSession(row, folderMode, scopeFolder, options.targetFolder ?? null, now, warnings))
    .filter((session): session is SessionConfig => session !== null);

  const skipped = parsedRows.skipped + parsedRows.items.length - sessions.length;
  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}

export function serializeNewMobSessions(
  sessions: readonly SessionConfig[],
  scopeFolder: string | null,
): SessionExportResult {
  const exportedAt = new Date().toISOString();
  const portableSessions = sessions.map((session) => toPortableSession(session, scopeFolder));
  const payload = {
    format: NEWMOB_FORMAT,
    schema_version: NEWMOB_SCHEMA_VERSION,
    exported_at: exportedAt,
    security: {
      secrets: "excluded",
      includes_private_key_paths: true,
    },
    scope: {
      folder_path: normalizeGroupPath(scopeFolder),
    },
    sessions: portableSessions,
  };

  return {
    filename: `${slugify(normalizeGroupPath(scopeFolder) ?? "user-sessions")}.newmob-sessions.json`,
    text: JSON.stringify(payload, null, 2),
    mimeType: "application/json",
    warnings: [],
    skipped: 0,
  };
}

export function parseCsvSessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new Error("The selected CSV file is empty.");
  }

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const hasHeader = ["name", "session_type", "type", "host"].some((key) => headers.includes(key));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const now = resolveNow(options.now);
  const sessions = dataRows
    .filter((row) => row.some((cell) => cell.trim()))
    .slice(0, MAX_SESSIONS)
    .map((row) => csvRowToSession(row, hasHeader ? headers : null, options.targetFolder ?? null, now, warnings))
    .filter((session): session is SessionConfig => session !== null);

  const skipped = dataRows.length - sessions.length;
  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}

export function parseMobaXtermSessions(
  input: string | ArrayBuffer | Uint8Array,
  options: SessionImportOptions = {},
): SessionImportResult {
  const text = typeof input === "string" ? input : decodeMobaXtermText(toUint8Array(input));
  assertImportSize(text);

  const warnings: string[] = [];
  const sections = parseMobaIni(text);
  const now = resolveNow(options.now);
  const sessions: SessionConfig[] = [];
  let skipped = 0;

  for (const section of sections) {
    const sectionFolder = normalizeGroupPath(section.subRep);
    const groupPath = combineImportFolder(options.targetFolder ?? null, sectionFolder);

    for (const entry of section.entries) {
      const session = mobaEntryToSession(entry.key, entry.value, groupPath, now, warnings);
      if (session) {
        sessions.push(session);
      } else {
        skipped += 1;
      }
    }
  }

  if (sessions.length > MAX_SESSIONS) {
    warnings.push(`Only the first ${MAX_SESSIONS} sessions were imported.`);
    skipped += sessions.length - MAX_SESSIONS;
    sessions.length = MAX_SESSIONS;
  }

  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}

export function serializeMobaXtermSessions(
  sessions: readonly SessionConfig[],
  scopeFolder: string | null,
): SessionExportResult {
  const warnings: string[] = [];
  const sectionMap = new Map<string, SessionConfig[]>();
  const rootFolder = mobaRootFolder(scopeFolder);
  ensureMobaSection(sectionMap, rootFolder);

  for (const session of sessions) {
    const folder = mobaFolderForSession(session, scopeFolder);
    ensureMobaSection(sectionMap, folder);
    sectionMap.get(folder)?.push(session);
  }

  const sortedFolders = [...sectionMap.keys()].sort((a, b) => {
    if (a === rootFolder) return -1;
    if (b === rootFolder) return 1;
    return a.localeCompare(b);
  });

  let skipped = 0;
  const lines: string[] = [];
  let sectionIndex = 0;

  for (const folder of sortedFolders) {
    if (folder === rootFolder) {
      lines.push("[Bookmarks]");
      lines.push(`SubRep=${safeMobaIniValue(folder, "folder", warnings)}`);
      lines.push(`ImgNum=${scopeFolder ? "41" : "42"}`);
    } else {
      sectionIndex += 1;
      lines.push("");
      lines.push(`[Bookmarks_${sectionIndex}]`);
      lines.push(`SubRep=${safeMobaIniValue(folder, "folder", warnings)}`);
      lines.push("ImgNum=41");
    }

    const usedNames = new Set<string>();
    for (const session of sectionMap.get(folder) ?? []) {
      const line = mobaSessionLine(session, usedNames, warnings);
      if (line) {
        lines.push(line);
      } else {
        skipped += 1;
      }
    }
  }

  return {
    filename: `${slugify(normalizeGroupPath(scopeFolder) ?? "user-sessions")}.mxtsessions`,
    text: `${lines.join("\r\n")}\r\n`,
    mimeType: "application/octet-stream",
    warnings,
    skipped,
  };
}

function extractNewMobRows(
  parsed: unknown,
  warnings: string[],
): {
  items: Array<{ row: unknown; folderMode: "portable" | "legacy"; scopeFolder: string | null }>;
  skipped: number;
} {
  if (Array.isArray(parsed)) {
    warnings.push("Imported legacy NewMob JSON array format.");
    const limited = limitRows(parsed, warnings);
    return {
      items: limited.rows.map((row) => ({ row, folderMode: "legacy", scopeFolder: null })),
      skipped: limited.skipped,
    };
  }

  if (!isRecord(parsed)) {
    throw new Error("The selected file does not contain a sessions array.");
  }

  if (parsed.format === NEWMOB_FORMAT) {
    if (parsed.schema_version !== NEWMOB_SCHEMA_VERSION) {
      throw new Error(`Unsupported NewMob sessions schema version: ${String(parsed.schema_version)}.`);
    }
    if (!Array.isArray(parsed.sessions)) {
      throw new Error("The NewMob sessions file does not contain a sessions array.");
    }
    const scopeFolder = isRecord(parsed.scope)
      ? normalizeGroupPath(firstString(parsed.scope.folder_path, parsed.scope.folder))
      : null;
    const limited = limitRows(parsed.sessions, warnings);
    return {
      items: limited.rows.map((row) => ({ row, folderMode: "portable", scopeFolder })),
      skipped: limited.skipped,
    };
  }

  if (Array.isArray(parsed.sessions)) {
    warnings.push("Imported legacy NewMob JSON object format.");
    const limited = limitRows(parsed.sessions, warnings);
    return {
      items: limited.rows.map((row) => ({ row, folderMode: "legacy", scopeFolder: null })),
      skipped: limited.skipped,
    };
  }

  throw new Error("The selected file does not contain a sessions array.");
}

function rowToSession(
  row: unknown,
  folderMode: "portable" | "legacy",
  scopeFolder: string | null,
  targetFolder: string | null,
  now: number,
  warnings: string[],
): SessionConfig | null {
  if (!isRecord(row)) {
    warnings.push("Skipped a session entry because it is not an object.");
    return null;
  }

  const sessionType = sanitizeSessionType(firstString(row.type, row.session_type), warnings);
  if (!sessionType) return null;

  const host = cleanText(firstString(row.host), MAX_HOST_LENGTH);
  if (sessionType !== "LocalShell" && sessionType !== "Serial" && !host) {
    warnings.push(`Skipped "${firstString(row.name) || sessionType}" because host is empty.`);
    return null;
  }

  const rowFolder = folderMode === "portable"
    ? combineImportFolder(scopeFolder, normalizeGroupPath(firstString(row.folder_path, row.folder)))
    : normalizeGroupPath(firstString(row.group_path));

  const groupPath = folderMode === "legacy" && targetFolder
    ? toStoredGroupPath(targetFolder)
    : toStoredGroupPath(combineImportFolder(targetFolder, rowFolder));

  const name = cleanText(firstString(row.name), MAX_NAME_LENGTH) || host || sessionType;
  const username = optionalCleanText(firstString(row.username), MAX_NAME_LENGTH);
  const auth = folderMode === "portable"
    ? portableAuthToAuthMethod(row.auth)
    : sanitizeAuthMethod(row.auth_method);
  const optionsJson = JSON.stringify(sanitizeOptions(firstKnown(row.options, row.options_json)));

  return {
    id: createSessionId(),
    name,
    session_type: sessionType,
    group_path: groupPath,
    host,
    port: sanitizePort(row.port, DEFAULT_PORTS[sessionType] ?? 0),
    username,
    auth_method: auth,
    options_json: optionsJson,
    created_at: now,
    updated_at: now,
    last_connected_at: null,
    sort_order: sanitizeInteger(row.sort_order, 0),
  };
}

function toPortableSession(session: SessionConfig, scopeFolder: string | null): PortableSession {
  return {
    name: cleanText(session.name, MAX_NAME_LENGTH),
    type: sanitizeSessionType(session.session_type, []) ?? "SSH",
    folder_path: relativeFolderPath(session.group_path, scopeFolder),
    host: cleanText(session.host, MAX_HOST_LENGTH),
    port: sanitizePort(session.port, DEFAULT_PORTS[session.session_type] ?? 0),
    username: optionalCleanText(session.username, MAX_NAME_LENGTH),
    auth: authMethodToPortable(session.auth_method),
    options: sanitizeOptions(session.options_json),
    sort_order: sanitizeInteger(session.sort_order, 0),
  };
}

function csvRowToSession(
  row: string[],
  headers: string[] | null,
  targetFolder: string | null,
  now: number,
  warnings: string[],
): SessionConfig | null {
  const get = (name: string, index: number) => {
    if (!headers) return row[index] ?? "";
    const headerIndex = headers.indexOf(name);
    return headerIndex >= 0 ? row[headerIndex] ?? "" : "";
  };

  const typeValue = get("session_type", 1) || get("type", 1) || "SSH";
  const sessionType = sanitizeSessionType(typeValue, warnings);
  if (!sessionType) return null;

  const host = cleanText(get("host", 2), MAX_HOST_LENGTH);
  if (sessionType !== "LocalShell" && sessionType !== "Serial" && !host) {
    warnings.push("Skipped a CSV row because host is empty.");
    return null;
  }

  const name = cleanText(get("name", 0), MAX_NAME_LENGTH) || host || sessionType;
  const username = optionalCleanText(get("username", 4) || get("user", 4), MAX_NAME_LENGTH);

  return {
    id: createSessionId(),
    name,
    session_type: sessionType,
    group_path: toStoredGroupPath(targetFolder),
    host,
    port: sanitizePort(get("port", 3), DEFAULT_PORTS[sessionType] ?? 0),
    username,
    auth_method: sessionType === "SSH" || sessionType === "SFTP" ? "Password" : "None",
    options_json: "{}",
    created_at: now,
    updated_at: now,
    last_connected_at: null,
    sort_order: 0,
  };
}

interface MobaSection {
  name: string;
  subRep: string | null;
  entries: Array<{ key: string; value: string }>;
}

function parseMobaIni(text: string): MobaSection[] {
  const sections: MobaSection[] = [];
  let current: MobaSection = { name: "Bookmarks", subRep: null, entries: [] };
  let hasExplicitSection = false;

  const pushCurrent = () => {
    if (hasExplicitSection || current.entries.length > 0 || current.subRep !== null) {
      sections.push(current);
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";")) continue;

    const sectionMatch = /^\[([^\]]+)]$/.exec(trimmed);
    if (sectionMatch) {
      pushCurrent();
      current = { name: sectionMatch[1], subRep: null, entries: [] };
      hasExplicitSection = true;
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1);

    if (key === "SubRep") {
      current.subRep = value;
    } else if (key !== "ImgNum") {
      current.entries.push({ key, value });
    }
  }

  pushCurrent();
  return sections.filter((section) => section.name === "Bookmarks" || /^Bookmarks_\d+$/.test(section.name));
}

function mobaEntryToSession(
  rawName: string,
  rawValue: string,
  groupPath: string | null,
  now: number,
  warnings: string[],
): SessionConfig | null {
  const value = rawValue.trimStart();
  const parts = value.split("#");
  const iconIndex = parts.findIndex((part, index) => /^\d+$/.test(part) && (parts[index + 1] ?? "").includes("%"));
  if (iconIndex < 0) {
    warnings.push(`Skipped "${rawName}" because it is not a supported MobaXterm session line.`);
    return null;
  }

  const basic = (parts[iconIndex + 1] ?? "").split("%");
  const typeCode = basic[0] ?? "";
  const sessionType = MOBAXTERM_TYPE_TO_SESSION[typeCode];
  if (!sessionType) {
    warnings.push(`Skipped "${rawName}" because MobaXterm type ${typeCode || "(empty)"} is not supported.`);
    return null;
  }

  const host = cleanText(mobaUnescape(basic[1] ?? ""), MAX_HOST_LENGTH);
  if (!host) {
    warnings.push(`Skipped "${rawName}" because host is empty.`);
    return null;
  }

  const name = cleanText(mobaUnescape(rawName), MAX_NAME_LENGTH) || host;
  const port = sanitizePort(basic[2], DEFAULT_PORTS[sessionType] ?? 0);
  const username = sessionType === "VNC" ? null : optionalCleanText(mobaUnescape(basic[3] ?? ""), MAX_NAME_LENGTH);
  const options = mobaBasicToOptions(sessionType, basic, parts[iconIndex + 4] ?? "");
  const authMethod = mobaBasicToAuth(sessionType, basic);

  return {
    id: createSessionId(),
    name,
    session_type: sessionType,
    group_path: toStoredGroupPath(groupPath),
    host,
    port,
    username,
    auth_method: authMethod,
    options_json: JSON.stringify(options),
    created_at: now,
    updated_at: now,
    last_connected_at: null,
    sort_order: 0,
  };
}

function mobaBasicToOptions(
  sessionType: string,
  basic: string[],
  rawComment: string,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const comment = cleanText(mobaUnescape(rawComment), MAX_OPTION_LENGTH).trim();
  if (comment) options.description = comment;

  if (sessionType === "SSH") {
    options.x11 = basic[5] !== "0";
    options.compression = basic[6] !== "0";
    const startupCmd = cleanText(mobaUnescape(basic[7] ?? ""), MAX_OPTION_LENGTH);
    if (startupCmd) options.startupCmd = startupCmd;
    if (basic[11] === "-1") options.doNotExit = true;
    addMobaJumpOptions(options, basic[8], basic[9], basic[10]);
  } else if (sessionType === "SFTP") {
    options.compression = basic[5] === "-1";
  } else if (sessionType === "RDP") {
    const remoteCommand = cleanText(mobaUnescape(basic[12] ?? ""), MAX_OPTION_LENGTH);
    if (remoteCommand) options.startupCmd = remoteCommand;
    addMobaJumpOptions(options, basic[13], basic[14], basic[15]);
  } else if (sessionType === "VNC") {
    addMobaJumpOptions(options, basic[5], basic[6], basic[7]);
  }

  return sanitizeOptions(options);
}

function addMobaJumpOptions(
  options: Record<string, unknown>,
  hostList: string | undefined,
  portList: string | undefined,
  userList: string | undefined,
) {
  const jumpHost = firstPipeValue(hostList);
  if (!jumpHost) return;
  options.jumpHost = jumpHost;
  options.jumpPort = firstPipeValue(portList) || "22";
  options.jumpUser = firstPipeValue(userList);
}

function firstPipeValue(value: string | undefined): string {
  return cleanText(mobaUnescape((value ?? "").split("__PIPE__")[0] ?? ""), MAX_NAME_LENGTH);
}

function mobaBasicToAuth(sessionType: string, basic: string[]): AuthMethod {
  const keyPath = sessionType === "SSH"
    ? cleanText(mobaUnescape(basic[14] ?? ""), MAX_PATH_LENGTH)
    : sessionType === "SFTP"
      ? cleanText(mobaUnescape(basic[9] ?? ""), MAX_PATH_LENGTH)
      : "";

  return keyPath ? { PrivateKey: { key_path: keyPath } } : sessionType === "SSH" || sessionType === "SFTP" ? "Password" : "None";
}

function mobaSessionLine(
  session: SessionConfig,
  usedNames: Set<string>,
  warnings: string[],
): string | null {
  const exportType = MOBAXTERM_EXPORT_TYPES[session.session_type];
  if (!exportType) {
    warnings.push(`Skipped "${session.name}" because MobaXterm export does not support ${session.session_type}.`);
    return null;
  }

  const name = uniqueMobaName(session.name || session.host || session.session_type, usedNames, warnings);
  const basic = mobaBasicGroup(session, exportType.code, warnings);
  const terminal = mobaTerminalGroup(session);
  const comment = safeMobaComment(optionString(parseSessionOptions(session.options_json).description), warnings);
  return `${name}=#${exportType.icon}#${basic.join("%")}#${terminal}#0#${comment || " "}#-1`;
}

function mobaBasicGroup(
  session: SessionConfig,
  typeCode: string,
  warnings: string[],
): string[] {
  const options = parseSessionOptions(session.options_json);
  const host = safeMobaPercentField(session.host, "host", warnings);
  const port = String(sanitizePort(session.port, DEFAULT_PORTS[session.session_type] ?? 0));
  const username = safeMobaPercentField(session.username ?? "", "username", warnings);
  const privateKey = safeMobaPercentField(privateKeyPath(session.auth_method), "private key path", warnings);
  const jumpHost = safeMobaPercentField(optionString(options.jumpHost), "jump host", warnings);
  const jumpPort = safeMobaPercentField(optionString(options.jumpPort) || "22", "jump port", warnings);
  const jumpUser = safeMobaPercentField(optionString(options.jumpUser), "jump user", warnings);

  if (typeCode === "0") {
    const fields = [
      "0",
      host,
      port,
      username,
      "",
      options.x11 === false ? "0" : "-1",
      options.compression === true ? "-1" : "0",
      safeMobaPercentField(optionString(options.startupCmd), "startup command", warnings),
      jumpHost,
      jumpHost ? jumpPort : "",
      jumpHost ? jumpUser : "",
      options.doNotExit === true ? "-1" : "0",
      username ? "0" : "-1",
      "0",
      privateKey,
      "",
      "-1",
      "0",
      "0",
      "0",
      "",
      "1080",
      "",
      "0",
      "0",
      "1",
      "",
      "0",
      "",
      "",
      "",
      "0",
      "-1",
      "-1",
      "0",
    ];
    return fields;
  }

  if (typeCode === "7") {
    return [
      "7",
      host,
      port,
      username,
      "-1",
      options.compression === true ? "-1" : "0",
      "",
      "0",
      "0",
      privateKey,
      "0",
      "",
      "1080",
      "",
      "",
      "",
      "-1",
    ];
  }

  if (typeCode === "4") {
    return [
      "4",
      host,
      port,
      username,
      "0",
      "0",
      "0",
      "0",
      "-1",
      "0",
      "0",
      "-1",
      safeMobaPercentField(optionString(options.startupCmd), "startup command", warnings),
      jumpHost,
      jumpHost ? jumpPort : "",
      jumpHost ? jumpUser : "",
      "0",
      "0",
      "",
      "-1",
      "",
      "-1",
      "-1",
      "0",
      "-1",
      "0",
      "-1",
      "0",
      "0",
      "0",
      "0",
      "",
    ];
  }

  return [
    "5",
    host,
    port,
    "-1",
    "0",
    jumpHost,
    jumpHost ? jumpPort : "",
    jumpHost ? jumpUser : "",
    "",
    "-1",
    "0",
    "0",
    "",
    "0",
    "",
    "1080",
    "",
    "",
  ];
}

function mobaTerminalGroup(session: SessionConfig): string {
  const profile = sanitizeOptions(session.options_json).terminalProfile;
  const terminalProfile = isRecord(profile) ? profile : {};
  const fontFamily = safeTerminalFont(optionString(terminalProfile.fontFamily));
  const fontSize = sanitizeInteger(terminalProfile.fontSize, 10);
  return [
    fontFamily,
    String(Math.min(32, Math.max(8, fontSize))),
    "0",
    "0",
    "-1",
    "15",
    "236,236,236",
    "30,30,30",
    "180,180,192",
    "0",
    "-1",
    "0",
    "",
    "xterm",
    "-1",
    "0",
    "_Std_Colors_0_",
    "80",
    "24",
    "0",
    "1",
    "-1",
    "<none>",
    "",
    "0",
    "0",
    "-1",
    "-1",
  ].join("%");
}

function safeTerminalFont(value: string): string {
  const primary = value.split(",")[0]?.replace(/^["']|["']$/g, "").trim();
  return primary ? primary.replace(/[^\x20-\x7E]/g, "_").slice(0, 80) : "MobaFont";
}

function privateKeyPath(authMethod: AuthMethod): string {
  return typeof authMethod === "object" && "PrivateKey" in authMethod
    ? authMethod.PrivateKey.key_path
    : "";
}

function authMethodToPortable(authMethod: AuthMethod): PortableAuth {
  if (authMethod === "Password") return { kind: "password" };
  if (authMethod === "Agent") return { kind: "agent" };
  if (authMethod === "None") return { kind: "none" };
  return {
    kind: "private-key",
    private_key_path: cleanText(authMethod.PrivateKey.key_path, MAX_PATH_LENGTH),
  };
}

function portableAuthToAuthMethod(value: unknown): AuthMethod {
  if (!isRecord(value)) return "Password";
  if (value.kind === "private-key") {
    const keyPath = cleanText(firstString(value.private_key_path), MAX_PATH_LENGTH);
    return keyPath ? { PrivateKey: { key_path: keyPath } } : "Password";
  }
  if (value.kind === "agent") return "Agent";
  if (value.kind === "none") return "None";
  return "Password";
}

function sanitizeAuthMethod(value: unknown): AuthMethod {
  if (value === "Password" || value === "Agent" || value === "None") return value;
  if (isRecord(value) && isRecord(value.PrivateKey)) {
    const keyPath = cleanText(firstString(value.PrivateKey.key_path), MAX_PATH_LENGTH);
    return keyPath ? { PrivateKey: { key_path: keyPath } } : "Password";
  }
  return "Password";
}

function sanitizeOptions(input: unknown): Record<string, unknown> {
  const source = typeof input === "string" ? parseOptionsString(input) : input;
  if (!isRecord(source)) return {};

  const output: Record<string, unknown> = {};
  copyBoolean(source, output, "x11");
  copyBoolean(source, output, "compression");
  copyBoolean(source, output, "doNotExit");
  copyString(source, output, "startupCmd", MAX_OPTION_LENGTH);
  copyString(source, output, "jumpHost", MAX_HOST_LENGTH);
  copyString(source, output, "jumpUser", MAX_NAME_LENGTH);
  copyString(source, output, "jumpPort", 16);
  copyString(source, output, "description", MAX_OPTION_LENGTH);
  copyString(source, output, "tags", MAX_OPTION_LENGTH);

  if ("terminalProfile" in source) {
    const profile = normalizeTerminalProfile(source.terminalProfile);
    delete profile.logPath;
    output.terminalProfile = profile;
  }

  return output;
}

function parseOptionsString(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function copyBoolean(source: Record<string, unknown>, output: Record<string, unknown>, key: string) {
  if (typeof source[key] === "boolean") output[key] = source[key];
}

function copyString(
  source: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
  maxLength: number,
) {
  const value = cleanText(firstString(source[key]), maxLength);
  if (value) output[key] = value;
}

function sanitizeSessionType(value: unknown, warnings: string[]): string | null {
  const type = cleanText(firstString(value) || "SSH", 32);
  if (Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, type)) return type;
  warnings.push(`Skipped a session because type "${type || "(empty)"}" is not supported.`);
  return null;
}

function sanitizePort(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(65535, Math.max(0, Math.round(parsed)));
}

function sanitizeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function cleanText(value: unknown, maxLength: number): string {
  return firstString(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function optionalCleanText(value: unknown, maxLength: number): string | null {
  const cleaned = cleanText(value, maxLength);
  return cleaned || null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstKnown(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      i += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function combineImportFolder(targetFolder: string | null, importedFolder: string | null): string | null {
  const target = normalizeGroupPath(targetFolder);
  const imported = normalizeGroupPath(importedFolder);
  if (target && imported) return `${target} / ${imported}`;
  return target ?? imported;
}

function relativeFolderPath(groupPath: string | null | undefined, scopeFolder: string | null): string | null {
  const group = normalizeGroupPath(groupPath);
  const scope = normalizeGroupPath(scopeFolder);
  if (!group) return null;
  if (!scope) return group;
  if (group === scope) return null;
  if (groupPathContains(scope, group)) return group.slice(scope.length + 3);
  return group;
}

function finalizeImportResult(
  sessions: SessionConfig[],
  skipped: number,
  warnings: string[],
  existingSessions: readonly SessionConfig[] | undefined,
): SessionImportResult {
  return {
    sessions: makeUniqueImportedSessions(sessions, existingSessions ?? []),
    warnings: uniqueWarnings(warnings),
    skipped,
  };
}

function makeUniqueImportedSessions(
  sessions: readonly SessionConfig[],
  existingSessions: readonly SessionConfig[],
): SessionConfig[] {
  const used = new Set<string>();
  for (const session of existingSessions) {
    used.add(nameKey(session.group_path, session.name));
  }

  return sessions.map((session) => {
    let name = session.name;
    let index = 2;
    while (used.has(nameKey(session.group_path, name))) {
      name = `${session.name} (${index})`;
      index += 1;
    }
    used.add(nameKey(session.group_path, name));
    return name === session.name ? session : { ...session, name };
  });
}

function nameKey(groupPath: string | null | undefined, name: string): string {
  return `${normalizeGroupPath(groupPath) ?? ""}\u0000${name.trim().toLowerCase()}`;
}

function uniqueWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings)];
}

function limitRows(rows: unknown[], warnings: string[]): { rows: unknown[]; skipped: number } {
  if (rows.length <= MAX_SESSIONS) return { rows, skipped: 0 };
  warnings.push(`Only the first ${MAX_SESSIONS} sessions were imported.`);
  return { rows: rows.slice(0, MAX_SESSIONS), skipped: rows.length - MAX_SESSIONS };
}

function assertImportSize(text: string) {
  if (text.length > MAX_IMPORT_CHARS) {
    throw new Error("The selected file is too large to import safely.");
  }
}

function resolveNow(value: number | undefined): number {
  return value ?? Math.floor(Date.now() / 1000);
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackIdCounter += 1;
  return `import-${Date.now()}-${fallbackIdCounter}`;
}

function toUint8Array(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function decodeMobaXtermText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder("utf-8").decode(bytes.slice(3));
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const language = typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
    if (language.startsWith("zh")) {
      try {
        return new TextDecoder("gbk").decode(bytes);
      } catch {
        return new TextDecoder("windows-1252").decode(bytes);
      }
    }
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function mobaUnescape(value: string): string {
  return value
    .replace(/__PTVIRG__/g, ";")
    .replace(/__DBLQUO__/g, "\"")
    .replace(/__PIPE__/g, "|")
    .replace(/__DIEZE__/g, "#")
    .replace(/__PERCENT__/g, "%");
}

function mobaRootFolder(scopeFolder: string | null): string {
  const scope = normalizeGroupPath(scopeFolder);
  return scope ? leafGroupName(scope) : "";
}

function mobaFolderForSession(session: SessionConfig, scopeFolder: string | null): string {
  const scope = normalizeGroupPath(scopeFolder);
  const relative = relativeFolderPath(session.group_path, scopeFolder);
  if (!scope) return pathToMobaFolder(relative);
  const root = leafGroupName(scope);
  return relative ? pathToMobaFolder(`${root} / ${relative}`) : root;
}

function pathToMobaFolder(path: string | null): string {
  return normalizeGroupPath(path)?.replace(/\s*\/\s*/g, "\\") ?? "";
}

function ensureMobaSection(sectionMap: Map<string, SessionConfig[]>, folder: string) {
  const parts = folder.split("\\").filter(Boolean);
  if (parts.length === 0) {
    if (!sectionMap.has("")) sectionMap.set("", []);
    return;
  }
  for (let i = 1; i <= parts.length; i += 1) {
    const path = parts.slice(0, i).join("\\");
    if (!sectionMap.has(path)) sectionMap.set(path, []);
  }
}

function safeMobaPercentField(value: string, label: string, warnings: string[]): string {
  return safeMobaAscii(value, label, warnings)
    .replace(/%/g, "__PERCENT__")
    .replace(/;/g, "__PTVIRG__")
    .replace(/"/g, "__DBLQUO__")
    .replace(/\|/g, "__PIPE__")
    .replace(/#/g, "__DIEZE__")
    .replace(/\r?\n/g, " ");
}

function safeMobaComment(value: string, warnings: string[]): string {
  return safeMobaAscii(value, "comment", warnings)
    .replace(/#/g, "__DIEZE__")
    .replace(/%/g, " ")
    .replace(/\r?\n/g, " ");
}

function safeMobaIniValue(value: string, label: string, warnings: string[]): string {
  return safeMobaAscii(value, label, warnings)
    .replace(/[\r\n=[\]]/g, " ")
    .trim();
}

function uniqueMobaName(value: string, usedNames: Set<string>, warnings: string[]): string {
  const base = safeMobaIniValue(value, "session name", warnings) || "Session";
  let name = base;
  let index = 2;
  while (usedNames.has(name.toLowerCase())) {
    name = `${base} (${index})`;
    index += 1;
  }
  usedNames.add(name.toLowerCase());
  return name;
}

function safeMobaAscii(value: string, label: string, warnings: string[]): string {
  const cleaned = cleanText(value, MAX_OPTION_LENGTH);
  const safe = cleaned.replace(/[^\x20-\x7E]/g, "_");
  if (safe !== cleaned) {
    warnings.push(`Some ${label} characters are not supported by MobaXterm export and were replaced.`);
  }
  return safe;
}

function optionString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function slugify(value: string): string {
  return value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-") || "user-sessions";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
