/**
 * Detect whether a SocksCap config change requires the running capture to be
 * restarted (Stop + Start) rather than being picked up live.
 *
 * Backend behaviour (see src-tauri/src/sockscap):
 * - `sockscap_set_config` hot-reloads ONLY the relay policy surface into the
 *   running RelayContext: `rule_mode`, `user_rules`, `default_action`,
 *   `bypass_cidrs`, and the GFWList ruleset. Those take effect immediately.
 * - The resolved upstream connections (host/port/kind/credentials/SSH pool) and
 *   — on Windows — the elevated helper's WinDivert capture plan (`mode`,
 *   `app_paths`, the active-profile set) are captured at Start and are NOT
 *   re-pushed by `set_config`. Changing any of them while Active silently has
 *   no effect until the next Start.
 *
 * This module computes, from two configs, whether the "scope + upstream"
 * surface changed so the UI can prompt for a restart. It is intentionally a
 * pure function so it can be unit-tested without the Tauri backend.
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
 * scope mode, app list, and upstream. Hot-reloadable rule fields are excluded.
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
 * True when moving from `prev` to `next` changes the capture scope/upstream in
 * a way the running backend will not pick up live (needs Stop + Start).
 */
export function requiresRestart(
  prev: SocksCapConfig,
  next: SocksCapConfig,
): boolean {
  return captureScopeSignature(prev) !== captureScopeSignature(next);
}
