/**
 * SocksCap IPC surface.
 *
 * Capture backends differ per platform, so read `sockscapCapabilities()` before
 * offering options: Windows uses the elevated WinDivert helper, Linux uses
 * nftables + cgroup v2 transparent redirect, and macOS bridges the separately
 * installed, signed Mitmproxy Redirector over isolated Unix IPC (Global and
 * validated Application scopes).
 * There is no macOS system-proxy fallback.
 */
import { invoke } from "@tauri-apps/api/core";

export type ScopeMode = "global" | "apps";
export type RuleMode = "gfwList" | "proxyAll" | "off";
export type Decision = "direct" | "proxy" | "block";
export type UpstreamKind =
  | "http"
  | "socks5"
  | "ssh"
  | "shadowsocks"
  | "trojan"
  | "vmess"
  | "vless"
  | "wireguard";

/** Upstream kinds served by the bundled xray-core sidecar (not native dialers). */
export const CORE_UPSTREAM_KINDS: UpstreamKind[] = [
  "shadowsocks",
  "trojan",
  "vmess",
  "vless",
  "wireguard",
];

export function upstreamRequiresCore(kind: UpstreamKind): boolean {
  return CORE_UPSTREAM_KINDS.includes(kind);
}
export type EnginePhase =
  | "idle"
  | "preparing"
  | "active"
  | "degraded"
  | "stopping"
  | "recoveryRequired";

export interface AppSelector {
  path: string;
  bundleId?: string;
  name?: string;
  macosIdentity?: MacosAppIdentity | null;
}

export interface MacosAppIdentity {
  bundlePath: string;
  canonicalBundlePath: string;
  mainExecutablePath: string;
  bundleId: string;
  teamId: string;
  signingId: string;
  designatedRequirement: string;
  lastValidatedCdHash: string;
  supplementalExecutables: string[];
  allowUnsigned: boolean;
}

export interface SocksCapProfile {
  id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  enabled: boolean;
  priority: number;
  mode: ScopeMode;
  apps: AppSelector[];
  upstream: UpstreamRef;
  ruleMode: RuleMode;
  userRules: UserRule[];
  defaultAction: Decision;
}

/** Protocol-specific upstream parameters (only meaningful for core kinds). */
export interface UpstreamParams {
  // Shadowsocks
  method?: string;
  // VMess / VLESS
  uuidRef?: string;
  security?: string;
  flow?: string;
  encryption?: string;
  // Transport (trojan/vmess/vless)
  network?: string;
  path?: string;
  wsHost?: string;
  // TLS / REALITY
  tls?: string;
  sni?: string;
  alpn?: string[];
  fingerprint?: string;
  allowInsecure?: boolean;
  realityPublicKey?: string;
  realityShortId?: string;
  // WireGuard
  privateKeyRef?: string;
  peerPublicKey?: string;
  preSharedKeyRef?: string;
  localAddress?: string[];
  mtu?: number;
}

export interface UpstreamRef {
  kind: UpstreamKind;
  sessionId?: string;
  host?: string;
  port?: number;
  username?: string;
  passwordRef?: string;
  params?: UpstreamParams;
}

/** A share link decoded by the backend; secret/uuid are plaintext (vault them). */
export interface ParsedShareLink {
  kindTag: string;
  name: string;
  host: string;
  port: number;
  params: UpstreamParams;
  secret: string;
  uuid: string;
}

export interface UserRule {
  pattern: string;
  action: "direct" | "proxy" | "block";
  comment?: string;
}

export interface GfwListSource {
  enabled: boolean;
  url: string;
  autoRefreshHours: number;
}

export interface SocksCapConfig {
  enabled: boolean;
  activeProfileIds: string[];
  selectedProfileId: string;
  profiles: SocksCapProfile[];
  mode: ScopeMode;
  apps: AppSelector[];
  upstream: UpstreamRef;
  ruleMode: RuleMode;
  gfwlist: GfwListSource;
  userRules: UserRule[];
  bypassCidrs: string[];
  defaultAction: Decision;
  restoreOnLogin: boolean;
  /** Drop in-scope outbound UDP 443 so QUIC/HTTP3 falls back to TCP, which
   *  capture can attribute (SNI) and route through the upstream. Without it QUIC
   *  bypasses capture and leaks the real IP. Session-level; default on. */
  blockQuic: boolean;
}

