/**
 * SocksCap IPC surface.
 *
 * Capture backends differ per platform, so read `sockscapCapabilities()` before
 * offering options: Windows uses the elevated WinDivert helper, Linux uses
 * nftables + cgroup v2 transparent redirect, and macOS points the system SOCKS
 * proxy at a loopback listener (not transparent, Global scope only). Platforms
 * without a backend land in a degraded state on start().
 */
import { invoke } from "@tauri-apps/api/core";

export type ScopeMode = "global" | "apps";
export type RuleMode = "gfwList" | "proxyAll" | "off";
export type Decision = "direct" | "proxy" | "block";
export type UpstreamKind = "http" | "socks5" | "ssh";
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

export interface UpstreamRef {
  kind: UpstreamKind;
  sessionId?: string;
  host?: string;
  port?: number;
  username?: string;
  passwordRef?: string;
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
}

export interface SocksCapCapabilities {
  platform: string;
  globalTcp: boolean;
  appFilter: boolean;
  captureBackend: string;
  notes: string[];
  privilegedRequired: boolean;
}

export interface SocksCapStatus {
  phase: EnginePhase;
  message: string;
  ruleCount: number;
  captureBackend: string;
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
}

export interface ProcessInfo {
  pid: number;
  name: string;
  path: string;
}

export function sockscapCapabilities(): Promise<SocksCapCapabilities> {
  return invoke("sockscap_capabilities");
}

export function sockscapGetConfig(): Promise<SocksCapConfig> {
  return invoke("sockscap_get_config");
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

export function sockscapStart(sudoPassword?: string): Promise<SocksCapStatus> {
  return invoke("sockscap_start", { sudoPassword });
}

export function sockscapStop(): Promise<SocksCapStatus> {
  return invoke("sockscap_stop");
}

export function sockscapRecover(): Promise<void> {
  return invoke("sockscap_recover");
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
  testHost?: string;
  testPort?: number;
}): Promise<string> {
  return invoke("sockscap_test_upstream", {
    kind: args.kind,
    host: args.host,
    port: args.port,
    username: args.username ?? null,
    password: args.password ?? null,
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
