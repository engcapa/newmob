import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowDownLeft,
  ArrowUp,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  HelpCircle,
  Info,
  Layers,
  Loader2,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  sockscapCapabilities,
  sockscapGetConfig,
  sockscapValidateMacosApp,
  sockscapGfwlistStatus,
  sockscapImportRules,
  sockscapListProcesses,
  sockscapRefreshGfwlist,
  sockscapRecover,
  sockscapSetConfig,
  sockscapStart,
  sockscapStatsSnapshot,
  sockscapStatus,
  sockscapStop,
  sockscapGetDomainRecords,
  sockscapClearDomainRecords,
  sockscapHelperStatus,
  sockscapTestTarget,
  sockscapTestUpstream,
  sockscapTestCoreUpstream,
  sockscapParseShareLink,
  sockscapDetectLocalProxies,
  sockscapDetectTunConflicts,
  sockscapDiagnostics,
  sockscapImportSubscription,
  sockscapInstallRedirector,
  sockscapRedirectorInstallStatus,
  upstreamRequiresCore,
  type AppSelector,
  type LocalProxyCandidate,
  type Decision,
  type DomainRecord,
  type GfwListStatus,
  type HelperStatus,
  type ProcessInfo,
  type RedirectorInstallStatus,
  type RuleMode,
  type ScopeMode,
  type SocksCapCapabilities,
  type SocksCapConfig,
  type SocksCapProfile,
  type SocksCapStatus,
  type StatsSnapshot,
  type TargetTestResult,
  type UpstreamKind,
  type UpstreamParams,
  type UserRule,
} from "../../lib/sockscap";
import { requiresRestart } from "../../lib/sockscapRestart";
import {
  collectProbeTargets,
  collectUpstreamConfigIssues,
  type ProbeTarget,
  type UpstreamConfigIssue,
} from "../../lib/sockscapPreflight";
import { SocksCapRootPrompt } from "./SocksCapRootPrompt";
import {
  UpstreamSourcePicker,
  type UpstreamChoice,
} from "./UpstreamSourcePicker";
import {
  listSessions,
  vaultPut,
  vaultStatus,
  VAULT_LOCKED_EVENT,
} from "../../lib/ipc";
import { useT } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import { writeText } from "../../lib/clipboard";
import { open } from "@tauri-apps/plugin-dialog";

interface Props {
  onStatusMessage?: (msg: string) => void;
  onClose?: () => void;
}

const DEFAULT_PROFILE: SocksCapProfile = {
  id: "default",
  name: "Default Profile",
  icon: "🎮",
  color: null,
  enabled: true,
  priority: 0,
  mode: "global",
  apps: [],
  upstream: {
    kind: "socks5",
    sessionId: "",
    host: "127.0.0.1",
    port: 1080,
    username: "",
    passwordRef: "",
  },
  ruleMode: "gfwList",
  userRules: [],
  defaultAction: "direct",
};

const DEFAULT_CFG: SocksCapConfig = {
  enabled: false,
  activeProfileIds: ["default"],
  selectedProfileId: "default",
  profiles: [DEFAULT_PROFILE],
  mode: "global",
  apps: [],
  upstream: DEFAULT_PROFILE.upstream,
  ruleMode: "gfwList",
  gfwlist: {
    enabled: true,
    url: "https://cdn.jsdelivr.net/gh/gfwlist/gfwlist/gfwlist.txt",
    autoRefreshHours: 24,
  },
  userRules: [],
  bypassCidrs: [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
  ],
  defaultAction: "direct",
  restoreOnLogin: false,
  blockQuic: true,
};

const MIN_PROFILE_PRIORITY = -2_147_483_648;
const MAX_PROFILE_PRIORITY = 2_147_483_647;

type IndexedProfile = {
  profile: SocksCapProfile;
  index: number;
};

/** Match the backend's ascending, stable priority order for presentation. */
function profilesByPriority(profiles: SocksCapProfile[]): IndexedProfile[] {
  return profiles
    .map((profile, index) => ({ profile, index }))
    .sort((a, b) => a.profile.priority - b.profile.priority || a.index - b.index);
}

type SessionOpt = { id: string; name: string; host: string; port: number; kind: "proxy" | "ssh"; groupPath?: string | null };

function phaseTone(phase: string): string {
  switch (phase) {
    case "active":
      return "text-emerald-500";
    case "degraded":
      return "text-amber-500";
    case "preparing":
    case "stopping":
      return "text-sky-500";
    case "recoveryRequired":
      return "text-red-500";
    default:
      return "text-[var(--taomni-text-muted)]";
  }
}

/** Platforms whose capture backend asks for an elevation password up front. */
function needsElevationPassword(platform: string | undefined): boolean {
  return platform === "linux";
}

function isRootRequiredError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("cap_net_admin") ||
    lower.includes("linux capture requires") ||
    lower.includes("linux capture needs root") ||
    lower.includes("linux cgroup cleanup requires") ||
    lower.includes("permission to manage cgroup v2")
  );
}

function isSudoAuthenticationError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("incorrect password") ||
    lower.includes("authentication failure") ||
    lower.includes("sudo authentication failed") ||
    lower.includes("sorry, try again") ||
    lower.includes("a password is required")
  );
}

function normalizeFrontendConfig(raw: SocksCapConfig): SocksCapConfig {
  const defaultProf: SocksCapProfile = {
    id: "default",
    name: "Default Profile",
    icon: "🎮",
    color: null,
    enabled: true,
    priority: 0,
    mode: raw.mode || "global",
    apps: raw.apps || [],
    upstream: raw.upstream || { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080 },
    ruleMode: raw.ruleMode || "gfwList",
    userRules: raw.userRules || [],
    defaultAction: raw.defaultAction || "direct",
  };
  const profiles = raw.profiles && raw.profiles.length > 0 ? raw.profiles : [defaultProf];
  const activeProfileIds =
    raw.activeProfileIds && raw.activeProfileIds.length > 0
      ? raw.activeProfileIds
      : [profiles[0].id];
  const selectedProfileId =
    raw.selectedProfileId && profiles.some((p) => p.id === raw.selectedProfileId)
      ? raw.selectedProfileId
      : profiles[0].id;
  const selectedProf = profiles.find((p) => p.id === selectedProfileId) || profiles[0];

  return {
    ...raw,
    profiles,
    activeProfileIds,
    selectedProfileId,
    mode: selectedProf.mode,
    apps: selectedProf.apps,
    upstream: selectedProf.upstream,
    ruleMode: selectedProf.ruleMode,
    userRules: selectedProf.userRules,
    defaultAction: selectedProf.defaultAction,
  };
}