export interface SocksCapCapabilities {
  platform: string;
  globalTcp: boolean;
  appFilter: boolean;
  captureBackend: string;
  notes: string[];
  privilegedRequired: boolean;
}

export interface RedirectorInstallStatus {
  state:
    | "ready"
    | "missing"
    | "upgradeAvailable"
    | "pendingSystemApproval"
    | "conflict"
    | "resourceMissing";
  packageVersion: string;
  resourceAvailable: boolean;
  message: string;
}

export interface SocksCapStatus {
  phase: EnginePhase;
  message: string;
  ruleCount: number;
  captureBackend: string;
}

export interface SocksCapDiagnostics {
  generatedAt: number;
  status: SocksCapStatus;
  capabilities: SocksCapCapabilities;
  stats: StatsSnapshot;
  recoveryJournal: Record<string, unknown> | null;
  redirector: Record<string, unknown> | null;
  manualRecoverySteps: string[];
}

export interface GfwListStatus {
  loaded: boolean;
  ruleCount: number;
  skipped: number;
  lastRefresh: string | null;
  source: string;
  error: string | null;
}

export interface TargetTestResult {
  host: string;
  port: number;
  decision: Decision;
  reason: string;
  matchedRule: string | null;
}

export interface StatsSnapshot {
  flowsTotal: number;
  flowsProxy: number;
  flowsDirect: number;
  flowsBlock: number;
  bytesUp: number;
  bytesDown: number;
  lastFlowAt?: number | null;
  quicFlowsDropped?: number;
  udpDirectDatagrams?: number;
  lastQuicDropAt?: number | null;
  scopeMismatchFlows?: number;
  lastScopeMismatchAt?: number | null;
  flowFailures?: number;
  dnsAnswersLearned?: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  path: string;
}

export function sockscapCapabilities(): Promise<SocksCapCapabilities> {
  return invoke("sockscap_capabilities");
}

export function sockscapRedirectorInstallStatus(): Promise<RedirectorInstallStatus> {
  return invoke("sockscap_redirector_install_status");
}

export function sockscapInstallRedirector(): Promise<RedirectorInstallStatus> {
  return invoke("sockscap_install_redirector");
}

export function sockscapGetConfig(): Promise<SocksCapConfig> {
  return invoke("sockscap_get_config");
}

export function sockscapValidateMacosApp(
  path: string,
  allowUnsigned = false,
): Promise<AppSelector> {
  return invoke("sockscap_validate_macos_app", { path, allowUnsigned });
}

export function sockscapSetConfig(config: SocksCapConfig): Promise<void> {
  return invoke("sockscap_set_config", { config });
}

export function sockscapGfwlistStatus(): Promise<GfwListStatus> {
  return invoke("sockscap_gfwlist_status");
}

export function sockscapRefreshGfwlist(url?: string): Promise<GfwListStatus> {
  return invoke("sockscap_refresh_gfwlist", { url: url ?? null });
}

export function sockscapImportRules(path: string): Promise<GfwListStatus> {
  return invoke("sockscap_import_rules", { path });
}

export function sockscapTestTarget(
  host: string,
  port?: number,
): Promise<TargetTestResult> {
  return invoke("sockscap_test_target", { host, port: port ?? null });
}

export function sockscapStatus(): Promise<SocksCapStatus> {
  return invoke("sockscap_status");
}

export function sockscapDiagnostics(): Promise<SocksCapDiagnostics> {
  return invoke("sockscap_diagnostics");
}

export function sockscapStart(sudoPassword?: string): Promise<SocksCapStatus> {
  return invoke("sockscap_start", { sudoPassword });
}

