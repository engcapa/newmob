/**
 * SocksCap start-time pre-flight helpers.
 *
 * Before starting capture we (1) reject profiles whose upstream is not
 * configured at all (empty host/secret — nothing to dial), and (2) probe the
 * upstreams that *are* configured so a dead upstream is caught before we
 * rewire the OS's traffic. Both checks run against the *active* profiles only,
 * since those are the ones the backend snapshots and dials at Start.
 *
 * The functions here are pure (no IPC) so they can be unit-tested; the panel
 * performs the actual probe IPC and renders the force/cancel prompt.
 */
import {
  upstreamRequiresCore,
  type SocksCapConfig,
  type SocksCapProfile,
  type UpstreamKind,
  type UpstreamRef,
} from "./sockscap";

/** i18n key (under `sockscap.`) describing why an upstream is unconfigured. */
export type UpstreamIssueKey =
  | "issueHostEmpty"
  | "issuePortInvalid"
  | "issueShareLinkMissing"
  | "issueUuidMissing"
  | "issueWgKeyMissing"
  | "issueWgPeerMissing";

export interface UpstreamConfigIssue {
  profileId: string;
  profileName: string;
  reasonKey: UpstreamIssueKey;
}

/** Kinds that carry their secret/identity in the vault (not host/port alone). */
function coreSecretIssue(u: UpstreamRef): UpstreamIssueKey | null {
  switch (u.kind) {
    case "shadowsocks":
    case "trojan":
      // SS/Trojan password lives in passwordRef (vault:<id>). No ref → the
      // node was never imported / the secret was cleared.
      return u.passwordRef && u.passwordRef.trim() ? null : "issueShareLinkMissing";
    case "vmess":
    case "vless":
      return u.params?.uuidRef && u.params.uuidRef.trim() ? null : "issueUuidMissing";
    case "wireguard":
      if (!u.params?.privateKeyRef || !u.params.privateKeyRef.trim()) {
        return "issueWgKeyMissing";
      }
      if (!u.params?.peerPublicKey || !u.params.peerPublicKey.trim()) {
        return "issueWgPeerMissing";
      }
      return null;
    default:
      return null;
  }
}

/**
 * Return the first reason an upstream is not usable, or `null` if it looks
 * configured. A saved-session upstream is always considered configured (the
 * session supplies host/port/credentials at dial time).
 */
export function upstreamConfigIssue(u: UpstreamRef): UpstreamIssueKey | null {
  const isCore = upstreamRequiresCore(u.kind);
  const sessionBacked = !isCore && !!u.sessionId && u.sessionId.trim().length > 0;
  if (sessionBacked) return null;

  if (!u.host || !u.host.trim()) return "issueHostEmpty";
  if (!u.port || u.port <= 0 || u.port > 65535) return "issuePortInvalid";

  if (isCore) {
    return coreSecretIssue(u);
  }
  return null;
}

/** Active profiles (enabled + in activeProfileIds), matching backend order. */
export function activeProfiles(cfg: SocksCapConfig): SocksCapProfile[] {
  return cfg.profiles
    .filter((p) => p.enabled && cfg.activeProfileIds.includes(p.id))
    .sort((a, b) => a.priority - b.priority);
}

/** Every active profile whose upstream is not configured, with the reason. */
export function collectUpstreamConfigIssues(
  cfg: SocksCapConfig,
): UpstreamConfigIssue[] {
  const issues: UpstreamConfigIssue[] = [];
  for (const p of activeProfiles(cfg)) {
    const reasonKey = upstreamConfigIssue(p.upstream);
    if (reasonKey) {
      issues.push({ profileId: p.id, profileName: p.name, reasonKey });
    }
  }
  return issues;
}

/** A distinct (kind + endpoint) upstream to probe, tagged with its profile. */
export interface ProbeTarget {
  profileId: string;
  profileName: string;
  kind: UpstreamKind;
  upstream: UpstreamRef;
}

/**
 * Upstreams to probe before start: one per active profile that passed the
 * emptiness check. De-duplicated by (kind|sessionId|host|port|passwordRef|
 * uuidRef) so N profiles sharing one upstream are dialed once.
 */
export function collectProbeTargets(cfg: SocksCapConfig): ProbeTarget[] {
  const seen = new Set<string>();
  const targets: ProbeTarget[] = [];
  for (const p of activeProfiles(cfg)) {
    const u = p.upstream;
    if (upstreamConfigIssue(u)) continue; // unconfigured → handled separately
    const dedupe = [
      u.kind,
      u.sessionId || "",
      u.host || "",
      String(u.port || 0),
      u.passwordRef || "",
      u.params?.uuidRef || "",
    ].join("|");
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    targets.push({
      profileId: p.id,
      profileName: p.name,
      kind: u.kind,
      upstream: u,
    });
  }
  return targets;
}
