/**
 * Compare the capture-topology portion of two SocksCap configs.
 *
 * Running sessions are immutable: backend commands reject every config/rule
 * mutation until capture stops. This pure helper remains useful to callers
 * comparing two idle snapshots, but the UI no longer offers live edits or an
 * automatic restart path.
 */
import type { SocksCapConfig, SocksCapProfile, UpstreamRef } from "./sockscap";

/** Fields of an upstream that determine which connection is dialed. */
function upstreamKey(u: UpstreamRef | undefined): string {
  if (!u) return "";
  return [
    u.kind,
    u.sessionId ?? "",
    u.host ?? "",
    String(u.port ?? 0),
    u.username ?? "",
    u.passwordRef ?? "",
  ].join("|");
}

/** Normalized signature of the capture-affecting parts of one profile. */
function profileScopeKey(p: SocksCapProfile): string {
  const apps = [...p.apps]
    .map((a) => (a.path || "").replace(/\//g, "\\").toLowerCase())
    .filter((s) => s.length > 0)
    .sort()
    .join(",");
  return [p.id, p.mode, apps, upstreamKey(p.upstream)].join("::");
}

/**
 * Signature of everything a running capture would need restarted to apply:
 * the set of active profiles (by id, order-independent) and, for each, its
 * scope mode, app list, and upstream. Routing-policy fields are outside this
 * topology-only signature.
 */
export function captureScopeSignature(cfg: SocksCapConfig): string {
  const activeIds = new Set(
    (cfg.activeProfileIds ?? []).map((s) => s),
  );
  const active = (cfg.profiles ?? [])
    .filter((p) => p.enabled && activeIds.has(p.id))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return active.map(profileScopeKey).join(";;");
}

/**
 * True when moving from `prev` to `next` changes capture topology.
 */
export function requiresRestart(
  prev: SocksCapConfig,
  next: SocksCapConfig,
): boolean {
  return captureScopeSignature(prev) !== captureScopeSignature(next);
}