export function sockscapStop(): Promise<SocksCapStatus> {
  return invoke("sockscap_stop");
}

export function sockscapRecover(sudoPassword?: string): Promise<void> {
  return invoke("sockscap_recover", { sudoPassword });
}

export function sockscapStatsSnapshot(): Promise<StatsSnapshot> {
  return invoke("sockscap_stats_snapshot");
}

export function sockscapListProcesses(): Promise<ProcessInfo[]> {
  return invoke("sockscap_list_processes");
}

export function sockscapTestUpstream(args: {
  kind: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  sessionId?: string;
  testHost?: string;
  testPort?: number;
}): Promise<string> {
  return invoke("sockscap_test_upstream", {
    kind: args.kind,
    host: args.host,
    port: args.port,
    username: args.username ?? null,
    password: args.password ?? null,
    sessionId: args.sessionId ?? null,
    testHost: args.testHost ?? null,
    testPort: args.testPort ?? null,
  });
}

export interface LocalProxyCandidate {
  kind: "socks5" | "http";
  host: string;
  port: number;
  /** Listening process name (best-effort; empty if not resolvable). */
  process: string;
  /** Owning pid of the listener (0 if unknown). */
  pid: number;
  /** Normalized client family id ("clash" | "mihomo" | "sing-box" | … | "unknown"). */
  client: string;
  /** Friendly client name for display ("Clash Verge", "sing-box", …); empty for "unknown". */
  clientLabel: string;
}

export function sockscapDetectLocalProxies(): Promise<LocalProxyCandidate[]> {
  return invoke("sockscap_detect_local_proxies");
}

/** Suspected proxy/VPN TUN adapter names; non-empty means a global-capture
 *  conflict with an L3 TUN client is likely. */
export function sockscapDetectTunConflicts(): Promise<string[]> {
  return invoke("sockscap_detect_tun_conflicts");
}

export function sockscapParseShareLink(link: string): Promise<ParsedShareLink> {
  return invoke("sockscap_parse_share_link", { link });
}

export function sockscapParseSubscription(
  blob: string,
): Promise<ParsedShareLink[]> {
  return invoke("sockscap_parse_subscription", { blob });
}

/** Fetch (URL) or parse (pasted blob) a subscription into upstream nodes. */
export function sockscapImportSubscription(
  input: string,
): Promise<ParsedShareLink[]> {
  return invoke("sockscap_import_subscription", { input });
}

export function sockscapTestCoreUpstream(args: {
  upstream: UpstreamRef;
  testHost?: string;
  testPort?: number;
}): Promise<string> {
  return invoke("sockscap_test_core_upstream", {
    upstream: args.upstream,
    testHost: args.testHost ?? null,
    testPort: args.testPort ?? null,
  });
}

export interface HelperStatus {
  running: boolean;
  elevated: boolean;
  endpoint: string | null;
  message: string;
  windivert: unknown | null;
  pid: number | null;
}

export function sockscapHelperStart(): Promise<HelperStatus> {
  return invoke("sockscap_helper_start");
}

export function sockscapHelperStop(): Promise<void> {
  return invoke("sockscap_helper_stop");
}

export function sockscapHelperStatus(): Promise<HelperStatus> {
  return invoke("sockscap_helper_status");
}

export function sockscapHelperProbeWindivert(filter?: string): Promise<unknown> {
  return invoke("sockscap_helper_probe_windivert", { filter: filter ?? null });
}

export interface DomainRecord {
  key: string;
  domainOrIp: string;
  decision: Decision;
  matchedRule: string | null;
  profileName?: string | null;
  processName: string | null;
  pid: number | null;
  hitCount: number;
  bytesUp: number;
  bytesDown: number;
  lastSeenUnix: number;
}

export function sockscapGetDomainRecords(): Promise<DomainRecord[]> {
  return invoke("sockscap_get_domain_records");
}

export function sockscapClearDomainRecords(): Promise<void> {
  return invoke("sockscap_clear_domain_records");
}