export function SocksCapPanel({ onStatusMessage, onClose }: Props) {
  const t = useT();
  const [cfg, setCfg] = useState<SocksCapConfig | null>(null);
  const [caps, setCaps] = useState<SocksCapCapabilities | null>(null);
  const [status, setStatus] = useState<SocksCapStatus | null>(null);
  const [gfw, setGfw] = useState<GfwListStatus | null>(null);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [helper, setHelper] = useState<HelperStatus | null>(null);
  const [redirectorInstall, setRedirectorInstall] = useState<RedirectorInstallStatus | null>(null);
  const [sessions, setSessions] = useState<SessionOpt[]>([]);
  const [detectedProxies, setDetectedProxies] = useState<LocalProxyCandidate[]>([]);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testHost, setTestHost] = useState("www.google.com");
  const [testResult, setTestResult] = useState<TargetTestResult | null>(null);
  // Dedicated flag for in-flight tests so the test buttons lock (with a spinner)
  // independently of the global `busy` and the background status poll.
  const [testing, setTesting] = useState(false);
  // Full text of the last test, shown in a copyable modal (the status bar only
  // gets a short summary — long upstream diagnostics get truncated there).
  const [testDetail, setTestDetail] = useState<{ title: string; body: string } | null>(null);
  const [testCopied, setTestCopied] = useState(false);
  const [newRule, setNewRule] = useState<UserRule>({
    pattern: "",
    action: "direct",
    comment: "",
  });
  const [showProcPicker, setShowProcPicker] = useState(false);
  const [password, setPassword] = useState("");
  const [storingPass, setStoringPass] = useState(false);
  const [shareLink, setShareLink] = useState("");
  const [uuidInput, setUuidInput] = useState("");
  const [wgKeyInput, setWgKeyInput] = useState("");
  const [tunConflicts, setTunConflicts] = useState<string[]>([]);
  const [tunWarningOpen, setTunWarningOpen] = useState(false);
  const [subInput, setSubInput] = useState("");
  const [showSubImport, setShowSubImport] = useState(false);

  // Linux sudo prompt state. Keep the intent explicit so submitting a
  // recovery password can never accidentally start a new capture session.
  const [rootPromptIntent, setRootPromptIntent] = useState<"start" | "recover" | null>(null);
  const [rootPromptError, setRootPromptError] = useState<string | null>(null);
  const [rootPromptBusy, setRootPromptBusy] = useState(false);

  // Start-time pre-flight: probing upstreams before capture rewires the OS.
  const [probing, setProbing] = useState(false);
  // Active profiles whose upstream is unconfigured — blocks start entirely.
  const [configIssues, setConfigIssues] = useState<UpstreamConfigIssue[] | null>(null);
  // Upstreams that failed their reachability probe — offer force/cancel.
  const [probeFailures, setProbeFailures] = useState<
    { profileName: string; kind: string; error: string }[] | null
  >(null);

  // Traffic rates and domain tracking state
  const [domainRecords, setDomainRecords] = useState<DomainRecord[]>([]);
  const [domainsExpanded, setDomainsExpanded] = useState(false);
  const [domainFilter, setDomainFilter] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<"all" | "proxy" | "direct" | "block">("all");
  const [topNLimit, setTopNLimit] = useState(50);
  const [upSpeed, setUpSpeed] = useState(0);
  const [downSpeed, setDownSpeed] = useState(0);
  const lastBytesRef = useRef<{ up: number; down: number; ts: number } | null>(null);

  // Config as it was when capture last started successfully. Used to detect
  // scope/upstream edits that the running backend will not apply until a
  // Stop+Start (see lib/sockscapRestart).
  const startedCfgRef = useRef<SocksCapConfig | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);

  // Resizable profile sidebar & ribbon collapse state
  const [sidebarWidth, setSidebarWidth] = useState(230);
  const [isRibbon, setIsRibbon] = useState(false);
  const isDraggingRef = useRef(false);

  const handleMouseDownSplitter = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    const startX = e.clientX;
    const startW = sidebarWidth;

    const onMouseMove = (moveEv: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = moveEv.clientX - startX;
      const nextW = startW + delta;
      if (nextW < 110) {
        setIsRibbon(true);
      } else {
        setIsRibbon(false);
        setSidebarWidth(Math.max(160, Math.min(420, nextW)));
      }
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth]);

  const report = useCallback(
    (text: string, ok = true) => {
      setMsg({ ok, text });
      onStatusMessage?.(text);
    },
    [onStatusMessage],
  );

  // Status bar / inline message is single-line and truncated, so collapse a
  // multi-line test result to its first non-empty line for the summary. The
  // full text goes to the copyable modal via openTestDetail.
  const summarize = (text: string): string => {
    const first = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return first || text.trim();
  };

  const openTestDetail = (title: string, body: string) => {
    setTestCopied(false);
    setTestDetail({ title, body });
  };

  const copyTestDetail = async () => {
    if (!testDetail) return;
    try {
      await writeText(testDetail.body);
      setTestCopied(true);
      report(t("common.copied"));
    } catch (e) {
      report(String(e), false);
    }
  };

  // Re-run local-proxy detection and refresh the picker's "detected" group.
  // Errors are reported but non-fatal (detection is best-effort). Declared here
  // (above the mount effect) so it can be an effect dependency.
  const rescanLocalProxies = useCallback(async () => {
    try {
      const detected = await sockscapDetectLocalProxies();
      setDetectedProxies(Array.isArray(detected) ? detected : []);
    } catch (e) {
      report(String(e), false);
    }
  }, [report]);

  const refresh = useCallback(async () => {
    try {
      const [c, cp, st, gf, sn, hp, drs, ri] = await Promise.all([
        sockscapGetConfig().then(normalizeFrontendConfig).catch(() => DEFAULT_CFG),
        sockscapCapabilities().catch(() => null),
        sockscapStatus().catch(() => null),
        sockscapGfwlistStatus().catch(() => null),
        sockscapStatsSnapshot().catch(() => null),
        sockscapHelperStatus().catch(() => null),
        sockscapGetDomainRecords().catch(() => null),
        sockscapRedirectorInstallStatus().catch(() => null),
      ]);
      setCfg(c);
      setCaps(cp);
      setStatus(st);
      setGfw(gf);
      if (sn) setStats(sn);
      if (hp) setHelper(hp);
      if (drs) setDomainRecords(drs);
      setRedirectorInstall(ri);
    } catch (e) {
      report(String(e), false);
    }
  }, [report]);

  useEffect(() => {
    void refresh();
    listSessions()
      .then((arr) => {
        // Only SSH and Proxy sessions can serve as an upstream. Everything else
        // (Local shells, File/folder, RDP/VNC, databases, object storage, mail…)
        // has no proxy endpoint to dial, so keep them out of the picker.
        const mapped: SessionOpt[] = arr.flatMap((s) => {
          const kind: "ssh" | "proxy" | null =
            s.session_type === "SSH" ? "ssh" : s.session_type === "Proxy" ? "proxy" : null;
          if (!kind) return [];
          return [{ id: s.id, name: s.name, host: s.host, port: s.port, kind, groupPath: s.group_path }];
        });
        setSessions(mapped);
      })
      .catch(() => setSessions([]));
    // Warn if a TUN-mode client is active (collides with global capture).
    sockscapDetectTunConflicts()
      .then((conflicts) => setTunConflicts(Array.isArray(conflicts) ? conflicts : []))
      .catch(() => setTunConflicts([]));
    // Populate the upstream picker's "detected local proxies" group.
    void rescanLocalProxies();
  }, [refresh, rescanLocalProxies]);

  useEffect(() => {
    if (!tunWarningOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTunWarningOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tunWarningOpen]);

  useEffect(() => {
    if (!status || status.phase === "idle") {
      lastBytesRef.current = null;
      setUpSpeed(0);
      setDownSpeed(0);
      return;
    }
    const timer = setInterval(() => {
      Promise.all([
        sockscapStatsSnapshot().catch(() => null),
        sockscapStatus().catch(() => null),
        sockscapHelperStatus().catch(() => null),
        sockscapGetDomainRecords().catch(() => null),
      ])
        .then(([sn, st, hp, drs]) => {
          if (st) setStatus(st);
          if (hp) setHelper(hp);
          if (drs) setDomainRecords(drs);
          if (sn) {
            const now = Date.now();
            if (lastBytesRef.current) {
              const dt = (now - lastBytesRef.current.ts) / 1000;
              if (dt > 0.3) {
                const dup = Math.max(0, sn.bytesUp - lastBytesRef.current.up);
                const ddown = Math.max(0, sn.bytesDown - lastBytesRef.current.down);
                setUpSpeed(dup / dt);
                setDownSpeed(ddown / dt);
              }
            }
            lastBytesRef.current = { up: sn.bytesUp, down: sn.bytesDown, ts: now };
            setStats(sn);
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [status]);

  const running =
    status?.phase === "active" ||
    status?.phase === "degraded" ||
    status?.phase === "preparing";

  // While capture is running the backend only hot-reloads the rule surface
  // (ruleMode / userRules / defaultAction / bypassCidrs / GFWList). Scope, app
  // list, upstream, and the active-profile set are snapshotted at Start and
  // ignored until the next Stop+Start (see lib/sockscapRestart + orchestrator
  // hot_reload_policy). So lock every "needs restart" control while running and
  // tell the user to stop first. Adding a NEW profile stays allowed.
  const locked = running;

  const selectedProf = useMemo(() => {
    if (!cfg) return DEFAULT_PROFILE;
    return cfg.profiles.find((p) => p.id === cfg.selectedProfileId) || cfg.profiles[0] || DEFAULT_PROFILE;
  }, [cfg]);

  const activeProfiles = useMemo(() => {
    if (!cfg) return [DEFAULT_PROFILE];
    return profilesByPriority(
      cfg.profiles.filter((p) => p.enabled && cfg.activeProfileIds.includes(p.id)),
    ).map(({ profile }) => profile);
  }, [cfg]);

  const priorityOrderedProfiles = useMemo(
    () => (cfg ? profilesByPriority(cfg.profiles) : []),
    [cfg],
  );

  // While capture is running, editing scope/upstream (mode, apps, active
  // profiles, upstream) does not take effect until Stop+Start — the backend
  // only hot-reloads the rule policy. Flag that so the UI can offer a restart.
  useEffect(() => {
    if (!running || !cfg || !startedCfgRef.current) {
      setNeedsRestart(false);
      return;
    }
    setNeedsRestart(requiresRestart(startedCfgRef.current, cfg));
  }, [cfg, running]);

  const persistConfig = async (next: SocksCapConfig) => {
    setCfg(next);
    try {
      await sockscapSetConfig(next);
      report(t("sockscap.saved"));
    } catch (e) {
      report(String(e), false);
    }
  };

  const patchSelectedProfile = async (partial: Partial<SocksCapProfile>) => {
    if (!cfg) return;
    const profiles = cfg.profiles.map((p) => {
      if (p.id === cfg.selectedProfileId) {
        return { ...p, ...partial };
      }
      return p;
    });
    const updatedSelected = profiles.find((p) => p.id === cfg.selectedProfileId) || profiles[0];
    const nextCfg: SocksCapConfig = {
      ...cfg,
      profiles,
      mode: updatedSelected.mode,
      apps: updatedSelected.apps,
      upstream: updatedSelected.upstream,
      ruleMode: updatedSelected.ruleMode,
      userRules: updatedSelected.userRules,
      defaultAction: updatedSelected.defaultAction,
    };
    await persistConfig(nextCfg);
  };

  const setProfilePriority = async (id: string, value: number) => {
    if (!cfg || !Number.isFinite(value)) return;
    const priority = Math.max(
      MIN_PROFILE_PRIORITY,
      Math.min(MAX_PROFILE_PRIORITY, Math.trunc(value)),
    );
    const profile = cfg.profiles.find((p) => p.id === id);
    if (!profile || profile.priority === priority) return;
    await persistConfig({
      ...cfg,
      profiles: cfg.profiles.map((p) => (p.id === id ? { ...p, priority } : p)),
    });
  };

  const moveProfilePriority = async (id: string, direction: -1 | 1) => {
    if (!cfg) return;
    const from = priorityOrderedProfiles.findIndex(({ profile }) => profile.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= priorityOrderedProfiles.length) return;

    const targetPriority = priorityOrderedProfiles[to].profile.priority;
    const reordered = [...priorityOrderedProfiles];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);

    // Preserve the manually chosen values on every other profile. The moved
    // profile adopts its new neighbour's value; persisting the display order
    // also makes equal-priority ties deterministic (the backend is stable).
    await persistConfig({
      ...cfg,
      profiles: reordered.map(({ profile }) =>
        profile.id === id ? { ...profile, priority: targetPriority } : profile,
      ),
    });
  };

  const toggleProfileActive = async (id: string) => {
    if (!cfg) return;
    let activeProfileIds: string[];
    if (cfg.activeProfileIds.includes(id)) {
      if (cfg.activeProfileIds.length === 1) {
        report(t("sockscap.atLeastOneActive"), false);
        return;
      }
      activeProfileIds = cfg.activeProfileIds.filter((x) => x !== id);
    } else {
      activeProfileIds = [...cfg.activeProfileIds, id];
    }
    const nextCfg = { ...cfg, activeProfileIds };
    await persistConfig(nextCfg);
  };

  const selectProfile = (id: string) => {
    if (!cfg) return;
    const prof = cfg.profiles.find((p) => p.id === id);
    if (!prof) return;
    const nextCfg: SocksCapConfig = {
      ...cfg,
      selectedProfileId: id,
      mode: prof.mode,
      apps: prof.apps,
      upstream: prof.upstream,
      ruleMode: prof.ruleMode,
      userRules: prof.userRules,
      defaultAction: prof.defaultAction,
    };
    setCfg(nextCfg);
  };

  const addProfile = async () => {
    if (!cfg) return;
    const newId = "prof-" + Date.now().toString(36);
    const newProf: SocksCapProfile = {
      id: newId,
      name: `方案 ${cfg.profiles.length + 1}`,
      icon: "🎮",
      color: null,
      enabled: true,
      priority: cfg.profiles.length,
      mode: "global",
      apps: [],
      upstream: { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080, username: "", passwordRef: "" },
      ruleMode: "gfwList",
      userRules: [],
      defaultAction: "direct",
    };
    const profiles = [...cfg.profiles, newProf];
    const activeProfileIds = [...cfg.activeProfileIds, newId];
    const nextCfg: SocksCapConfig = {
      ...cfg,
      profiles,
      activeProfileIds,
      selectedProfileId: newId,
      mode: newProf.mode,
      apps: newProf.apps,
      upstream: newProf.upstream,
      ruleMode: newProf.ruleMode,
      userRules: newProf.userRules,
      defaultAction: newProf.defaultAction,
    };
    await persistConfig(nextCfg);
    report(t("sockscap.profileCreated", { name: newProf.name }));
  };

  /** Import a subscription (URL or pasted blob): fetch+parse into nodes, vault
   *  each node's secret/uuid, and create one profile per node. Imported profiles
   *  are NOT auto-activated (avoids spawning many cores at once); the user
   *  activates the one they want. Selects the first imported node. */
  const onImportSubscription = async () => {
    if (!cfg || !subInput.trim()) return;
    setBusy(true);
    try {
      const nodes = await sockscapImportSubscription(subInput.trim());
      // Vault status once up front (all nodes share the vault gate).
      const vs = await vaultStatus().catch(() => null);
      const needsVault = nodes.some((n) => n.secret || n.uuid);
      if (needsVault && (!vs || vs.state !== "unlocked")) {
        window.dispatchEvent(
          new CustomEvent(VAULT_LOCKED_EVENT, {
            detail: { reason: t("sockscap.vaultLocked") },
          }),
        );
        report(t("sockscap.vaultLocked"), false);
        return;
      }

      const newProfiles: SocksCapProfile[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const params: UpstreamParams = { ...n.params };
        let passwordRef = "";
        if (n.secret) {
          const res = await vaultPut(
            "sockscap_upstream_password",
            "SocksCap Upstream Password",
            n.secret,
          );
          passwordRef = res.reference;
        }
        if (n.uuid) {
          const res = await vaultPut(
            "sockscap_upstream_uuid",
            "SocksCap Upstream UUID",
            n.uuid,
          );
          params.uuidRef = res.reference;
        }
        newProfiles.push({
          id: `prof-${Date.now().toString(36)}-${i}`,
          name: n.name || `${n.host}:${n.port}`,
          icon: "🌐",
          color: null,
          enabled: true,
          priority: cfg.profiles.length + i,
          mode: "global",
          apps: [],
          upstream: {
            kind: n.kindTag as UpstreamKind,
            sessionId: "",
            host: n.host,
            port: n.port,
            username: "",
            passwordRef,
            params,
          },
          ruleMode: "gfwList",
          userRules: [],
          defaultAction: "direct",
        });
      }

      const profiles = [...cfg.profiles, ...newProfiles];
      const firstId = newProfiles[0].id;
      const sel = profiles.find((p) => p.id === firstId) || profiles[0];
      const nextCfg: SocksCapConfig = {
        ...cfg,
        profiles,
        selectedProfileId: firstId,
        mode: sel.mode,
        apps: sel.apps,
        upstream: sel.upstream,
        ruleMode: sel.ruleMode,
        userRules: sel.userRules,
        defaultAction: sel.defaultAction,
      };
      await persistConfig(nextCfg);
      setSubInput("");
      setShowSubImport(false);
      report(t("sockscap.subImported", { count: String(newProfiles.length) }));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const duplicateProfile = async (prof: SocksCapProfile) => {
    if (!cfg) return;
    const newId = "prof-" + Date.now().toString(36);
    const newProf: SocksCapProfile = {
      ...prof,
      id: newId,
      name: `${prof.name} (副本)`,
      priority: cfg.profiles.length,
    };
    const profiles = [...cfg.profiles, newProf];
    const activeProfileIds = [...cfg.activeProfileIds, newId];
    const nextCfg: SocksCapConfig = {
      ...cfg,
      profiles,
      activeProfileIds,
      selectedProfileId: newId,
      mode: newProf.mode,
      apps: newProf.apps,
      upstream: newProf.upstream,
      ruleMode: newProf.ruleMode,
      userRules: newProf.userRules,
      defaultAction: newProf.defaultAction,
    };
    await persistConfig(nextCfg);
    report(t("sockscap.profileDuplicated", { name: newProf.name }));
  };

  const deleteProfile = async (id: string) => {
    if (!cfg || cfg.profiles.length <= 1) {
      report(t("sockscap.atLeastOneProfile"), false);
      return;
    }
    const profiles = cfg.profiles.filter((p) => p.id !== id);
    const activeProfileIds = cfg.activeProfileIds.filter((x) => x !== id);
    if (activeProfileIds.length === 0 && profiles.length > 0) {
      activeProfileIds.push(profiles[0].id);
    }
    const selectedProfileId = cfg.selectedProfileId === id ? profiles[0].id : cfg.selectedProfileId;
    const selectedProf = profiles.find((p) => p.id === selectedProfileId) || profiles[0];
    const nextCfg: SocksCapConfig = {
      ...cfg,
      profiles,
      activeProfileIds,
      selectedProfileId,
      mode: selectedProf.mode,
      apps: selectedProf.apps,
      upstream: selectedProf.upstream,
      ruleMode: selectedProf.ruleMode,
      userRules: selectedProf.userRules,
      defaultAction: selectedProf.defaultAction,
    };
    await persistConfig(nextCfg);
    report("方案已删除");
  };

  const onRefreshStatus = async () => {
    setBusy(true);
    try {
      const [st, sn, hp, gf, drs] = await Promise.all([
        sockscapStatus().catch(() => null),
        sockscapStatsSnapshot().catch(() => null),
        sockscapHelperStatus().catch(() => null),
        sockscapGfwlistStatus().catch(() => null),
        sockscapGetDomainRecords().catch(() => null),
      ]);
      if (st) setStatus(st);
      if (sn) setStats(sn);
      if (hp) setHelper(hp);
      if (gf) setGfw(gf);
      if (drs) setDomainRecords(drs);
      report(t("sockscap.statusRefreshed"));
    } finally {
      setBusy(false);
    }
  };

  // Probe a single upstream the same way the "Test upstream" button does —
  // core kinds spin up a throwaway xray sidecar; native kinds dial directly.
  // Uses the stored passwordRef (what a real start dials with), not the typed
  // password. Throws on failure so the caller can collect it.
  const probeUpstream = async (target: ProbeTarget): Promise<void> => {
    const u = target.upstream;
    if (upstreamRequiresCore(u.kind)) {
      await sockscapTestCoreUpstream({
        upstream: u,
        testHost: "www.google.com",
        testPort: 443,
      });
    } else {
      await sockscapTestUpstream({
        kind: u.kind,
        host: u.host || "127.0.0.1",
        port: u.port || 1080,
        username: u.username,
        password: u.passwordRef || undefined,
        sessionId: u.sessionId || undefined,
        testHost: "www.google.com",
        testPort: 443,
      });
    }
  };

  // Start button entry point: reject unconfigured upstreams, probe configured
  // ones, and only then start. A probe failure surfaces a force/cancel prompt.
  const preflightAndStart = async () => {
    if (!cfg || busy || probing) return;

    // 1) Empty upstream(s) → block start, tell the user which profile.
    const issues = collectUpstreamConfigIssues(cfg);
    if (issues.length > 0) {
      setConfigIssues(issues);
      return;
    }

    // 2) Probe every configured active upstream in parallel.
    const targets = collectProbeTargets(cfg);
    if (targets.length === 0) {
      await onStart();
      return;
    }
    setProbing(true);
    try {
      const results = await Promise.all(
        targets.map((tg) =>
          probeUpstream(tg).then(
            () => null,
            (e) => ({
              profileName: tg.profileName,
              kind: tg.kind as string,
              error: String(e),
            }),
          ),
        ),
      );
      const failures = results.filter(
        (r): r is { profileName: string; kind: string; error: string } => r !== null,
      );
      if (failures.length > 0) {
        setProbeFailures(failures);
        return;
      }
    } finally {
      setProbing(false);
    }

    // 3) All probes passed → start.
    await onStart();
  };

  const onStart = async (sudoPassword?: string) => {
    if (!cfg) return;
    if (sudoPassword) {
      setRootPromptBusy(true);
      setRootPromptError(null);
    } else {
      setBusy(true);
    }
    try {
      await sockscapSetConfig(cfg);
      const st = await sockscapStart(sudoPassword);
      setStatus(st);
      // Snapshot the capture scope so later edits can flag a needed restart.
      startedCfgRef.current = cfg;
      setNeedsRestart(false);
      setRootPromptIntent(null);
      setRootPromptError(null);
      report(st.message || t("sockscap.started"), st.phase !== "idle");
      const [gf, sn, hp] = await Promise.all([
        sockscapGfwlistStatus().catch(() => null),
        sockscapStatsSnapshot().catch(() => null),
        sockscapHelperStatus().catch(() => null),
      ]);
      setGfw(gf);
      if (sn) setStats(sn);
      if (hp) setHelper(hp);
    } catch (e) {
      const errStr = String(e);
      const needsPassword = needsElevationPassword(caps?.platform);
      if (needsPassword && !sudoPassword && isRootRequiredError(errStr)) {
        setRootPromptIntent("start");
        setRootPromptError(null);
      } else if (needsPassword && sudoPassword && isSudoAuthenticationError(errStr)) {
        setRootPromptIntent("start");
        setRootPromptError(t("sockscap.rootPromptIncorrectPassword"));
      } else {
        if (sudoPassword) setRootPromptIntent(null);
        report(errStr, false);
      }
    } finally {
      setBusy(false);
      setRootPromptBusy(false);
    }
  };

  const onStop = async () => {
    setBusy(true);
    try {
      const st = await sockscapStop();
      setStatus(st);
      startedCfgRef.current = null;
      setNeedsRestart(false);
      const [sn, hp] = await Promise.all([
        sockscapStatsSnapshot().catch(() => null),
        sockscapHelperStatus().catch(() => null),
      ]);
      if (sn) setStats(sn);
      if (hp) setHelper(hp);
      report(t("sockscap.stopped"));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  // Apply scope/upstream edits to a running capture: Stop then Start so the
  // backend rebuilds the capture plan and upstream connections.
  const onRestart = async () => {
    setBusy(true);
    try {
      await sockscapStop().catch(() => null);
      startedCfgRef.current = null;
      setNeedsRestart(false);
      if (cfg) await sockscapSetConfig(cfg);
      const st = await sockscapStart();
      setStatus(st);
      startedCfgRef.current = cfg;
      const [sn, hp] = await Promise.all([
        sockscapStatsSnapshot().catch(() => null),
        sockscapHelperStatus().catch(() => null),
      ]);
      if (sn) setStats(sn);
      if (hp) setHelper(hp);
      report(t("sockscap.restarted"), st.phase !== "idle");
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const onRecover = async (sudoPassword?: string) => {
    if (sudoPassword) {
      setRootPromptBusy(true);
      setRootPromptError(null);
    } else {
      setBusy(true);
    }
    try {
      await sockscapRecover(sudoPassword);
      setRootPromptIntent(null);
      setRootPromptError(null);
      await refresh();
      report(t("sockscap.recovered"));
    } catch (e) {
      const errStr = String(e);
      const needsPassword = needsElevationPassword(caps?.platform);
      if (needsPassword && !sudoPassword && isRootRequiredError(errStr)) {
        setRootPromptIntent("recover");
        setRootPromptError(null);
      } else if (needsPassword && sudoPassword && isSudoAuthenticationError(errStr)) {
        setRootPromptIntent("recover");
        setRootPromptError(t("sockscap.rootPromptIncorrectPassword"));
      } else {
        if (sudoPassword) setRootPromptIntent(null);
        report(errStr, false);
      }
    } finally {
      setBusy(false);
      setRootPromptBusy(false);
    }
  };

  const copyDiagnostics = async () => {
    try {
      const diagnostics = await sockscapDiagnostics();
      await writeText(JSON.stringify(diagnostics, null, 2));
      report(t("sockscap.diagnosticsCopied"));
    } catch (e) {
      report(String(e), false);
    }
  };

  const installRedirector = async () => {
    setBusy(true);
    try {
      const install = await sockscapInstallRedirector();
      setRedirectorInstall(install);
      await refresh();
      report(install.message);
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const onRefreshGfw = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      const res = await sockscapRefreshGfwlist(cfg.gfwlist.url);
      setGfw(res);
      if (res.error) report(res.error, false);
      else report(t("sockscap.gfwRefreshed", { count: String(res.ruleCount) }));
      const st = await sockscapStatus().catch(() => null);
      setStatus(st);
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const onImportGfw = async () => {
    try {
      if (!isTauriRuntime()) {
        report(t("sockscap.importDesktopOnly"), false);
        return;
      }
      const selected = await open({
        multiple: false,
        filters: [{ name: "GFWList / AutoProxy", extensions: ["txt", "conf", "list"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      setBusy(true);
      const res = await sockscapImportRules(selected);
      setGfw(res);
      report(t("sockscap.gfwImported", { count: String(res.ruleCount) }));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const onTestTarget = async () => {
    setTesting(true);
    try {
      if (cfg) await sockscapSetConfig(cfg);
      const res = await sockscapTestTarget(testHost.trim(), 443);
      setTestResult(res);
      const summary = t("sockscap.testTargetResult", {
        host: res.host,
        decision: res.decision,
        reason: res.reason,
      });
      report(summary);
      const body = [
        `${t("sockscap.host")}: ${res.host}:${res.port}`,
        `${t("sockscap.testDecision")}: ${res.decision}`,
        `${t("sockscap.testMatchedRule")}: ${res.matchedRule || "-"}`,
        `${t("common.message")}: ${res.reason}`,
      ].join("\n");
      openTestDetail(t("sockscap.testTargetDetailTitle", { host: res.host }), body);
    } catch (e) {
      const err = String(e);
      report(err, false);
      openTestDetail(t("sockscap.testTargetDetailTitle", { host: testHost.trim() }), err);
    } finally {
      setTesting(false);
    }
  };

  const storePassword = async () => {
    if (!cfg || !password) return;
    setStoringPass(true);
    try {
      const status = await vaultStatus().catch(() => null);
      if (!status || status.state !== "unlocked") {
        window.dispatchEvent(
          new CustomEvent(VAULT_LOCKED_EVENT, {
            detail: { reason: t("sockscap.vaultLocked") },
          }),
        );
        report(t("sockscap.vaultLocked"), false);
        return;
      }
      const res = await vaultPut(
        "sockscap_upstream_password",
        "SocksCap Upstream Password",
        password,
      );
      await patchSelectedProfile({
        upstream: { ...selectedProf.upstream, passwordRef: res.reference },
      });
      setPassword("");
      report(t("sockscap.passwordSaved"));
    } catch (e) {
      report(String(e), false);
    } finally {
      setStoringPass(false);
    }
  };

  const clearPassword = async () => {
    if (!cfg) return;
    setPassword("");
    await patchSelectedProfile({ upstream: { ...selectedProf.upstream, passwordRef: "" } });
    report(t("sockscap.passwordCleared"));
  };

  const onTestUpstream = async () => {
    if (!cfg) return;
    setTesting(true);
    const title = t("sockscap.testUpstreamDetailTitle", {
      kind: selectedProf.upstream.kind,
    });
    try {
      const u = selectedProf.upstream;
      let text: string;
      // Core-backed kinds spawn a throwaway xray sidecar (secrets from vault).
      if (upstreamRequiresCore(u.kind)) {
        text = await sockscapTestCoreUpstream({
          upstream: u,
          testHost: "www.google.com",
          testPort: 443,
        });
      } else {
        text = await sockscapTestUpstream({
          kind: u.kind,
          host: u.host || "127.0.0.1",
          port: u.port || 1080,
          username: u.username,
          password: password || u.passwordRef || undefined,
          sessionId: u.sessionId || undefined,
          testHost: "www.google.com",
          testPort: 443,
        });
      }
      report(summarize(text));
      openTestDetail(title, text);
    } catch (e) {
      const err = String(e);
      report(summarize(err), false);
      openTestDetail(title, err);
    } finally {
      setTesting(false);
    }
  };

  /** Merge protocol-specific params into the selected profile's upstream. */
  const patchUpstreamParams = async (patch: Partial<UpstreamParams>) => {
    await patchSelectedProfile({
      upstream: {
        ...selectedProf.upstream,
        params: { ...(selectedProf.upstream.params || {}), ...patch },
      },
    });
  };

  /** Store a plaintext secret in the vault, returning its `vault:<id>` ref.
   *  Returns null (and surfaces a message) if the vault is locked. */
  const vaultStore = async (
    name: string,
    label: string,
    value: string,
  ): Promise<string | null> => {
    const status = await vaultStatus().catch(() => null);
    if (!status || status.state !== "unlocked") {
      window.dispatchEvent(
        new CustomEvent(VAULT_LOCKED_EVENT, {
          detail: { reason: t("sockscap.vaultLocked") },
        }),
      );
      report(t("sockscap.vaultLocked"), false);
      return null;
    }
    const res = await vaultPut(name, label, value);
    return res.reference;
  };

  const storeUuid = async () => {
    if (!cfg || !uuidInput.trim()) return;
    setBusy(true);
    try {
      const ref = await vaultStore(
        "sockscap_upstream_uuid",
        "SocksCap Upstream UUID",
        uuidInput.trim(),
      );
      if (ref === null) return;
      await patchUpstreamParams({ uuidRef: ref });
      setUuidInput("");
      report(t("sockscap.secretStored"));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const storeWgKey = async () => {
    if (!cfg || !wgKeyInput.trim()) return;
    setBusy(true);
    try {
      const ref = await vaultStore(
        "sockscap_upstream_wg_key",
        "SocksCap WireGuard Private Key",
        wgKeyInput.trim(),
      );
      if (ref === null) return;
      await patchUpstreamParams({ privateKeyRef: ref });
      setWgKeyInput("");
      report(t("sockscap.secretStored"));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  /** Parse a pasted share link and populate the current profile's upstream,
   *  vaulting the secret (SS/trojan password) and uuid (vmess/vless). */
  const onImportShareLink = async () => {
    if (!cfg || !shareLink.trim()) return;
    setBusy(true);
    try {
      const parsed = await sockscapParseShareLink(shareLink.trim());
      const kind = parsed.kindTag as UpstreamKind;
      const params: UpstreamParams = { ...parsed.params };

      // Vault the primary secret (SS/trojan password) → passwordRef.
      let passwordRef = "";
      if (parsed.secret) {
        const ref = await vaultStore(
          "sockscap_upstream_password",
          "SocksCap Upstream Password",
          parsed.secret,
        );
        if (ref === null) return; // vault locked
        passwordRef = ref;
      }
      // Vault the uuid (vmess/vless) → params.uuidRef.
      if (parsed.uuid) {
        const ref = await vaultStore(
          "sockscap_upstream_uuid",
          "SocksCap Upstream UUID",
          parsed.uuid,
        );
        if (ref === null) return;
        params.uuidRef = ref;
      }

      await patchSelectedProfile({
        upstream: {
          ...selectedProf.upstream,
          kind,
          sessionId: "",
          host: parsed.host,
          port: parsed.port,
          passwordRef,
          params,
        },
      });
      setShareLink("");
      setPassword("");
      report(
        t("sockscap.shareLinkImported", {
          name: parsed.name || `${parsed.host}:${parsed.port}`,
        }),
      );
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  // Protocol-specific fields for core-backed upstreams. Secrets (uuid, wg key)
  // are stored in the vault; non-secret transport/TLS params are plain fields.
  const renderCoreParams = () => {
    const kind = selectedProf.upstream.kind;
    if (!upstreamRequiresCore(kind)) return null;
    const p: UpstreamParams = selectedProf.upstream.params || {};
    const cls =
      "w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]";
    const net = p.network || "tcp";
    const tls = p.tls || (kind === "trojan" ? "tls" : "none");
    const hasTransport = kind === "trojan" || kind === "vmess" || kind === "vless";
    const hasTls = hasTransport;

    const uuidField = (
      <Field label="UUID">
        <div className="flex gap-1.5">
          <input
            type="password"
            className={"flex-1 " + cls}
            placeholder={p.uuidRef ? t("sockscap.passwordStored") : "UUID"}
            value={uuidInput}
            onChange={(e) => setUuidInput(e.target.value)}
          />
          <button
            type="button"
            className="px-2 py-1.5 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] shrink-0"
            onClick={() => void storeUuid()}
            disabled={busy || !uuidInput}
          >
            {t("sockscap.passwordStore")}
          </button>
        </div>
      </Field>
    );

    const transportFields = hasTransport && (
      <>
        <Field label={t("sockscap.transport")}>
          <select
            className={cls}
            value={net}
            onChange={(e) => void patchUpstreamParams({ network: e.target.value })}
          >
            <option value="tcp">TCP</option>
            <option value="ws">WebSocket</option>
            <option value="grpc">gRPC</option>
            <option value="httpupgrade">HTTPUpgrade</option>
          </select>
        </Field>
        {(net === "ws" || net === "grpc" || net === "httpupgrade") && (
          <Field label={net === "grpc" ? t("sockscap.grpcService") : t("sockscap.wsPath")}>
            <input
              className={cls}
              value={p.path || ""}
              onChange={(e) => void patchUpstreamParams({ path: e.target.value })}
            />
          </Field>
        )}
        {(net === "ws" || net === "httpupgrade") && (
          <Field label={t("sockscap.wsHost")}>
            <input
              className={cls}
              value={p.wsHost || ""}
              onChange={(e) => void patchUpstreamParams({ wsHost: e.target.value })}
            />
          </Field>
        )}
      </>
    );

    const tlsFields = hasTls && (
      <>
        <Field label="TLS">
          <select
            className={cls}
            value={tls}
            onChange={(e) => void patchUpstreamParams({ tls: e.target.value })}
          >
            <option value="none">None</option>
            <option value="tls">TLS</option>
            <option value="reality">REALITY</option>
          </select>
        </Field>
        {(tls === "tls" || tls === "reality") && (
          <Field label="SNI">
            <input
              className={cls}
              value={p.sni || ""}
              onChange={(e) => void patchUpstreamParams({ sni: e.target.value })}
            />
          </Field>
        )}
        {tls === "reality" && (
          <>
            <Field label={t("sockscap.realityPbk")}>
              <input
                className={cls}
                value={p.realityPublicKey || ""}
                onChange={(e) =>
                  void patchUpstreamParams({ realityPublicKey: e.target.value })
                }
              />
            </Field>
            <Field label={t("sockscap.realitySid")}>
              <input
                className={cls}
                value={p.realityShortId || ""}
                onChange={(e) =>
                  void patchUpstreamParams({ realityShortId: e.target.value })
                }
              />
            </Field>
          </>
        )}
      </>
    );

    const wgFields = kind === "wireguard" && (
      <>
        <Field label={t("sockscap.wgPrivateKey")}>
          <div className="flex gap-1.5">
            <input
              type="password"
              className={"flex-1 " + cls}
              placeholder={p.privateKeyRef ? t("sockscap.passwordStored") : t("sockscap.wgPrivateKey")}
              value={wgKeyInput}
              onChange={(e) => setWgKeyInput(e.target.value)}
            />
            <button
              type="button"
              className="px-2 py-1.5 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] shrink-0"
              onClick={() => void storeWgKey()}
              disabled={busy || !wgKeyInput}
            >
              {t("sockscap.passwordStore")}
            </button>
          </div>
        </Field>
        <Field label={t("sockscap.wgPeerKey")}>
          <input
            className={cls}
            value={p.peerPublicKey || ""}
            onChange={(e) => void patchUpstreamParams({ peerPublicKey: e.target.value })}
          />
        </Field>
        <Field label={t("sockscap.wgLocalAddr")}>
          <input
            className={cls}
            placeholder="10.0.0.2/32, fd00::2/128"
            value={(p.localAddress || []).join(", ")}
            onChange={(e) =>
              void patchUpstreamParams({
                localAddress: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      </>
    );

    const vlessFlow = kind === "vless" && (
      <Field label={t("sockscap.vlessFlow")}>
        <select
          className={cls}
          value={p.flow || ""}
          onChange={(e) => void patchUpstreamParams({ flow: e.target.value })}
        >
          <option value="">None</option>
          <option value="xtls-rprx-vision">xtls-rprx-vision</option>
        </select>
      </Field>
    );

    const vmessSecurity = kind === "vmess" && (
      <Field label={t("sockscap.vmessSecurity")}>
        <select
          className={cls}
          value={p.security || "auto"}
          onChange={(e) => void patchUpstreamParams({ security: e.target.value })}
        >
          <option value="auto">auto</option>
          <option value="aes-128-gcm">aes-128-gcm</option>
          <option value="chacha20-poly1305">chacha20-poly1305</option>
          <option value="none">none</option>
        </select>
      </Field>
    );

    return (
      // A disabled <fieldset> natively disables every descendant control;
      // `display:contents` keeps the parent grid layout intact. Lets us lock the
      // whole protocol-params block while running without touching each field.
      <fieldset
        disabled={locked}
        className="contents"
        title={locked ? t("sockscap.lockedTooltip") : undefined}
      >
        {kind === "shadowsocks" && (
          <Field label={t("sockscap.ssMethod")}>
            <select
              className={cls}
              value={p.method || "aes-256-gcm"}
              onChange={(e) => void patchUpstreamParams({ method: e.target.value })}
            >
              <option value="aes-256-gcm">aes-256-gcm</option>
              <option value="aes-128-gcm">aes-128-gcm</option>
              <option value="chacha20-ietf-poly1305">chacha20-ietf-poly1305</option>
              <option value="2022-blake3-aes-256-gcm">2022-blake3-aes-256-gcm</option>
              <option value="2022-blake3-chacha20-poly1305">
                2022-blake3-chacha20-poly1305
              </option>
            </select>
          </Field>
        )}
        {(kind === "vmess" || kind === "vless") && uuidField}
        {vmessSecurity}
        {vlessFlow}
        {transportFields}
        {tlsFields}
        {wgFields}
      </fieldset>
    );
  };

  /** Detect a local proxy (Clash/v2rayN etc) and set it as the upstream in one
   *  click — no hand-filling host/port. Uses the first candidate found. */
  // Apply a picker choice to the selected profile's upstream.
  const onSelectUpstreamSource = (choice: UpstreamChoice) => {
    if (choice.source === "manual") {
      void patchSelectedProfile({
        upstream: { ...selectedProf.upstream, sessionId: "" },
      });
    } else if (choice.source === "session") {
      const s = choice.session;
      void patchSelectedProfile({
        upstream: {
          ...selectedProf.upstream,
          sessionId: s.id,
          host: s.host,
          port: s.port,
        },
      });
    } else {
      // Detected local proxy: adopt its detected kind + loopback host/port.
      const c = choice.candidate;
      void patchSelectedProfile({
        upstream: {
          ...selectedProf.upstream,
          kind: c.kind,
          sessionId: "",
          host: c.host,
          port: c.port,
        },
      });
    }
  };

  const loadProcesses = async () => {
    try {
      const list = await sockscapListProcesses();
      setProcesses(list);
      setShowProcPicker(true);
    } catch (e) {
      report(String(e), false);
    }
  };

  const addAppPath = async (path: string, name?: string) => {
    if (!cfg || !path.trim()) return;
    let candidate: AppSelector;
    try {
      candidate =
        caps?.platform === "macos"
          ? await sockscapValidateMacosApp(path)
          : { path, name: name || path.split(/[/\\]/).pop() || path };
    } catch (e) {
      report(String(e), false);
      return;
    }
    const apps = [...selectedProf.apps];
    if (apps.some((a) => a.path.toLowerCase() === candidate.path.toLowerCase())) return;
    apps.push(candidate);
    await patchSelectedProfile({ apps });
  };

  const pickMacosApplication = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "macOS Application", extensions: ["app"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      await addAppPath(selected);
    } catch (e) {
      report(String(e), false);
    }
  };

  const addUserRule = async () => {
    if (!cfg || !newRule.pattern.trim()) return;
    await patchSelectedProfile({
      userRules: [...selectedProf.userRules, { ...newRule, pattern: newRule.pattern.trim() }],
    });
    setNewRule({ pattern: "", action: "direct", comment: "" });
  };

  const filteredDomainRecords = useMemo(() => {
    let list = domainRecords;
    if (decisionFilter !== "all") {
      list = list.filter((r) => r.decision === decisionFilter);
    }
    if (domainFilter.trim()) {
      const q = domainFilter.trim().toLowerCase();
      list = list.filter(
        (r) =>
          r.domainOrIp.toLowerCase().includes(q) ||
          r.matchedRule?.toLowerCase().includes(q) ||
          r.profileName?.toLowerCase().includes(q) ||
          r.processName?.toLowerCase().includes(q) ||
          String(r.pid).includes(q),
      );
    }
    return list;
  }, [domainRecords, decisionFilter, domainFilter]);

  if (!cfg) {
    return (
      <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        {t("sockscap.loading")}
      </div>
    );
  }

  return (
    <div
      className="relative h-full flex flex-col bg-[var(--taomni-panel-bg)] text-[var(--taomni-text)]"
      data-testid="sockscap-panel"
    >
      {/* Header */}
      <div
        data-testid="sockscap-header"
        className="flex items-center gap-2.5 px-3 py-2 border-b border-[var(--taomni-divider)] shrink-0 min-h-[52px]"
      >
        <Shield className="w-4.5 h-4.5 shrink-0 text-[var(--taomni-accent)]" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-[14px] font-semibold shrink-0">{t("sockscap.title")}</div>
            {caps && (
              <span
                data-testid="sockscap-capability-notes"
                className="inline-flex items-center gap-1 min-w-0 text-[10px] text-[var(--taomni-text-muted)]"
                title={caps.notes.join("\n") || t("sockscap.captureBackendLabel", { backend: caps.captureBackend })}
              >
                {caps.notes.length > 0 && <Info className="w-3 h-3 shrink-0 text-[var(--taomni-accent)]" />}
                <span className="truncate">
                  {t("sockscap.backendCompact", { backend: caps.captureBackend })}
                </span>
              </span>
            )}
          </div>
          <div
            data-testid="sockscap-header-summary"
            className="mt-0.5 flex items-center gap-2 min-w-0 text-[10px] text-[var(--taomni-text-muted)] whitespace-nowrap"
          >
            <span
              className="inline-flex items-center gap-1 min-w-0"
              title={activeProfiles
                .map((p) => `${p.name} (${p.mode === "global" ? t("sockscap.badgeGlobal") : t("sockscap.badgeApps", { count: p.apps.length })})`)
                .join(", ")}
            >
              <Layers className="w-3 h-3 shrink-0 text-[var(--taomni-accent)]" />
              <span className="truncate">
                {t("sockscap.activeProfilesCompact", {
                  count: activeProfiles.length,
                  names: activeProfiles.map((p) => p.name).join(", "),
                })}
              </span>
            </span>
            {stats && (
              <span
                className="hidden xl:inline shrink-0"
                title={t("sockscap.trafficDiagnostics", {
                  lastFlow: stats.lastFlowAt
                    ? new Date(stats.lastFlowAt * 1000).toLocaleString()
                    : "-",
                  quic: stats.quicFlowsDropped ?? 0,
                  udp: stats.udpDirectDatagrams ?? 0,
                  mismatch: stats.scopeMismatchFlows ?? 0,
                })}
              >
                {t("sockscap.trafficCompact", {
                  total: stats.flowsTotal,
                  proxy: stats.flowsProxy,
                  direct: stats.flowsDirect,
                })}
              </span>
            )}
            {helper?.running && (
              <span className="hidden 2xl:inline shrink-0 font-mono text-emerald-600 dark:text-emerald-400">
                Helper {helper.pid}
              </span>
            )}
            {running && (
              <span className="hidden 2xl:inline-flex items-center gap-2 shrink-0 font-mono">
                <span className="inline-flex items-center gap-0.5 text-emerald-500">
                  <ArrowUpRight className="w-3 h-3" />
                  {formatSpeed(upSpeed)}
                </span>
                <span className="inline-flex items-center gap-0.5 text-sky-500">
                  <ArrowDownLeft className="w-3 h-3" />
                  {formatSpeed(downSpeed)}
                </span>
              </span>
            )}
          </div>
        </div>
        {locked && (
          <div
            data-testid="sockscap-locked-banner"
            className="min-w-0 max-w-[400px] flex items-center gap-1.5 text-[11px] text-sky-700 dark:text-sky-400"
            title={t("sockscap.lockedHint")}
          >
            <Lock className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden xl:block truncate">{t("sockscap.lockedHint")}</span>
          </div>
        )}
        {tunConflicts.length > 0 && (
          <button
            type="button"
            data-testid="sockscap-tun-warning"
            className="p-1.5 rounded text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20"
            title={t("sockscap.tunConflictWarning", { adapters: tunConflicts.join(", ") })}
            aria-label={t("sockscap.tunConflictTitle")}
            onClick={() => setTunWarningOpen(true)}
          >
            <AlertTriangle className="w-4 h-4" />
          </button>
        )}
        <div className={`text-[11px] font-medium ${phaseTone(status?.phase ?? "idle")}`}>
          {status ? t(`sockscap.phase.${status.phase}`) : t("sockscap.phase.idle")}
        </div>
        {busy && <Loader2 className="w-4 h-4 animate-spin text-[var(--taomni-text-muted)]" />}
        {running ? (
          <button
            type="button"
            data-testid="sockscap-stop"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-[12px] bg-red-600/90 text-white hover:bg-red-600"
            onClick={() => void onStop()}
            disabled={busy}
          >
            <Square className="w-3.5 h-3.5" />
            {t("sockscap.stop")}
          </button>
        ) : (
          <button
            type="button"
            data-testid="sockscap-start"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
            onClick={() => void preflightAndStart()}
            disabled={busy || probing}
          >
            {probing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            {probing ? t("sockscap.probing") : t("sockscap.start")}
          </button>
        )}
        <button
          type="button"
          data-testid="sockscap-refresh-status"
          className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
          onClick={() => void onRefreshStatus()}
          disabled={busy}
          title={t("sockscap.refreshStatus")}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
        </button>
        <button
          type="button"
          data-testid="sockscap-recover"
          className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"
          onClick={() => void onRecover()}
          disabled={busy}
          title={t("sockscap.recoverHint")}
        >
          {t("sockscap.recover")}
        </button>
        {onClose && (
          <button
            type="button"
            className="p-1.5 rounded hover:bg-[var(--taomni-hover)]"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {status?.phase === "recoveryRequired" && caps?.platform === "macos" && (
        <div className="px-4 py-3 bg-red-500/10 border-b border-red-500/30 text-[11px] text-red-700 dark:text-red-300">
          <div className="font-semibold">{t("sockscap.manualRecoveryTitle")}</div>
          <div className="mt-1">{status.message}</div>
          <ol className="mt-2 ml-4 list-decimal space-y-1">
            <li>{t("sockscap.manualRecoveryStep1")}</li>
            <li>{t("sockscap.manualRecoveryStep2")}</li>
            <li>{t("sockscap.manualRecoveryStep3")}</li>
          </ol>
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded border border-red-500/40 hover:bg-red-500/10"
            onClick={() => void copyDiagnostics()}
          >
            <Copy className="w-3 h-3" />
            {t("sockscap.copyDiagnostics")}
          </button>
        </div>
      )}

      {caps?.platform === "macos" && redirectorInstall?.state !== "ready" && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-[11px] flex flex-wrap items-center justify-between gap-2 text-amber-800 dark:text-amber-300">
          <span>{redirectorInstall?.message || t("sockscap.redirectorMissing")}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-500/40 hover:bg-amber-500/10 disabled:opacity-50"
            disabled={
              busy ||
              !redirectorInstall?.resourceAvailable ||
              redirectorInstall?.state === "conflict" ||
              redirectorInstall?.state === "pendingSystemApproval"
            }
            onClick={() => void installRedirector()}
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
            {t("sockscap.installRedirector")}
          </button>
        </div>
      )}

      {/* Scope/upstream edited while running — needs Stop+Start to apply */}
      {needsRestart && running && (
        <div
          data-testid="sockscap-restart-banner"
          className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-[11px] flex flex-wrap items-center justify-between gap-2 text-amber-700 dark:text-amber-400"
        >
          <span className="flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {t("sockscap.restartNeeded")}
          </span>
          <button
            type="button"
            data-testid="sockscap-restart"
            className="inline-flex items-center gap-1 px-3 py-1 rounded text-[11px] bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-60"
            onClick={() => void onRestart()}
            disabled={busy}
          >
            <RefreshCw className={`w-3 h-3 ${busy ? "animate-spin" : ""}`} />
            {t("sockscap.restartNow")}
          </button>
        </div>
      )}

      {/* Main Dual-Column Content Area */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left Column: Profile Manager Sidebar */}
        {isRibbon ? (
          <div
            className="w-[52px] shrink-0 flex flex-col items-center bg-[var(--taomni-panel-bg)] py-3 px-1 space-y-3 border-r border-[var(--taomni-divider)] select-none"
            data-testid="sockscap-profile-list"
          >
            <div className="flex flex-col items-center gap-1 shrink-0 pb-2 border-b border-[var(--taomni-divider)] w-full">
              <button
                type="button"
                className="p-1.5 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] transition-colors"
                onClick={() => setIsRibbon(false)}
                title={t("sockscap.expandProfiles")}
                aria-label={t("sockscap.expandProfiles")}
              >
                <PanelLeftOpen className="w-4 h-4" />
              </button>
              <button
                type="button"
                data-testid="sockscap-add-profile"
                className="p-1.5 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)] transition-colors"
                onClick={() => void addProfile()}
                title={t("sockscap.newProfileTooltip")}
                aria-label={t("sockscap.newProfileTooltip")}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 flex-1 overflow-y-auto w-full flex flex-col items-center">
              {priorityOrderedProfiles.map(({ profile: p }) => {
                const isSelected = p.id === cfg.selectedProfileId;
                const isActive = p.enabled && cfg.activeProfileIds.includes(p.id);
                return (
                  <div
                    key={p.id}
                    data-testid={`sockscap-profile-item-${p.id}`}
                    className={`w-9 h-9 rounded-lg border flex items-center justify-center relative cursor-pointer transition-all ${
                      isSelected
                        ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/20 shadow-sm"
                        : "border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] bg-[var(--taomni-bg)]"
                    }`}
                    onClick={() => selectProfile(p.id)}
                    onDoubleClick={() => setIsRibbon(false)}
                    title={`${p.name} - ${p.mode === "global" ? t("sockscap.scopeGlobal") : t("sockscap.appsBound", { count: p.apps.length })} (${isActive ? t("sockscap.activeTooltipActive") : t("sockscap.activeTooltipInactive")})`}
                  >
                    <span className="text-base select-none">{p.icon || "🛡️"}</span>
                    {isActive && (
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 absolute -top-0.5 -right-0.5 ring-2 ring-[var(--taomni-panel-bg)]" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div
            style={{ width: sidebarWidth }}
            className="shrink-0 flex flex-col bg-[var(--taomni-panel-bg)] p-3 space-y-3 overflow-y-auto border-r border-[var(--taomni-divider)] select-none relative"
            data-testid="sockscap-profile-list"
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[12px] font-bold text-[var(--taomni-text)] truncate">
                {t("sockscap.profilesTitle")}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  data-testid="sockscap-add-profile"
                  className="p-1 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] transition-colors flex items-center justify-center"
                  onClick={() => void addProfile()}
                  title={t("sockscap.newProfileTooltip")}
                  aria-label={t("sockscap.newProfileTooltip")}
                >
                  <Plus className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  className="p-1 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] transition-colors flex items-center justify-center"
                  onClick={() => setIsRibbon(true)}
                  title={t("sockscap.collapseProfiles")}
                  aria-label={t("sockscap.collapseProfiles")}
                >
                  <PanelLeftClose className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Subscription import: paste a URL or blob → one profile per node. */}
            <div className="mb-1.5">
              <button
                type="button"
                data-testid="sockscap-sub-import-toggle"
                className="w-full text-[11px] px-2 py-1 rounded border border-[var(--taomni-divider)] text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => setShowSubImport((v) => !v)}
                disabled={locked}
                title={locked ? t("sockscap.lockedTooltip") : undefined}
              >
                {t("sockscap.subImportToggle")}
              </button>
              {showSubImport && (
                <div className="mt-1.5 space-y-1.5">
                  <textarea
                    data-testid="sockscap-sub-input"
                    className="w-full text-[11px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] resize-y min-h-[48px]"
                    placeholder={t("sockscap.subImportPlaceholder")}
                    value={subInput}
                    onChange={(e) => setSubInput(e.target.value)}
                  />
                  <button
                    type="button"
                    data-testid="sockscap-sub-import"
                    className="w-full text-[11px] px-2 py-1 rounded border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => void onImportSubscription()}
                    disabled={busy || locked || !subInput.trim()}
                  >
                    {t("sockscap.subImportBtn")}
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-1.5 flex-1 overflow-y-auto">
              {priorityOrderedProfiles.map(({ profile: p }, priorityIndex) => {
                const isSelected = p.id === cfg.selectedProfileId;
                const isActive = p.enabled && cfg.activeProfileIds.includes(p.id);
                const priorityHint = t("sockscap.priorityHint");
                return (
                  <div
                    key={p.id}
                    data-testid={`sockscap-profile-item-${p.id}`}
                    className={`p-2 rounded-lg border text-[11px] transition-all cursor-pointer ${
                      isSelected
                        ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/10 shadow-sm"
                        : "border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] bg-[var(--taomni-bg)]"
                    }`}
                    onClick={() => selectProfile(p.id)}
                  >
                    <div className="flex items-center justify-between gap-1.5 mb-1">
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <input
                          type="checkbox"
                          data-testid={`sockscap-profile-checkbox-${p.id}`}
                          checked={isActive}
                          disabled={locked}
                          onChange={(e) => {
                            e.stopPropagation();
                            void toggleProfileActive(p.id);
                          }}
                          className="rounded border-[var(--taomni-divider)] text-[var(--taomni-accent)] focus:ring-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          title={
                            locked
                              ? t("sockscap.lockedTooltip")
                              : isActive
                                ? t("sockscap.activeTooltipActive")
                                : t("sockscap.activeTooltipInactive")
                          }
                        />
                        <span className="text-[13px]">{p.icon || "🛡️"}</span>
                        <span className="font-semibold truncate">{p.name}</span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="p-1 text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] rounded disabled:opacity-40 disabled:cursor-not-allowed"
                          title={locked ? t("sockscap.lockedTooltip") : t("sockscap.duplicateProfileTooltip")}
                          onClick={() => void duplicateProfile(p)}
                          disabled={locked}
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                        {cfg.profiles.length > 1 && (
                          <button
                            type="button"
                            data-testid={`sockscap-delete-profile-${p.id}`}
                            className="p-1 text-[var(--taomni-text-muted)] hover:text-red-500 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                            title={locked ? t("sockscap.lockedTooltip") : t("sockscap.deleteProfileTooltip")}
                            onClick={() => void deleteProfile(p.id)}
                            disabled={locked}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-[var(--taomni-text-muted)]">
                      <span>
                        {p.mode === "global"
                          ? t("sockscap.scopeGlobal")
                          : t("sockscap.appsBound", { count: p.apps.length })}
                      </span>
                      <span className="px-1.5 py-0.2 rounded bg-[var(--taomni-hover)] font-mono">
                        {p.ruleMode}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--taomni-text-muted)]">
                      <span title={priorityHint}>{t("sockscap.priorityLabel")}</span>
                      <button
                        type="button"
                        data-testid={`sockscap-profile-priority-up-${p.id}`}
                        className="p-0.5 rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={locked || priorityIndex === 0}
                        title={locked ? t("sockscap.lockedTooltip") : t("sockscap.raisePriorityTooltip")}
                        aria-label={t("sockscap.raisePriorityTooltip")}
                        onClick={(event) => {
                          event.stopPropagation();
                          void moveProfilePriority(p.id, -1);
                        }}
                      >
                        <ArrowUp className="w-3 h-3" />
                      </button>
                      <input
                        type="number"
                        step={1}
                        min={MIN_PROFILE_PRIORITY}
                        max={MAX_PROFILE_PRIORITY}
                        data-testid={`sockscap-profile-priority-input-${p.id}`}
                        className="w-12 px-1 py-0.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-center font-mono disabled:opacity-50 disabled:cursor-not-allowed"
                        value={p.priority}
                        disabled={locked}
                        title={locked ? t("sockscap.lockedTooltip") : priorityHint}
                        aria-label={t("sockscap.priorityInputLabel", { name: p.name })}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          const raw = event.target.value.trim();
                          if (!raw) return;
                          const value = Number(raw);
                          if (Number.isFinite(value)) {
                            void setProfilePriority(p.id, value);
                          }
                        }}
                        onBlur={(event) => {
                          if (!event.currentTarget.value.trim()) {
                            event.currentTarget.value = String(p.priority);
                          }
                        }}
                      />
                      <button
                        type="button"
                        data-testid={`sockscap-profile-priority-down-${p.id}`}
                        className="p-0.5 rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={locked || priorityIndex === priorityOrderedProfiles.length - 1}
                        title={locked ? t("sockscap.lockedTooltip") : t("sockscap.lowerPriorityTooltip")}
                        aria-label={t("sockscap.lowerPriorityTooltip")}
                        onClick={(event) => {
                          event.stopPropagation();
                          void moveProfilePriority(p.id, 1);
                        }}
                      >
                        <ArrowDown className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Resizable Handle / Splitter */}
        {!isRibbon && (
          <div
            className="w-1 cursor-col-resize bg-transparent hover:bg-[var(--taomni-accent)]/40 active:bg-[var(--taomni-accent)] transition-colors shrink-0 z-10 self-stretch"
            onMouseDown={handleMouseDownSplitter}
            title="Drag to resize panel"
          />
        )}

        {/* Right Column: Selected Profile Detail & Inspector */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Profile Basic info header */}
          <Section sectionId="profile" title={t("sockscap.editProfileTitle", { name: selectedProf.name })}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label={t("sockscap.profileNameLabel")}>
                <input
                  className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
                  value={selectedProf.name}
                  disabled={locked}
                  title={locked ? t("sockscap.lockedTooltip") : undefined}
                  onChange={(e) => void patchSelectedProfile({ name: e.target.value })}
                />
              </Field>
              <Field label={t("sockscap.profileIconLabel")}>
                <div className="flex gap-1.5">
                  {["🎮", "💻", "🎬", "🌐", "⚡", "🛡️"].map((ic) => (
                    <button
                      key={ic}
                      type="button"
                      disabled={locked}
                      title={locked ? t("sockscap.lockedTooltip") : undefined}
                      className={`px-2 py-1 rounded text-[13px] border disabled:opacity-50 disabled:cursor-not-allowed ${
                        selectedProf.icon === ic
                          ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/20"
                          : "border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                      }`}
                      onClick={() => void patchSelectedProfile({ icon: ic })}
                    >
                      {ic}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </Section>

          {/* Scope Mode */}
          <Section sectionId="scope" title={t("sockscap.section.scope")}>
            <div className="flex gap-2">
              {(["global", "apps"] as ScopeMode[]).map((m) => {
                // The backend refuses app scope when it cannot identify the
                // source application, so do not offer it as a choice.
                const unsupported = m === "apps" && caps !== null && !caps.appFilter;
                const disabled = locked || unsupported;
                return (
                  <button
                    key={m}
                    type="button"
                    data-testid={`sockscap-mode-${m}`}
                    disabled={disabled}
                    title={
                      locked
                        ? t("sockscap.lockedTooltip")
                        : unsupported
                          ? t("sockscap.appModeUnsupported")
                          : undefined
                    }
                    className={`px-3 py-1.5 rounded text-[12px] border disabled:opacity-50 disabled:cursor-not-allowed ${
                      selectedProf.mode === m
                        ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)] font-medium"
                        : "border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                    }`}
                    onClick={() => void patchSelectedProfile({ mode: m })}
                  >
                    {t(`sockscap.mode.${m}`)}
                  </button>
                );
              })}
            </div>
            {caps !== null && !caps.appFilter && (
              <p className="mt-2 text-[11px] text-[var(--taomni-text-muted)]">
                {t("sockscap.appModeUnsupported")}
              </p>
            )}
            {selectedProf.mode === "apps" && (
              <div className="mt-3 space-y-2">
                <div className="flex gap-2">
                  {caps?.platform === "macos" && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={() => void pickMacosApplication()}
                      disabled={locked}
                      title={locked ? t("sockscap.lockedTooltip") : undefined}
                    >
                      <Plus className="w-3 h-3" />
                      {t("sockscap.pickApplication")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => void loadProcesses()}
                    disabled={locked}
                    title={locked ? t("sockscap.lockedTooltip") : undefined}
                  >
                    <Plus className="w-3 h-3" />
                    {t("sockscap.pickProcess")}
                  </button>
                  <ManualAppAdd onAdd={(path) => void addAppPath(path)} disabled={locked} />
                </div>
                {selectedProf.apps.length === 0 ? (
                  <div className="text-[11px] text-[var(--taomni-text-muted)]">{t("sockscap.appsEmpty")}</div>
                ) : (
                  <ul className="space-y-1">
                    {selectedProf.apps.map((a) => (
                      <li
                        key={a.path}
                        className="flex items-center gap-2 text-[12px] px-2 py-1 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
                      >
                        <span className="flex-1 min-w-0" title={a.path}>
                          <span className="block truncate">{a.name || a.path}</span>
                          {a.macosIdentity && (
                            <span className="block truncate text-[10px] text-[var(--taomni-text-muted)]">
                              {a.macosIdentity.mainExecutablePath} · {t("sockscap.bundleFamilyCoverage")}
                            </span>
                          )}
                        </span>
                        {a.macosIdentity?.teamId && (
                          <span
                            className="text-[10px] text-[var(--taomni-text-muted)]"
                            title={a.macosIdentity.designatedRequirement}
                          >
                            {a.macosIdentity.teamId}
                          </span>
                        )}
                        <button
                          type="button"
                          className="p-1 hover:text-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
                          disabled={locked}
                          title={locked ? t("sockscap.lockedTooltip") : undefined}
                          onClick={() =>
                            void patchSelectedProfile({
                              apps: selectedProf.apps.filter((x) => x.path !== a.path),
                            })
                          }
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Section>

          {/* Upstream */}
          <Section sectionId="upstream" title={t("sockscap.section.upstream")}>
            {/* No local proxy detected → guide the user to run one correctly
                (proxy/SOCKS inbound only; NOT system-proxy/global, NOT TUN),
                then rescan or import a share link. Only for native socks5/http
                upstreams with no saved session picked. */}
            {detectedProxies.length === 0 &&
              (selectedProf.upstream.kind === "socks5" ||
                selectedProf.upstream.kind === "http") &&
              !selectedProf.upstream.sessionId && (
                <div
                  data-testid="sockscap-noproxy-help"
                  className="mb-3 px-3 py-2 rounded text-[11px] border border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300"
                >
                  <div className="flex items-center gap-1.5 font-semibold mb-1">
                    <HelpCircle className="w-3.5 h-3.5 shrink-0" />
                    {t("sockscap.noProxyHelpTitle")}
                  </div>
                  <ol className="list-decimal pl-4 space-y-0.5 text-[var(--taomni-text-muted)]">
                    <li>{t("sockscap.noProxyHelpStep1")}</li>
                    <li>{t("sockscap.noProxyHelpStep2")}</li>
                    <li>{t("sockscap.noProxyHelpStep3")}</li>
                    <li>{t("sockscap.noProxyHelpStep4")}</li>
                  </ol>
                </div>
              )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label={t("sockscap.upstreamKind")}>
                <select
                  data-testid="sockscap-upstream-kind"
                  className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
                  value={selectedProf.upstream.kind}
                  disabled={locked}
                  title={locked ? t("sockscap.lockedTooltip") : undefined}
                  onChange={(e) =>
                    void patchSelectedProfile({
                      upstream: {
                        ...selectedProf.upstream,
                        kind: e.target.value as UpstreamKind,
                      },
                    })
                  }
                >
                  <option value="socks5">SOCKS5</option>
                  <option value="http">HTTP / HTTPS</option>
                  <option value="ssh">SSH Tunnel (Dynamic SOCKS)</option>
                  <option value="shadowsocks">Shadowsocks</option>
                  <option value="trojan">Trojan</option>
                  <option value="vmess">VMess</option>
                  <option value="vless">VLESS</option>
                  <option value="wireguard">WireGuard</option>
                </select>
              </Field>

              {upstreamRequiresCore(selectedProf.upstream.kind) ? (
                <Field label={t("sockscap.shareLinkImport")}>
                  <div className="flex gap-1.5">
                    <input
                      data-testid="sockscap-sharelink-input"
                      className="flex-1 text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
                      placeholder="ss:// vmess:// vless:// trojan://"
                      value={shareLink}
                      disabled={locked}
                      title={locked ? t("sockscap.lockedTooltip") : undefined}
                      onChange={(e) => setShareLink(e.target.value)}
                    />
                    <button
                      type="button"
                      data-testid="sockscap-sharelink-import"
                      className="px-2 py-1.5 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={() => void onImportShareLink()}
                      disabled={busy || locked || !shareLink.trim()}
                    >
                      {t("sockscap.shareLinkImportBtn")}
                    </button>
                  </div>
                </Field>
              ) : (
                <Field label={t("sockscap.upstreamSource")}>
                  <UpstreamSourcePicker
                    key={selectedProf.id}
                    mode={selectedProf.upstream.kind === "ssh" ? "ssh" : "proxy"}
                    detected={detectedProxies}
                    sessions={sessions}
                    current={selectedProf.upstream}
                    onSelect={onSelectUpstreamSource}
                    onRescan={rescanLocalProxies}
                    busy={busy}
                    disabled={locked}
                    lockedTooltip={locked ? t("sockscap.lockedTooltip") : undefined}
                    t={t}
                  />
                </Field>
              )}

              <Field label={t("sockscap.host")}>
                <input
                  className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
                  value={selectedProf.upstream.host}
                  disabled={locked}
                  title={locked ? t("sockscap.lockedTooltip") : undefined}
                  onChange={(e) =>
                    void patchSelectedProfile({
                      upstream: { ...selectedProf.upstream, host: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label={t("sockscap.port")}>
                <input
                  type="number"
                  className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
                  value={selectedProf.upstream.port}
                  disabled={locked}
                  title={locked ? t("sockscap.lockedTooltip") : undefined}
                  onChange={(e) =>
                    void patchSelectedProfile({
                      upstream: {
                        ...selectedProf.upstream,
                        port: parseInt(e.target.value, 10) || 1080,
                      },
                    })
                  }
                />
              </Field>
              <Field label={t("sockscap.username")}>
                <input
                  className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
                  value={selectedProf.upstream.username || ""}
                  disabled={locked}
                  title={locked ? t("sockscap.lockedTooltip") : undefined}
                  onChange={(e) =>
                    void patchSelectedProfile({
                      upstream: { ...selectedProf.upstream, username: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label={t("sockscap.password")}>
                <div className="flex gap-1.5">
                  <input
                    type="password"
                    className="flex-1 text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
                    placeholder={
                      selectedProf.upstream.passwordRef
                        ? t("sockscap.passwordStored")
                        : t("sockscap.passwordPh")
                    }
                    value={password}
                    disabled={locked}
                    title={locked ? t("sockscap.lockedTooltip") : undefined}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="px-2 py-1.5 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => void storePassword()}
                    disabled={storingPass || locked || !password}
                  >
                    {t("sockscap.passwordStore")}
                  </button>
                  {selectedProf.upstream.passwordRef && (
                    <button
                      type="button"
                      className="px-2 py-1.5 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] text-red-500 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={() => void clearPassword()}
                      disabled={locked}
                    >
                      {t("common.clear")}
                    </button>
                  )}
                </div>
              </Field>

              {renderCoreParams()}
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                data-testid="sockscap-test-upstream"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
                onClick={() => void onTestUpstream()}
                disabled={busy || testing}
              >
                {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {testing ? t("sockscap.testing") : t("sockscap.testUpstream")}
              </button>
            </div>
          </Section>

          {/* Rules Strategy */}
          <Section sectionId="rules" title={t("sockscap.section.rules")}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
              <Field label={t("sockscap.ruleMode")}>
                <select
                  className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                  value={selectedProf.ruleMode}
                  onChange={(e) =>
                    void patchSelectedProfile({ ruleMode: e.target.value as RuleMode })
                  }
                >
                  <option value="gfwList">{t("sockscap.ruleMode.gfwList")}</option>
                  <option value="proxyAll">{t("sockscap.ruleMode.proxyAll")}</option>
                  <option value="off">{t("sockscap.ruleMode.off")}</option>
                </select>
              </Field>
              <Field label={t("sockscap.defaultAction")}>
                <select
                  className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                  value={selectedProf.defaultAction}
                  onChange={(e) =>
                    void patchSelectedProfile({ defaultAction: e.target.value as Decision })
                  }
                >
                  <option value="direct">{t("sockscap.action.direct")}</option>
                  <option value="proxy">{t("sockscap.action.proxy")}</option>
                  <option value="block">{t("sockscap.action.block")}</option>
                </select>
              </Field>
            </div>

            {/* User rules table for selected profile */}
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-[var(--taomni-text-muted)]">
                {t("sockscap.userRulesTitle")}
              </div>
              <div className="flex gap-2">
                <input
                  className="flex-1 text-[12px] px-2 py-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                  placeholder={t("sockscap.patternPh")}
                  value={newRule.pattern}
                  onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })}
                />
                <select
                  className="text-[12px] px-2 py-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                  value={newRule.action}
                  onChange={(e) =>
                    setNewRule({ ...newRule, action: e.target.value as Decision })
                  }
                >
                  <option value="direct">{t("sockscap.action.direct")}</option>
                  <option value="proxy">{t("sockscap.action.proxy")}</option>
                  <option value="block">{t("sockscap.action.block")}</option>
                </select>
                <button
                  type="button"
                  className="px-3 py-1 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90"
                  onClick={() => void addUserRule()}
                >
                  {t("common.add")}
                </button>
              </div>

              {selectedProf.userRules.length === 0 ? (
                <div className="text-[11px] text-[var(--taomni-text-muted)]">{t("sockscap.userRulesEmpty")}</div>
              ) : (
                <ul className="space-y-1 max-h-36 overflow-auto">
                  {selectedProf.userRules.map((r, idx) => (
                    <li
                      key={`${r.pattern}-${idx}`}
                      className="flex items-center gap-2 text-[12px] px-2 py-1 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
                    >
                      <span className="font-mono flex-1">{r.pattern}</span>
                      <span className="text-[11px] text-[var(--taomni-text-muted)] uppercase">
                        {r.action}
                      </span>
                      <button
                        type="button"
                        className="p-1 hover:text-red-500"
                        onClick={() =>
                          void patchSelectedProfile({
                            userRules: selectedProf.userRules.filter((_, i) => i !== idx),
                          })
                        }
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Section>

          {/* Test Target Dry-run */}
          <Section sectionId="test" title={t("sockscap.section.test")}>
            <div className="flex gap-2 items-center">
              <input
                data-testid="sockscap-test-host"
                className="flex-1 text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                value={testHost}
                onChange={(e) => setTestHost(e.target.value)}
              />
              <button
                type="button"
                data-testid="sockscap-test-target"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
                onClick={() => void onTestTarget()}
                disabled={busy || testing}
              >
                {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {testing ? t("sockscap.testing") : t("sockscap.testTarget")}
              </button>
            </div>
            {testResult && (
              <div className="mt-2 p-2 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)] text-[11px]">
                <span className="font-semibold">{testResult.host}: </span>
                <span className="uppercase font-medium text-[var(--taomni-accent)]">
                  {testResult.decision}
                </span>{" "}
                · {testResult.reason}
              </div>
            )}
          </Section>

          {/* Global GFWList & Shared Controls */}
          <Section sectionId="gfwlist" title={t("sockscap.gfwListTitle")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] text-[var(--taomni-text-muted)]">
                {gfw?.loaded
                  ? t("sockscap.gfwStatus", {
                      count: String(gfw.ruleCount),
                      skipped: String(gfw.skipped),
                      when: gfw.lastRefresh
                        ? new Date(gfw.lastRefresh).toLocaleString()
                        : t("common.justNow"),
                    })
                  : t("sockscap.gfwNotLoaded")}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                  onClick={() => void onRefreshGfw()}
                  disabled={busy}
                >
                  <RefreshCw className={`w-3 h-3 ${busy ? "animate-spin" : ""}`} />
                  {t("sockscap.refreshGfw")}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                  onClick={() => void onImportGfw()}
                  disabled={busy}
                >
                  {t("sockscap.importGfw")}
                </button>
              </div>
            </div>

            {/* Session-level QUIC blocking (forces QUIC→TCP so capture can proxy it). */}
            <label
              className="mt-3 flex items-start gap-2 text-[12px] cursor-pointer select-none"
              title={locked ? t("sockscap.lockedTooltip") : undefined}
            >
              <input
                type="checkbox"
                data-testid="sockscap-block-quic"
                checked={cfg.blockQuic ?? true}
                disabled={locked || busy}
                onChange={(e) => {
                  if (!cfg) return;
                  void persistConfig({ ...cfg, blockQuic: e.target.checked });
                }}
                className="mt-0.5 rounded border-[var(--taomni-divider)] text-[var(--taomni-accent)] focus:ring-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <span className="flex-1">
                <span className="font-medium text-[var(--taomni-text)]">
                  {t("sockscap.blockQuic")}
                </span>
                <span className="block text-[11px] text-[var(--taomni-text-muted)]">
                  {t("sockscap.blockQuicHint")}
                </span>
              </span>
            </label>
          </Section>

          {/* Captured Domains & Traffic Table */}
          <div className="rounded-lg border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] overflow-hidden">
            <button
              type="button"
              data-testid="sockscap-domains-toggle"
              className="w-full px-3 py-2 text-left text-[11px] font-semibold flex items-center justify-between hover:bg-[var(--taomni-hover)] transition-colors"
              aria-expanded={domainsExpanded}
              aria-controls="sockscap-domains-content"
              onClick={() => setDomainsExpanded(!domainsExpanded)}
            >
              <div className="flex items-center gap-2">
                {domainsExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                <span>Captured Domains & Flow History</span>
                <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-[var(--taomni-hover)] font-normal text-[var(--taomni-text-muted)]">
                  {domainRecords.length} entries
                </span>
              </div>
              <span className="text-[10px] font-normal text-[var(--taomni-text-muted)]">
                {domainsExpanded ? "Click to collapse" : "Click to expand"}
              </span>
            </button>

            {domainsExpanded && (
              <div id="sockscap-domains-content" className="p-3 border-t border-[var(--taomni-divider)] space-y-3">
                {/* Controls Bar */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-1 min-w-[220px]">
                    <div className="relative flex-1">
                      <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-[var(--taomni-text-muted)]" />
                      <input
                        className="w-full text-[11px] pl-7 pr-2 py-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)]"
                        placeholder="Search domain, IP, profile or process..."
                        value={domainFilter}
                        onChange={(e) => setDomainFilter(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="flex rounded border border-[var(--taomni-divider)] p-0.5 text-[10px]">
                      {(["all", "proxy", "direct", "block"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={`px-2 py-0.5 rounded capitalize transition-colors ${
                            decisionFilter === mode
                              ? "bg-[var(--taomni-accent)] text-white font-medium"
                              : "hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"
                          }`}
                          onClick={() => setDecisionFilter(mode)}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>

                    <select
                      className="text-[10px] px-2 py-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)]"
                      value={topNLimit}
                      onChange={(e) => setTopNLimit(Number(e.target.value))}
                    >
                      <option value={50}>Top 50</option>
                      <option value={100}>Top 100</option>
                      <option value={200}>All (max 200)</option>
                    </select>

                    <button
                      type="button"
                      className="px-2 py-1 rounded text-[10px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] flex items-center gap-1 text-[var(--taomni-text-muted)]"
                      onClick={() => {
                        void sockscapClearDomainRecords();
                        setDomainRecords([]);
                      }}
                    >
                      <Trash2 className="w-3 h-3" />
                      Clear
                    </button>
                  </div>
                </div>

                {/* Table */}
                <div className="max-h-[280px] overflow-auto rounded border border-[var(--taomni-divider)]">
                  <table className="w-full text-[11px] text-left border-collapse">
                    <thead className="sticky top-0 bg-[var(--taomni-panel-bg)] border-b border-[var(--taomni-divider)] text-[10px] text-[var(--taomni-text-muted)] uppercase">
                      <tr>
                        <th className="py-1.5 px-2">Domain / IP</th>
                        <th className="py-1.5 px-2">Decision</th>
                        <th className="py-1.5 px-2">Profile</th>
                        <th className="py-1.5 px-2">Matched Rule</th>
                        <th className="py-1.5 px-2">Process (PID)</th>
                        <th className="py-1.5 px-2 text-right">Hits</th>
                        <th className="py-1.5 px-2 text-right">Data Transferred</th>
                        <th className="py-1.5 px-2 text-right">Last Seen</th>
                        <th className="py-1.5 px-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--taomni-divider)]">
                      {filteredDomainRecords.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="py-4 text-center text-[10px] text-[var(--taomni-text-muted)]">
                            No domain records captured yet. Start SocksCap and browse network to inspect live domain traffic.
                          </td>
                        </tr>
                      ) : (
                        filteredDomainRecords.slice(0, topNLimit).map((rec) => (
                          <tr key={rec.key} className="hover:bg-[var(--taomni-hover)] transition-colors">
                            <td className="py-1.5 px-2 font-mono font-medium truncate max-w-[180px]" title={rec.domainOrIp}>
                              {rec.domainOrIp}
                            </td>
                            <td className="py-1.5 px-2">
                              {rec.decision === "proxy" && (
                                <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                                  PROXY
                                </span>
                              )}
                              {rec.decision === "direct" && (
                                <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/20">
                                  DIRECT
                                </span>
                              )}
                              {rec.decision === "block" && (
                                <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
                                  BLOCK
                                </span>
                              )}
                            </td>
                            <td className="py-1.5 px-2 font-medium text-[var(--taomni-accent)] truncate max-w-[100px]" title={rec.profileName || "-"}>
                              {rec.profileName || "-"}
                            </td>
                            <td className="py-1.5 px-2 text-[var(--taomni-text-muted)] truncate max-w-[140px]" title={rec.matchedRule || "-"}>
                              {rec.matchedRule || "-"}
                            </td>
                            <td className="py-1.5 px-2 text-[var(--taomni-text-muted)]">
                              {rec.processName ? (
                                <span>{rec.processName} {rec.pid ? `(${rec.pid})` : ""}</span>
                              ) : (
                                "-"
                              )}
                            </td>
                            <td className="py-1.5 px-2 text-right tabular-nums font-mono">{rec.hitCount}</td>
                            <td className="py-1.5 px-2 text-right tabular-nums font-mono">
                              {formatBytes(rec.bytesUp + rec.bytesDown)}
                            </td>
                            <td className="py-1.5 px-2 text-right tabular-nums font-mono text-[var(--taomni-text-muted)]">
                              {formatTime(rec.lastSeenUnix)}
                            </td>
                            <td className="py-1.5 px-2 text-right">
                              <button
                                type="button"
                                className="px-1.5 py-0.5 rounded text-[9px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] transition-colors"
                                onClick={() => {
                                  if (!cfg) return;
                                  const pattern = rec.domainOrIp;
                                  if (selectedProf.userRules.some((r) => r.pattern === pattern)) return;
                                  const updatedRules = [
                                    { pattern, action: rec.decision === "proxy" ? ("proxy" as const) : ("direct" as const) },
                                    ...selectedProf.userRules,
                                  ];
                                  void patchSelectedProfile({ userRules: updatedRules });
                                }}
                              >
                                + User Rule
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {msg && (
            <div
              className={`mt-2 text-[11px] flex gap-1 items-start ${
                msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"
              }`}
            >
              {msg.ok ? (
                <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              )}
              {msg.text}
            </div>
          )}
        </div>
      </div>

      {showProcPicker && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-20">
          <div className="w-[min(520px,90vw)] max-h-[70vh] flex flex-col rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--taomni-divider)]">
              <div className="text-[13px] font-semibold">{t("sockscap.pickProcess")}</div>
              <button type="button" className="p-1" onClick={() => setShowProcPicker(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-2">
              {processes.length === 0 ? (
                <div className="text-[11px] text-[var(--taomni-text-muted)] p-2">
                  {t("sockscap.processesEmpty")}
                </div>
              ) : (
                processes.map((p) => (
                  <button
                    key={`${p.pid}-${p.path}`}
                    type="button"
                    className="w-full text-left px-2 py-1.5 rounded text-[11px] hover:bg-[var(--taomni-hover)]"
                    onClick={() => {
                      void addAppPath(p.path || p.name, p.name);
                      setShowProcPicker(false);
                    }}
                  >
                    <div className="font-medium">{p.name || p.pid}</div>
                    <div className="text-[var(--taomni-text-muted)] truncate">{p.path}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {tunWarningOpen && (
        <div
          className="absolute inset-0 bg-black/40 flex items-center justify-center z-30"
          onClick={() => setTunWarningOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="sockscap-tun-warning-title"
            data-testid="sockscap-tun-warning-dialog"
            className="w-[min(520px,92vw)] rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--taomni-divider)]">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              <h2 id="sockscap-tun-warning-title" className="flex-1 text-[13px] font-semibold">
                {t("sockscap.tunConflictTitle")}
              </h2>
              <button
                type="button"
                data-testid="sockscap-tun-warning-close"
                className="p-1 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]"
                aria-label={t("common.close")}
                onClick={() => setTunWarningOpen(false)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="px-4 py-3 text-[12px] leading-5 text-[var(--taomni-text-muted)]">
              {t("sockscap.tunConflictWarning", { adapters: tunConflicts.join(", ") })}
            </p>
          </div>
        </div>
      )}

      {rootPromptIntent && (
        <SocksCapRootPrompt
          subtitle={
            rootPromptIntent === "recover"
              ? t("sockscap.rootPromptRecoverSubtitle")
              : undefined
          }
          onSubmit={(password) => {
            if (rootPromptIntent === "recover") void onRecover(password);
            else void onStart(password);
          }}
          onCancel={() => {
            setRootPromptIntent(null);
            setRootPromptError(null);
          }}
          error={rootPromptError}
          busy={rootPromptBusy}
        />
      )}

      {/* Pre-flight: an active profile's upstream is empty → cannot start. */}
      {configIssues && (
        <div
          className="absolute inset-0 bg-black/40 flex items-center justify-center z-30"
          data-testid="sockscap-config-issue-dialog"
        >
          <div className="w-[min(480px,92vw)] flex flex-col rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--taomni-divider)]">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
              <div className="text-[13px] font-semibold">
                {t("sockscap.configIssueTitle")}
              </div>
            </div>
            <div className="px-4 py-3 space-y-2 text-[12px]">
              <div className="text-[var(--taomni-text-muted)]">
                {t("sockscap.configIssueIntro")}
              </div>
              <ul className="space-y-1.5">
                {configIssues.map((iss) => (
                  <li
                    key={iss.profileId}
                    className="flex items-start gap-1.5 px-2 py-1.5 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
                  >
                    <X className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
                    <span>
                      <span className="font-semibold">{iss.profileName}</span>
                      {" — "}
                      {t(`sockscap.${iss.reasonKey}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--taomni-divider)]">
              <button
                type="button"
                data-testid="sockscap-config-issue-ok"
                className="px-3 py-1.5 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90"
                onClick={() => setConfigIssues(null)}
              >
                {t("common.ok")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pre-flight: upstream probe failed → force start or cancel. */}
      {probeFailures && (
        <div
          className="absolute inset-0 bg-black/40 flex items-center justify-center z-30"
          data-testid="sockscap-probe-fail-dialog"
        >
          <div className="w-[min(560px,92vw)] max-h-[75vh] flex flex-col rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--taomni-divider)]">
              <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
              <div className="text-[13px] font-semibold">
                {t("sockscap.probeFailTitle")}
              </div>
            </div>
            <div className="px-4 py-3 space-y-2 text-[12px] overflow-auto">
              <div className="text-[var(--taomni-text-muted)]">
                {t("sockscap.probeFailIntro")}
              </div>
              <ul className="space-y-1.5">
                {probeFailures.map((f, i) => (
                  <li
                    key={`${f.profileName}-${i}`}
                    className="px-2 py-1.5 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
                  >
                    <div className="font-semibold flex items-center gap-1.5">
                      <span>{f.profileName}</span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] uppercase bg-[var(--taomni-hover)] font-mono">
                        {f.kind}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-red-500 break-words whitespace-pre-wrap">
                      {f.error}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="text-[11px] text-[var(--taomni-text-muted)]">
                {t("sockscap.probeFailHint")}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--taomni-divider)]">
              <button
                type="button"
                data-testid="sockscap-probe-fail-cancel"
                className="px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                onClick={() => setProbeFailures(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                data-testid="sockscap-probe-fail-force"
                className="px-3 py-1.5 rounded text-[12px] bg-amber-600 text-white hover:bg-amber-500"
                onClick={() => {
                  setProbeFailures(null);
                  void onStart();
                }}
              >
                {t("sockscap.probeFailForce")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full test result — status bar only shows a summary; this shows the
          complete text and lets the user copy it. */}
      {testDetail && (
        <div
          className="absolute inset-0 bg-black/40 flex items-center justify-center z-20"
          data-testid="sockscap-test-detail"
        >
          <div className="w-[min(620px,92vw)] max-h-[75vh] flex flex-col rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--taomni-divider)]">
              <div className="text-[13px] font-semibold truncate">{testDetail.title}</div>
              <button
                type="button"
                className="p-1 rounded hover:bg-[var(--taomni-hover)]"
                onClick={() => setTestDetail(null)}
                aria-label={t("common.close")}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              <pre
                data-testid="sockscap-test-detail-body"
                className="whitespace-pre-wrap break-words text-[11px] font-mono text-[var(--taomni-text)] leading-relaxed"
              >
                {testDetail.body}
              </pre>
            </div>
            <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[var(--taomni-divider)]">
              <button
                type="button"
                data-testid="sockscap-test-detail-copy"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                onClick={() => void copyTestDetail()}
              >
                {testCopied ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                {testCopied ? t("common.copied") : t("common.copy")}
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90"
                onClick={() => setTestDetail(null)}
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  sectionId,
  title,
  children,
}: {
  sectionId: string;
  title: string;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = `sockscap-section-${sectionId}-content`;
  return (
    <section className="rounded-lg border border-[var(--taomni-divider)] overflow-hidden">
      <button
        type="button"
        data-testid={`sockscap-section-${sectionId}-toggle`}
        className="w-full px-3 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-[var(--taomni-hover)] transition-colors"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((current) => !current)}
      >
        <h3 className="text-[12px] font-semibold truncate">{title}</h3>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
        )}
      </button>
      <div id={contentId} hidden={!expanded} className="border-t border-[var(--taomni-divider)] p-3">
        {children}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[11px]">
      <div className="text-[var(--taomni-text-muted)] mb-1">{label}</div>
      {children}
    </label>
  );
}

function ManualAppAdd({
  onAdd,
  disabled,
}: {
  onAdd: (path: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [path, setPath] = useState("");
  return (
    <div className="flex gap-1 flex-1 min-w-[200px]">
      <input
        className="flex-1 text-[11px] px-2 py-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
        placeholder={t("sockscap.appPathPh")}
        value={path}
        disabled={disabled}
        title={disabled ? t("sockscap.lockedTooltip") : undefined}
        onChange={(e) => setPath(e.target.value)}
      />
      <button
        type="button"
        className="px-2 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={disabled}
        title={disabled ? t("sockscap.lockedTooltip") : undefined}
        onClick={() => {
          if (path.trim()) {
            onAdd(path.trim());
            setPath("");
          }
        }}
      >
        {t("common.add")}
      </button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatTime(unixSec: number): string {
  if (!unixSec) return "-";
  const date = new Date(unixSec * 1000);
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
