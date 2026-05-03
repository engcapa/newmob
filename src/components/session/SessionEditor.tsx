import { useEffect, useMemo, useState } from "react";
import {
  X,
  Terminal as TerminalIcon,
  Monitor,
  Folder,
  Wifi,
  Bookmark,
  Shield,
  FlaskConical,
  FileText,
  Globe,
  Cloud,
  Server,
  ChevronDown,
  Search,
  Eye,
  EyeOff,
  FolderPlus,
  Save,
  RotateCcw,
  Network,
  HelpCircle,
} from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { testSshConnection } from "../../lib/ipc";
import {
  getSessionNetworkSettings,
  ipKindToLabel,
  ipLabelToKind,
  proxyKindToLabel,
  proxyLabelToKind,
  toNetworkSettingsPayload,
  type NetworkSettings as NetworkSettingsValue,
} from "../../lib/networkSettings";
import { parseUserHostPort } from "../../lib/quickConnect";
import {
  SESSION_ROOT_LABEL,
  collectFolderPaths,
  folderOptionLabel,
  normalizeGroupPath,
  toStoredGroupPath,
} from "../../lib/sessionPaths";
import type { SessionConfig, AuthMethod } from "../../lib/ipc";
import {
  getSessionTerminalProfile,
  loadGlobalTerminalProfile,
  parseSessionOptions,
  type TerminalProfile,
} from "../../lib/terminalProfile";
import { AppThemeSwitcher } from "../settings/AppThemeSwitcher";
import { TerminalAppearanceSettings } from "../terminal/TerminalAppearanceSettings";

/* ------------------------------------------------------------------ */
/*  Local types                                                        */
/* ------------------------------------------------------------------ */

type Proto =
  | "SSH" | "Telnet" | "Rlogin" | "RDP" | "VNC" | "FTP" | "SFTP"
  | "Serial" | "File" | "Shell" | "Browser" | "Mosh" | "S3" | "WSL";

type SectionTab = "advanced" | "terminal" | "network" | "bookmark";

const PROTOS: { id: Proto; icon: React.ReactNode; color: string }[] = [
  { id: "SSH",     icon: <TerminalIcon className="w-7 h-7" />, color: "#2b5d8b" },
  { id: "Telnet",  icon: <TerminalIcon className="w-7 h-7" />, color: "#3b7ac2" },
  { id: "Rlogin",  icon: <TerminalIcon className="w-7 h-7" />, color: "#5b8a4a" },
  { id: "RDP",     icon: <Monitor className="w-7 h-7" />,      color: "#a04b9c" },
  { id: "VNC",     icon: <Monitor className="w-7 h-7" />,      color: "#c97a23" },
  { id: "FTP",     icon: <Folder className="w-7 h-7" />,       color: "#7a4f1a" },
  { id: "SFTP",    icon: <Folder className="w-7 h-7" />,       color: "#1e6db8" },
  { id: "Serial",  icon: <Wifi className="w-7 h-7" />,         color: "#236a98" },
  { id: "File",    icon: <FileText className="w-7 h-7" />,     color: "var(--moba-text-muted)" },
  { id: "Shell",   icon: <TerminalIcon className="w-7 h-7" />, color: "#62d36f" },
  { id: "Browser", icon: <Globe className="w-7 h-7" />,        color: "#1e5fa8" },
  { id: "Mosh",    icon: <Server className="w-7 h-7" />,       color: "#7a3d9d" },
  { id: "S3",      icon: <Cloud className="w-7 h-7" />,        color: "#cc6f00" },
  { id: "WSL",     icon: <TerminalIcon className="w-7 h-7" />, color: "#0078d4" },
];

const DEFAULT_PORTS: Record<string, number> = {
  SSH: 22, Telnet: 23, Rlogin: 513, RDP: 3389, VNC: 5900,
  FTP: 21, SFTP: 22, Serial: 0, File: 0, Shell: 0,
  Browser: 0, Mosh: 60001, S3: 443, WSL: 0,
};

/** Map UI proto to the backend session_type string. */
function protoToSessionType(p: Proto): string {
  const map: Partial<Record<Proto, string>> = {
    Rlogin: "Telnet", File: "LocalShell", Shell: "LocalShell",
    Browser: "LocalShell", Mosh: "SSH", S3: "SFTP", WSL: "LocalShell",
  };
  return map[p] ?? p;
}

function sessionTypeToProto(type: string | undefined): Proto {
  if (type === "LocalShell") return "Shell";
  if (PROTOS.some((proto) => proto.id === type)) return type as Proto;
  return "SSH";
}

/* ------------------------------------------------------------------ */
/*  Helpers carried over from old implementation                       */
/* ------------------------------------------------------------------ */

function extractKeyPath(auth: AuthMethod | undefined): string {
  if (auth && typeof auth === "object" && "PrivateKey" in auth) {
    return auth.PrivateKey.key_path;
  }
  return "";
}

function extractAuthType(
  auth: AuthMethod | undefined,
): "Password" | "PrivateKey" | "Agent" | "None" {
  if (!auth) return "Password";
  if (typeof auth === "string") return auth as "Password" | "Agent" | "None";
  if (typeof auth === "object" && "PrivateKey" in auth) return "PrivateKey";
  return "Password";
}

function optionBoolean(options: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof options[key] === "boolean" ? options[key] : fallback;
}

function optionString(options: Record<string, unknown>, key: string, fallback: string): string {
  return typeof options[key] === "string" ? options[key] : fallback;
}

/* ------------------------------------------------------------------ */
/*  Tiny local UI primitives (match prototype)                         */
/* ------------------------------------------------------------------ */

function Checkbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      className="moba-checkbox"
      data-checked={checked}
      checked={checked}
      onChange={(event) => onChange?.(event.target.checked)}
    />
  );
}

function Radio({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange?: () => void;
}) {
  return (
    <input
      type="radio"
      className="moba-radio"
      checked={checked}
      onChange={onChange}
    />
  );
}

function Select({
  value,
  options,
  onChange,
  className = "",
}: {
  value: string;
  options: string[];
  onChange?: (v: string) => void;
  className?: string;
}) {
  return (
    <span className="relative inline-flex items-center">
      <select
        className={`moba-input pr-6 appearance-none ${className || "w-[260px]"}`}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
      <ChevronDown className="w-3 h-3 absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--moba-text-muted)]" />
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="col-span-3 text-[12px] text-right pt-1 text-[var(--moba-text)]">
        {label}
      </div>
      <div className="col-span-9 flex items-center flex-wrap gap-1">
        {children}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-panels                                                         */
/* ------------------------------------------------------------------ */

function AdvancedSshSettings({
  x11, setX11,
  compression, setCompression,
  startupCmd, setStartupCmd,
  doNotExit, setDoNotExit,
  remoteEnv, setRemoteEnv,
  sshBrowser, setSshBrowser,
  followPath, setFollowPath,
  osc7AutoInject, setOsc7AutoInject,
  authRadio, setAuthRadio,
  showPwd, setShowPwd,
  password, setPassword,
  usePrivKey, setUsePrivKey,
  keyPath, setKeyPath,
  useJump, setUseJump,
  jumpHost, setJumpHost,
  jumpUser, setJumpUser,
  jumpPort, setJumpPort,
  onBrowseKey,
}: {
  x11: boolean; setX11: (v: boolean) => void;
  compression: boolean; setCompression: (v: boolean) => void;
  startupCmd: string; setStartupCmd: (v: string) => void;
  doNotExit: boolean; setDoNotExit: (v: boolean) => void;
  remoteEnv: string; setRemoteEnv: (v: string) => void;
  sshBrowser: string; setSshBrowser: (v: string) => void;
  followPath: boolean; setFollowPath: (v: boolean) => void;
  osc7AutoInject: boolean; setOsc7AutoInject: (v: boolean) => void;
  authRadio: string; setAuthRadio: (v: string) => void;
  showPwd: boolean; setShowPwd: (v: boolean) => void;
  password: string; setPassword: (v: string) => void;
  usePrivKey: boolean; setUsePrivKey: (v: boolean) => void;
  keyPath: string; setKeyPath: (v: string) => void;
  useJump: boolean; setUseJump: (v: boolean) => void;
  jumpHost: string; setJumpHost: (v: string) => void;
  jumpUser: string; setJumpUser: (v: string) => void;
  jumpPort: string; setJumpPort: (v: string) => void;
  onBrowseKey: () => void;
}) {
  return (
    <div data-testid="advanced-ssh-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <Field label="X11-Forwarding">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={x11} onChange={setX11} />
          Enable
        </label>
        <span className="ml-3 text-[var(--moba-text-muted)]">
          Display: <span className="moba-mono">localhost:0.0</span>
        </span>
      </Field>

      <Field label="Compression">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={compression} onChange={setCompression} />
          Use SSH compression (slow links)
        </label>
      </Field>

      <Field label="Remote environment">
        <Select
          value={remoteEnv}
          options={[
            "Interactive shell", "LXDE / LXQt desktop", "Xfce desktop",
            "GNOME desktop", "KDE Plasma desktop", "Awesome WM", "Custom command…",
          ]}
          onChange={setRemoteEnv}
        />
      </Field>

      <Field label="Execute command">
        <input
          className="moba-input flex-1"
          placeholder="e.g.  tmux new -A -s main"
          value={startupCmd}
          aria-label="Execute command"
          onChange={(e) => setStartupCmd(e.target.value)}
        />
        <label className="ml-2 flex items-center gap-1.5">
          <Checkbox checked={doNotExit} onChange={setDoNotExit} />
          Do not exit after command ends
        </label>
      </Field>

      <Field label="SSH-browser type">
        <Select
          value={sshBrowser}
          options={[
            "SFTP protocol (recommended)", "SCP (enhanced speed)",
            "SCP (compatibility)", "Disabled",
          ]}
          onChange={setSshBrowser}
        />
        <label className="ml-3 flex items-center gap-1.5">
          <Checkbox checked={followPath} onChange={setFollowPath} />
          Follow SSH path (experimental)
        </label>
        <label
          className="ml-3 flex items-center gap-1.5"
          title="Inject a tiny PROMPT_COMMAND/precmd snippet so the SFTP browser can follow your shell's working directory."
        >
          <Checkbox checked={osc7AutoInject} onChange={setOsc7AutoInject} />
          Auto-inject OSC 7 cwd reporting
        </label>
      </Field>

      <Field label="Authentication">
        <div className="flex flex-col gap-1.5 w-full">
          <div className="flex items-center gap-2 flex-wrap">
            {(
              [
                ["password", "Password / keyboard-interactive"],
                ["privatekey", "Use private key"],
                ["agent", "ssh-agent / Pageant"],
                ["gssapi", "GSSAPI (Kerberos)"],
              ] as const
            ).map(([val, lbl]) => (
              <label key={val} className="flex items-center gap-1.5 cursor-pointer">
                <Radio
                  checked={authRadio === val}
                  onChange={() => setAuthRadio(val)}
                />
                {lbl}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2 pl-1">
            <span className="text-[var(--moba-text-muted)]">Password</span>
            <div className="relative">
              <input
                className="moba-input pr-7"
                type={showPwd ? "text" : "password"}
                value={password}
                aria-label="SSH password"
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5"
                onClick={() => setShowPwd(!showPwd)}
                title="Show / hide"
                type="button"
              >
                {showPwd
                  ? <EyeOff className="w-3.5 h-3.5 text-[var(--moba-text-muted)]" />
                  : <Eye className="w-3.5 h-3.5 text-[var(--moba-text-muted)]" />}
              </button>
            </div>
            <button className="moba-btn" type="button" disabled title="Credential vault is not implemented yet">Save in vault</button>
            <span className="moba-pill">
              <Shield className="w-3 h-3" /> Encrypted, master-password protected
            </span>
          </div>
        </div>
      </Field>

      <Field label="Private key">
        <Checkbox checked={usePrivKey} onChange={setUsePrivKey} />
        <input
          className="moba-input flex-1 ml-2"
          value={keyPath}
          onChange={(e) => setKeyPath(e.target.value)}
          disabled={!usePrivKey}
          aria-label="Private key path"
          placeholder="~/.ssh/id_ed25519"
        />
        <button className="moba-btn ml-1" disabled={!usePrivKey} onClick={onBrowseKey} type="button">
          Browse…
        </button>
        <button className="moba-btn ml-1" disabled type="button" title="Key generation backend is not implemented yet">
          Generate…
        </button>
      </Field>

      <Field label="Connect through SSH gateway (jump host)">
        <div className="flex flex-col gap-1.5 w-full">
          <label className="flex items-center gap-1.5">
            <Checkbox checked={useJump} onChange={setUseJump} /> Enable jump host
          </label>
          <div
            className="flex items-center gap-2 pl-1"
            style={{ opacity: useJump ? 1 : 0.5 }}
          >
            <span className="text-[var(--moba-text-muted)] w-16 text-right">Gateway</span>
            <input
              className="moba-input w-56"
              value={jumpHost}
              onChange={(e) => setJumpHost(e.target.value)}
              disabled={!useJump}
              aria-label="Jump host"
            />
            <span className="text-[var(--moba-text-muted)]">User</span>
            <input
              className="moba-input w-32"
              value={jumpUser}
              onChange={(e) => setJumpUser(e.target.value)}
              disabled={!useJump}
              aria-label="Jump user"
            />
            <span className="text-[var(--moba-text-muted)]">Port</span>
            <input
              className="moba-input w-16"
              value={jumpPort}
              onChange={(e) => setJumpPort(e.target.value)}
              disabled={!useJump}
              aria-label="Jump port"
            />
            <button className="moba-btn" disabled type="button" title="Jump-host connection testing is not implemented yet">
              Test chain…
            </button>
          </div>
        </div>
      </Field>

      <Field label="Expert SSH settings">
        <button className="moba-btn" type="button" disabled title="Expert SSH settings are not implemented yet">Open expert settings…</button>
        <span className="ml-2 text-[var(--moba-text-muted)]">
          SSH protocol version, ciphers, MACs, keep-alive, X11 trusted, agent forwarding…
        </span>
      </Field>
    </div>
  );
}

function TerminalSettings({
  profile,
  onProfileChange,
}: {
  profile: TerminalProfile;
  onProfileChange: (profile: TerminalProfile) => void;
}) {
  return (
    <div data-testid="terminal-settings" className="text-[12px]">
      <TerminalAppearanceSettings
        profile={profile}
        onProfileChange={onProfileChange}
        showCustomColors
      />
    </div>
  );
}

function NetworkSettings({
  value,
  onChange,
  sessionConfigId,
}: {
  value: NetworkSettingsValue;
  onChange: (next: NetworkSettingsValue) => void;
  /** When set, the Network tab subscribes to runtime forward errors
   *  for this saved session and renders the latest failure inline next
   *  to the offending row. */
  sessionConfigId?: string;
}) {
  const [newFwdLocal, setNewFwdLocal] = useState("");
  const [newFwdRemote, setNewFwdRemote] = useState("");
  const [newFwdDesc, setNewFwdDesc] = useState("");
  // Per-row latest forward error, keyed by `${local}->${remote}`.
  const [forwardErrors, setForwardErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!sessionConfigId) return;
    const onErr = (ev: Event) => {
      const detail = (ev as CustomEvent<{
        sessionConfigId: string;
        local: string;
        remote: string;
        message: string;
      }>).detail;
      if (!detail || detail.sessionConfigId !== sessionConfigId) return;
      setForwardErrors((m) => ({
        ...m,
        [`${detail.local}->${detail.remote}`]: detail.message,
      }));
    };
    window.addEventListener("newmob:forward-error", onErr as EventListener);
    return () => window.removeEventListener("newmob:forward-error", onErr as EventListener);
  }, [sessionConfigId]);

  const patch = (delta: Partial<NetworkSettingsValue>) => onChange({ ...value, ...delta });
  const proxy = proxyKindToLabel(value.proxyKind);
  const proxyHost = value.proxyHost;
  const proxyPort = value.proxyPort;
  const proxyUser = value.proxyUser;
  const proxyPass = value.proxyPass;
  const proxySave = value.proxySaveAuth;
  const keepAlive = value.keepAlive;
  const keepAliveInterval = value.keepAliveIntervalSecs;
  const tcpNodelay = value.tcpNodelay;
  const disableNagle = value.disableNagle;
  const ipVersion = ipKindToLabel(value.ipVersion);
  const forwards = value.localForwards;

  const setProxy = (label: string) => patch({ proxyKind: proxyLabelToKind(label) });
  const setProxyHost = (v: string) => patch({ proxyHost: v });
  const setProxyPort = (v: string) => patch({ proxyPort: v });
  const setProxyUser = (v: string) => patch({ proxyUser: v });
  const setProxyPass = (v: string) => patch({ proxyPass: v });
  const setProxySave = (v: boolean) => patch({ proxySaveAuth: v });
  const setKeepAlive = (v: boolean) => patch({ keepAlive: v });
  const setKeepAliveInterval = (v: string) => patch({ keepAliveIntervalSecs: v });
  const setTcpNodelay = (v: boolean) => patch({ tcpNodelay: v });
  const setDisableNagle = (v: boolean) => patch({ disableNagle: v });
  const setIpVersion = (label: string) => patch({ ipVersion: ipLabelToKind(label) });
  const setForwards = (
    updater: (items: NetworkSettingsValue["localForwards"]) => NetworkSettingsValue["localForwards"],
  ) => patch({ localForwards: updater(value.localForwards) });

  const addForward = () => {
    if (!newFwdLocal.trim() || !newFwdRemote.trim()) return;
    setForwards((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        local: newFwdLocal.trim(),
        remote: newFwdRemote.trim(),
        desc: newFwdDesc.trim(),
      },
    ]);
    setNewFwdLocal("");
    setNewFwdRemote("");
    setNewFwdDesc("");
  };

  return (
    <div data-testid="network-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <Field label="Proxy">
        <Select
          value={proxy}
          options={[
            "None — direct connection", "HTTP CONNECT", "SOCKS 4",
            "SOCKS 5", "Local SSH tunnel", "System proxy",
          ]}
          onChange={setProxy}
        />
      </Field>

      <Field label="Proxy host">
        <input
          className="moba-input w-64"
          placeholder="proxy.corp.lan"
          value={proxyHost}
          aria-label="Proxy host"
          onChange={(e) => setProxyHost(e.target.value)}
        />
        <span className="text-[var(--moba-text-muted)] ml-2">Port</span>
        <input
          className="moba-input w-16 ml-1"
          placeholder="3128"
          value={proxyPort}
          aria-label="Proxy port"
          onChange={(e) => setProxyPort(e.target.value)}
        />
      </Field>

      <Field label="Proxy auth">
        <input
          className="moba-input w-32"
          placeholder="username"
          value={proxyUser}
          aria-label="Proxy username"
          onChange={(e) => setProxyUser(e.target.value)}
        />
        <input
          className="moba-input w-40 ml-1"
          type="password"
          placeholder="password"
          value={proxyPass}
          aria-label="Proxy password"
          onChange={(e) => setProxyPass(e.target.value)}
        />
        <label className="ml-2 flex items-center gap-1.5">
          <Checkbox checked={proxySave} onChange={setProxySave} /> Save in vault
        </label>
      </Field>

      <Field label="Keep-alive">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={keepAlive} onChange={setKeepAlive} />
          Send
        </label>
        <input
          className="moba-input w-16 ml-1"
          value={keepAliveInterval}
          aria-label="Keep-alive interval"
          onChange={(e) => setKeepAliveInterval(e.target.value)}
        />
        <span className="ml-1">s null packets</span>
      </Field>

      <Field label="TCP options">
        <label className="flex items-center gap-1.5">
          <Checkbox
            checked={tcpNodelay}
            onChange={(v) => patch({ tcpNodelay: v, disableNagle: v })}
          /> TCP_NODELAY
        </label>
        <label className="ml-3 flex items-center gap-1.5">
          <Checkbox
            checked={disableNagle}
            onChange={(v) => patch({ disableNagle: v, tcpNodelay: v })}
          /> Disable Nagle algorithm
        </label>
      </Field>

      <Field label="IP version">
        <Select
          value={ipVersion}
          options={["Auto (prefer IPv4)", "Force IPv4", "Force IPv6"]}
          onChange={setIpVersion}
        />
      </Field>

      <Field label="Local port forwarding">
        <div className="flex flex-col gap-1 w-full">
          <div className="flex items-center gap-1.5 text-[var(--moba-text-muted)]">
            <span className="w-32">Local address:port</span>
            <span className="w-32">→ Remote address:port</span>
            <span>Description</span>
          </div>
          {forwards.map((forward) => {
            const errKey = `${forward.local.trim()}->${forward.remote.trim()}`;
            const rowError = forwardErrors[errKey];
            return (
              <div key={forward.id} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <input
                    className="moba-input w-32"
                    value={forward.local}
                    aria-label="Forward local address"
                    onChange={(e) =>
                      setForwards((items) =>
                        items.map((item) => item.id === forward.id ? { ...item, local: e.target.value } : item),
                      )
                    }
                  />
                  <input
                    className="moba-input w-40"
                    value={forward.remote}
                    aria-label="Forward remote address"
                    onChange={(e) =>
                      setForwards((items) =>
                        items.map((item) => item.id === forward.id ? { ...item, remote: e.target.value } : item),
                      )
                    }
                  />
                  <input
                    className="moba-input flex-1"
                    value={forward.desc}
                    aria-label="Forward description"
                    onChange={(e) =>
                      setForwards((items) =>
                        items.map((item) => item.id === forward.id ? { ...item, desc: e.target.value } : item),
                      )
                    }
                  />
                  <button className="moba-btn" type="button" onClick={() => setForwards((items) => items.filter((item) => item.id !== forward.id))}>
                    Remove
                  </button>
                </div>
                {rowError && (
                  <div
                    className="text-[11px] text-red-400 ml-[2px]"
                    role="status"
                    data-testid={`forward-row-error-${forward.id}`}
                  >
                    {rowError}
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex items-center gap-1.5">
            <input className="moba-input w-32" placeholder="127.0.0.1:9090" value={newFwdLocal} aria-label="New forward local address" onChange={(e) => setNewFwdLocal(e.target.value)} />
            <input className="moba-input w-40" placeholder="metrics.lan:9090" value={newFwdRemote} aria-label="New forward remote address" onChange={(e) => setNewFwdRemote(e.target.value)} />
            <input className="moba-input flex-1" placeholder="Description" value={newFwdDesc} aria-label="New forward description" onChange={(e) => setNewFwdDesc(e.target.value)} />
            <button className="moba-btn" type="button" onClick={addForward} disabled={!newFwdLocal.trim() || !newFwdRemote.trim()}>Add</button>
          </div>
        </div>
      </Field>
    </div>
  );
}

function BookmarkSettings({
  name, setName,
  groupPath, setGroupPath,
  folderOptions,
  description, setDescription,
  tags, setTags,
  proto,
  onNewFolder,
}: {
  name: string; setName: (v: string) => void;
  groupPath: string; setGroupPath: (v: string) => void;
  folderOptions: string[];
  description: string; setDescription: (v: string) => void;
  tags: string; setTags: (v: string) => void;
  proto: Proto;
  onNewFolder: () => void;
}) {
  const [bgImage, setBgImage] = useState("");
  const [bgOpacity, setBgOpacity] = useState("35%");
  const [autoConnect, setAutoConnect] = useState(true);
  const [openNewWindow, setOpenNewWindow] = useState(false);
  const [reconnect, setReconnect] = useState(true);
  const [shortcut, setShortcut] = useState("");

  return (
    <div data-testid="bookmark-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <Field label="Session name">
        <input
          data-testid="session-name"
          className="moba-input w-72"
          value={name}
          aria-label="Session name"
          onChange={(e) => setName(e.target.value)}
        />
        <span className="ml-2 text-[var(--moba-text-muted)]">(shown in sidebar and tabs)</span>
      </Field>

      <Field label="Session folder">
        <Select
          value={groupPath || "User sessions"}
          className="w-[260px]"
          options={folderOptions}
          onChange={(value) => setGroupPath(value === "User sessions" ? "" : value)}
        />
        <button className="moba-btn ml-2 flex items-center gap-1" type="button" onClick={onNewFolder}>
          <FolderPlus className="w-3 h-3" /> New folder
        </button>
      </Field>

      <Field label="Session icon">
        <span
          className="inline-flex items-center gap-1 px-2 py-1 rounded border"
          style={{ borderColor: "var(--moba-input-border)", background: "var(--moba-input-bg)" }}
        >
          <TerminalIcon className="w-4 h-4" style={{ color: "#2b5d8b" }} />
          {proto.toLowerCase()}
        </span>
        <button className="moba-btn ml-2" type="button" disabled title="Custom icons are not implemented yet">Change…</button>
      </Field>

      <Field label="Background image">
        <input
          className="moba-input flex-1"
          placeholder="(none)"
          value={bgImage}
          aria-label="Background image"
          onChange={(e) => setBgImage(e.target.value)}
        />
        <button className="moba-btn ml-1" type="button" disabled title="Background images are not implemented yet">Browse…</button>
        <span className="ml-2 text-[var(--moba-text-muted)]">Opacity</span>
        <input
          className="moba-input w-16 ml-1"
          value={bgOpacity}
          aria-label="Background opacity"
          onChange={(e) => setBgOpacity(e.target.value)}
        />
      </Field>

      <Field label="Description / notes">
        <textarea
          className="moba-input flex-1"
          style={{ height: 56, padding: 6 }}
          value={description}
          aria-label="Description notes"
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Notes about this session…"
        />
      </Field>

      <Field label="Tags">
        <input
          className="moba-input flex-1"
          value={tags}
          aria-label="Tags"
          onChange={(e) => setTags(e.target.value)}
          placeholder="prod, web, on-call"
        />
      </Field>

      <Field label="Behavior on startup">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={autoConnect} onChange={setAutoConnect} />
          Auto-connect when MobaXterm starts
        </label>
        <label className="ml-3 flex items-center gap-1.5">
          <Checkbox checked={openNewWindow} onChange={setOpenNewWindow} />
          Open in new window
        </label>
        <label className="ml-3 flex items-center gap-1.5">
          <Checkbox checked={reconnect} onChange={setReconnect} />
          Reconnect on disconnection
        </label>
      </Field>

      <Field label="Keyboard shortcut">
        <input
          className="moba-input w-40"
          value={shortcut}
          aria-label="Keyboard shortcut"
          onChange={(e) => setShortcut(e.target.value)}
          placeholder="Ctrl+Alt+1"
        />
        <span className="ml-2 text-[var(--moba-text-muted)]">
          Click then press a key combination
        </span>
      </Field>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

interface SessionEditorProps {
  session?: SessionConfig;
  defaultGroupPath?: string | null;
  /**
   * Pre-select the protocol when creating a *new* session (no `session`
   * prop). Accepts a session-type string (e.g. `"SFTP"`, `"SSH"`); falls
   * back to SSH if unrecognized. Ignored when editing an existing session.
   */
  initialProto?: string;
  onClose: () => void;
}

export function SessionEditor({ session, defaultGroupPath = null, initialProto, onClose }: SessionEditorProps) {
  const { addSession, updateSession, removeSession, createFolderPath, sessions, groups } = useSessionStore();
  const isEdit = !!session;

  const initialOptions = useMemo(() => parseSessionOptions(session?.options_json), [session?.options_json]);

  /* --- core fields --- */
  const [proto, setProto] = useState<Proto>(
    session ? sessionTypeToProto(session.session_type) : sessionTypeToProto(initialProto),
  );
  const [section, setSection] = useState<SectionTab>("advanced");
  const [name, setName] = useState(session?.name ?? "");
  const [host, setHost] = useState(session?.host ?? "");
  const [port, setPort] = useState(
    String(session?.port ?? DEFAULT_PORTS["SSH"]),
  );
  const [username, setUsername] = useState(session?.username ?? "");
  const [specifyUser, setSpecifyUser] = useState(!!session?.username);
  const [groupPath, setGroupPath] = useState(
    toStoredGroupPath(session?.group_path ?? defaultGroupPath) ?? "",
  );

  /* --- auth --- */
  const [authMethod, setAuthMethod] = useState(
    extractAuthType(session?.auth_method),
  );
  const [authRadio, setAuthRadio] = useState<string>(() => {
    const t = extractAuthType(session?.auth_method);
    if (t === "PrivateKey") return "privatekey";
    if (t === "Agent") return "agent";
    if (t === "None") return "gssapi";
    return "password";
  });
  const [keyPath, setKeyPath] = useState(
    extractKeyPath(session?.auth_method),
  );
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);

  /* --- advanced SSH --- */
  const [x11, setX11] = useState(() => optionBoolean(initialOptions, "x11", true));
  const [compression, setCompression] = useState(() => optionBoolean(initialOptions, "compression", false));
  const [startupCmd, setStartupCmd] = useState(() => optionString(initialOptions, "startupCmd", ""));
  const [doNotExit, setDoNotExit] = useState(() => optionBoolean(initialOptions, "doNotExit", false));
  const [remoteEnv, setRemoteEnv] = useState(() => optionString(initialOptions, "remoteEnv", "Interactive shell"));
  const [sshBrowser, setSshBrowser] = useState(() => optionString(initialOptions, "sshBrowser", "SFTP protocol (recommended)"));
  const [followPath, setFollowPath] = useState(() => optionBoolean(initialOptions, "followPath", true));
  const [osc7AutoInject, setOsc7AutoInject] = useState(() => optionBoolean(initialOptions, "osc7AutoInject", true));
  const [usePrivKey, setUsePrivKey] = useState(
    extractAuthType(session?.auth_method) === "PrivateKey",
  );
  const [useJump, setUseJump] = useState(() => optionBoolean(initialOptions, "useJump", false));
  const [jumpHost, setJumpHost] = useState(() => optionString(initialOptions, "jumpHost", ""));
  const [jumpUser, setJumpUser] = useState(() => optionString(initialOptions, "jumpUser", ""));
  const [jumpPort, setJumpPort] = useState(() => optionString(initialOptions, "jumpPort", "22"));

  /* --- bookmark --- */
  const [description, setDescription] = useState(() => optionString(initialOptions, "description", ""));
  const [tags, setTags] = useState(() => optionString(initialOptions, "tags", ""));

  /* --- terminal profile --- */
  const [terminalProfile, setTerminalProfile] = useState<TerminalProfile>(() =>
    getSessionTerminalProfile(session?.options_json) ?? loadGlobalTerminalProfile(),
  );

  /* --- network settings --- */
  const [networkSettings, setNetworkSettings] = useState<NetworkSettingsValue>(
    () => getSessionNetworkSettings(session?.options_json),
  );

  /* --- test connection --- */
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /* --- derived --- */
  const needsHost = !["Serial", "File", "Shell", "WSL"].includes(proto);
  const isSSH = ["SSH", "SFTP"].includes(proto);
  const folderOptions = useMemo(() => {
    const options = new Set<string>([
      SESSION_ROOT_LABEL,
      "User sessions / Production",
      "User sessions / Development",
      "User sessions / Quick & local",
    ]);

    for (const path of collectFolderPaths(sessions, groups)) {
      options.add(folderOptionLabel(path));
    }

    if (groupPath) {
      options.add(folderOptionLabel(groupPath));
    }

    return [...options].sort((a, b) => {
      if (a === SESSION_ROOT_LABEL) return -1;
      if (b === SESSION_ROOT_LABEL) return 1;
      return a.localeCompare(b);
    });
  }, [groupPath, groups, sessions]);

  const handleProtoChange = (p: Proto) => {
    setProto(p);
    setPort(String(DEFAULT_PORTS[p] ?? 22));
  };

  /* Keep authMethod in sync with the radio group */
  const handleAuthRadio = (v: string) => {
    setAuthRadio(v);
    if (v === "password") {
      setAuthMethod("Password");
      setUsePrivKey(false);
    } else if (v === "privatekey") {
      setAuthMethod("PrivateKey");
      setUsePrivKey(true);
    } else if (v === "agent") {
      setAuthMethod("Agent");
      setUsePrivKey(false);
    } else {
      setAuthMethod("None");
      setUsePrivKey(false);
    }
  };

  const buildConfig = (overrides: Partial<SessionConfig> = {}): SessionConfig => {
    const now = Math.floor(Date.now() / 1000);
    const previousOptions = parseSessionOptions(session?.options_json);
    let auth: AuthMethod = "Password";
    if (authMethod === "PrivateKey")
      auth = { PrivateKey: { key_path: keyPath || "~/.ssh/id_ed25519" } };
    else if (authMethod === "Agent") auth = "Agent";
    else if (authMethod === "None") auth = "None";

    const displayName = name || (host ? `${username ? username + "@" : ""}${host}` : "Local terminal");
    return {
      id: session?.id ?? crypto.randomUUID(),
      name: displayName,
      session_type: protoToSessionType(proto),
      group_path: toStoredGroupPath(groupPath),
      host,
      port: parseInt(port) || DEFAULT_PORTS[proto] || 0,
      username: username || null,
      auth_method: auth,
      options_json: JSON.stringify({
        ...previousOptions,
        x11, compression, startupCmd, jumpHost: jumpHost || "",
        jumpUser, jumpPort, description, tags, doNotExit,
        remoteEnv, sshBrowser, followPath, osc7AutoInject, usePrivKey, useJump,
        terminalProfile,
        // Strip the proxy password unless the user explicitly opted into
        // "Save in vault". `options_json` lands in the SQLite session row
        // in plaintext, so this is the gate keeping secrets out at rest.
        networkSettings: networkSettings.proxySaveAuth
          ? networkSettings
          : { ...networkSettings, proxyPass: "" },
      }),
      created_at: session?.created_at ?? now,
      updated_at: now,
      last_connected_at: session?.last_connected_at ?? null,
      sort_order: session?.sort_order ?? 0,
      ...overrides,
    };
  };

  const validate = () => {
    if (needsHost && !host.trim()) return "Remote host is required.";
    if (isSSH && specifyUser && !username.trim()) return "Username is enabled but empty.";
    if (authMethod === "PrivateKey" && !keyPath.trim()) return "Private key path is required.";
    return null;
  };

  const handleSave = async () => {
    const error = validate();
    if (error) {
      setSaveError(error);
      return;
    }
    setSaveError(null);
    const config = buildConfig();

    if (isEdit) {
      await updateSession(config);
    } else {
      await addSession(config);
    }
    onClose();
  };

  const handleSaveTemplate = async () => {
    const error = validate();
    if (error) {
      setSaveError(error);
      return;
    }
    const config = buildConfig({
      id: crypto.randomUUID(),
      name: `${name || host || proto} template`,
      group_path: "Templates",
      last_connected_at: null,
    });
    await addSession(config);
    setTestResult({ ok: true, msg: "Template saved" });
  };

  const handleReset = () => {
    const nextOptions = parseSessionOptions(session?.options_json);
    const nextProto = sessionTypeToProto(session?.session_type);
    setProto(nextProto);
    setSection("advanced");
    setName(session?.name ?? "");
    setHost(session?.host ?? "");
    setPort(String(session?.port ?? DEFAULT_PORTS[nextProto] ?? 22));
    setUsername(session?.username ?? "");
    setSpecifyUser(!!session?.username);
    setGroupPath(toStoredGroupPath(session?.group_path ?? defaultGroupPath) ?? "");
    const nextAuth = extractAuthType(session?.auth_method);
    setAuthMethod(nextAuth);
    setAuthRadio(nextAuth === "PrivateKey" ? "privatekey" : nextAuth === "Agent" ? "agent" : nextAuth === "None" ? "gssapi" : "password");
    setKeyPath(extractKeyPath(session?.auth_method));
    setPassword("");
    setShowPwd(false);
    setX11(optionBoolean(nextOptions, "x11", true));
    setCompression(optionBoolean(nextOptions, "compression", false));
    setStartupCmd(optionString(nextOptions, "startupCmd", ""));
    setDoNotExit(optionBoolean(nextOptions, "doNotExit", false));
    setRemoteEnv(optionString(nextOptions, "remoteEnv", "Interactive shell"));
    setSshBrowser(optionString(nextOptions, "sshBrowser", "SFTP protocol (recommended)"));
    setFollowPath(optionBoolean(nextOptions, "followPath", true));
    setOsc7AutoInject(optionBoolean(nextOptions, "osc7AutoInject", true));
    setUsePrivKey(nextAuth === "PrivateKey");
    setUseJump(optionBoolean(nextOptions, "useJump", false));
    setJumpHost(optionString(nextOptions, "jumpHost", ""));
    setJumpUser(optionString(nextOptions, "jumpUser", ""));
    setJumpPort(optionString(nextOptions, "jumpPort", "22"));
    setDescription(optionString(nextOptions, "description", ""));
    setTags(optionString(nextOptions, "tags", ""));
    setTerminalProfile(getSessionTerminalProfile(session?.options_json) ?? loadGlobalTerminalProfile());
    setNetworkSettings(getSessionNetworkSettings(session?.options_json));
    setSaveError(null);
    setTestResult(null);
  };

  const handleHostLookup = () => {
    let parsed: ReturnType<typeof parseUserHostPort> = null;
    try {
      parsed = parseUserHostPort(host);
    } catch {
      parsed = null;
    }
    if (!parsed) return;
    setHost(parsed.host);
    if (parsed.username) {
      setUsername(parsed.username);
      setSpecifyUser(true);
    }
    if (parsed.port) setPort(String(parsed.port));
  };

  const handleBrowseKey = () => {
    const next = window.prompt("Private key path", keyPath || "~/.ssh/id_ed25519");
    if (next !== null) {
      setKeyPath(next.trim());
      setUsePrivKey(true);
      handleAuthRadio("privatekey");
    }
  };

  const handleNewFolder = () => {
    const next = window.prompt("New session folder", groupPath || "User sessions / New folder");
    const normalized = normalizeGroupPath(next);
    if (!normalized) return;
    setGroupPath(toStoredGroupPath(normalized) ?? "");
    void createFolderPath(normalized);
  };

  const handleDelete = async () => {
    if (session) {
      await removeSession(session.id);
      onClose();
    }
  };

  const handleTestConnection = async () => {
    if (!host || !username) {
      setTestResult({ ok: false, msg: "Host and username are required" });
      return;
    }
    if (authMethod === "Password" && !password) {
      setTestResult({ ok: false, msg: "Enter password above to test" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      let authData: string | null = null;
      if (authMethod === "Password") authData = password;
      else if (authMethod === "PrivateKey")
        authData = keyPath || "~/.ssh/id_ed25519";
      const msg = await testSshConnection(
        host,
        parseInt(port) || 22,
        username,
        authMethod,
        authData,
        JSON.stringify(toNetworkSettingsPayload(networkSettings)),
      );
      setTestResult({ ok: true, msg });
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const sectionTabs: { id: SectionTab; label: string; icon: React.ReactNode }[] = [
    ...(isSSH
      ? [{ id: "advanced" as SectionTab, label: "Advanced SSH settings", icon: <Shield className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
      : []),
    { id: "terminal", label: "Terminal settings", icon: <TerminalIcon className="w-3 h-3 inline -mt-0.5 mr-1" /> },
    { id: "network",  label: "Network settings",  icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> },
    { id: "bookmark", label: "Bookmark settings",  icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
  ];

  /* If we switched away from SSH and were on the advanced tab, fall back */
  const activeSection =
    section === "advanced" && !isSSH ? "terminal" : section;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(20,30,45,0.4)" }}
    >
      <div
        data-testid="session-editor"
        className="w-[1020px] max-w-[96%] max-h-[92vh] flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{ background: "var(--moba-panel-bg)", borderColor: "var(--moba-chrome-border)", color: "var(--moba-text)" }}
      >
        {/* Modal title bar */}
        <div
          className="h-7 flex items-center px-2 rounded-t-[5px] shrink-0"
          style={{
            background: "linear-gradient(to bottom,#5895c8,#2b5d8b)",
            color: "white",
          }}
        >
          <Bookmark className="w-3.5 h-3.5 mr-1.5" />
          <div className="text-[12px] font-semibold">
            {isEdit ? "Edit session" : "Session settings"}
          </div>
          <div className="ml-auto flex items-center gap-2 text-[11px] opacity-95">
            <AppThemeSwitcher compact />
            <button
              title="Help"
              className="hover:bg-white/15 rounded p-0.5"
              onClick={() => setTestResult({ ok: true, msg: "Fill required fields, then OK to save this session." })}
              type="button"
            >
              <HelpCircle className="w-3.5 h-3.5" />
            </button>
            <button
              title="Close"
              className="hover:bg-red-500 rounded p-0.5"
              onClick={onClose}
              type="button"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Protocol picker */}
        <div
          className="px-3 pt-3 pb-2 border-b shrink-0"
          style={{ borderColor: "var(--moba-divider)" }}
        >
          <div className="flex flex-wrap gap-1">
            {PROTOS.map((p) => (
              <button
                key={p.id}
                data-testid={`session-proto-${p.id.toLowerCase()}`}
                className="moba-proto-btn"
                data-active={proto === p.id}
                onClick={() => handleProtoChange(p.id)}
                type="button"
              >
                <span
                  style={{
                    color: proto === p.id ? "var(--moba-accent)" : p.color,
                  }}
                >
                  {p.icon}
                </span>
                <span>{p.id}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Basic settings (blue header) */}
        {needsHost && (
          <div
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--moba-accent)" }}
            >
              <TerminalIcon className="w-3.5 h-3.5" />
              Basic {proto} settings
            </div>
            <div className="grid grid-cols-12 gap-2 items-center">
              <label className="col-span-2 text-[12px] text-right">
                Remote host *
              </label>
              <div className="col-span-5 flex items-center gap-1">
                <input
                  data-testid="session-host"
                  className="moba-input flex-1"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onBlur={handleHostLookup}
                  aria-label="Remote host"
                  placeholder="hostname or IP"
                />
                <button
                  title="Lookup"
                  className="moba-btn px-2"
                  onClick={handleHostLookup}
                  type="button"
                >
                  <Search className="w-3 h-3 inline -mt-0.5" />
                </button>
              </div>
              <label className="col-span-3 text-[12px] flex items-center gap-1.5 justify-end">
                <Checkbox checked={specifyUser} onChange={setSpecifyUser} />
                <span>Specify username</span>
              </label>
              <input
                data-testid="session-user"
                className="moba-input col-span-2"
                value={username}
                disabled={!specifyUser}
                onChange={(e) => setUsername(e.target.value)}
                aria-label="Username"
                placeholder="root"
              />

              <label className="col-span-2 text-[12px] text-right">Port</label>
              <input
                data-testid="session-port"
                className="moba-input col-span-2"
                value={port}
                aria-label="Port"
                onChange={(e) => setPort(e.target.value)}
              />
              <div className="col-span-8 text-[11px] text-[var(--moba-text-muted)]">
                Tip: append{" "}
                <span
                  className="moba-mono px-1 border rounded"
                  style={{ background: "var(--moba-input-bg)", borderColor: "var(--moba-divider)" }}
                >
                  user@host:port
                </span>{" "}
                to autofill these three fields.
              </div>
            </div>
          </div>
        )}

        {/* Section tabs */}
        <div className="px-3 pt-2 flex shrink-0" style={{ background: "transparent" }}>
          {sectionTabs.map((t) => (
            <button
              key={t.id}
              data-testid={`session-section-${t.id}`}
              className="moba-section-tab"
              data-active={activeSection === t.id}
              onClick={() => setSection(t.id)}
              type="button"
            >
              {t.icon}
              {t.label}
            </button>
          ))}
          <div className="flex-1 border-b" style={{ borderColor: "var(--moba-input-border)" }} />
        </div>

        {/* Section body */}
        <div
          className="flex-1 min-h-0 overflow-auto px-4 py-3 border-x border-b"
          style={{ borderColor: "var(--moba-input-border)", background: "var(--moba-bg)" }}
        >
          {activeSection === "advanced" && isSSH && (
            <AdvancedSshSettings
              x11={x11} setX11={setX11}
              compression={compression} setCompression={setCompression}
              startupCmd={startupCmd} setStartupCmd={setStartupCmd}
              doNotExit={doNotExit} setDoNotExit={setDoNotExit}
              remoteEnv={remoteEnv} setRemoteEnv={setRemoteEnv}
              sshBrowser={sshBrowser} setSshBrowser={setSshBrowser}
              followPath={followPath} setFollowPath={setFollowPath}
              osc7AutoInject={osc7AutoInject} setOsc7AutoInject={setOsc7AutoInject}
              authRadio={authRadio} setAuthRadio={handleAuthRadio}
              showPwd={showPwd} setShowPwd={setShowPwd}
              password={password} setPassword={setPassword}
              usePrivKey={usePrivKey} setUsePrivKey={(value) => {
                if (value) {
                  handleAuthRadio("privatekey");
                } else {
                  handleAuthRadio("password");
                }
              }}
              keyPath={keyPath} setKeyPath={setKeyPath}
              useJump={useJump} setUseJump={setUseJump}
              jumpHost={jumpHost} setJumpHost={setJumpHost}
              jumpUser={jumpUser} setJumpUser={setJumpUser}
              jumpPort={jumpPort} setJumpPort={setJumpPort}
              onBrowseKey={handleBrowseKey}
            />
          )}

          {activeSection === "terminal" && (
            <TerminalSettings profile={terminalProfile} onProfileChange={setTerminalProfile} />
          )}
          {activeSection === "network" && (
            <NetworkSettings
              value={networkSettings}
              onChange={setNetworkSettings}
              sessionConfigId={session?.id}
            />
          )}
          {activeSection === "bookmark" && (
            <BookmarkSettings
              name={name} setName={setName}
              groupPath={groupPath} setGroupPath={setGroupPath}
              folderOptions={folderOptions}
              description={description} setDescription={setDescription}
              tags={tags} setTags={setTags}
              proto={proto}
              onNewFolder={handleNewFolder}
            />
          )}
        </div>

        {/* Footer */}
        <div
          className="h-12 flex items-center px-3 gap-2 border-t shrink-0"
          style={{ background: "var(--moba-quick-bg)", borderColor: "var(--moba-divider)" }}
        >
          {isSSH && needsHost && (
            <button
              className="moba-btn flex items-center gap-1.5"
              onClick={handleTestConnection}
              disabled={testing}
              type="button"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              {testing ? "Testing…" : "Test connection"}
            </button>
          )}
          <button className="moba-btn flex items-center gap-1.5" type="button" onClick={() => void handleSaveTemplate()}>
            <Save className="w-3.5 h-3.5" /> Save as template…
          </button>
          <button className="moba-btn flex items-center gap-1.5" type="button" onClick={handleReset}>
            <RotateCcw className="w-3.5 h-3.5" /> Reset
          </button>

          {(testResult || saveError) && (
            <span
              className="text-[11px]"
              style={{ color: testResult?.ok && !saveError ? "#2f8a3e" : "#b22222" }}
            >
              {saveError ?? testResult?.msg}
            </span>
          )}

          <span className="ml-2 text-[11px] text-[var(--moba-text-muted)]">
            Will be saved to{" "}
            <span className="moba-mono">
              {groupPath ? folderOptionLabel(groupPath) : SESSION_ROOT_LABEL} / {name || host || "..."}
            </span>
          </span>

          <div className="flex-1" />

          {isEdit && (
            <button
              className="moba-btn"
              onClick={handleDelete}
              type="button"
              style={{ color: "#b22222" }}
            >
              Delete
            </button>
          )}
          <button className="moba-btn" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="moba-btn"
            data-testid="session-save"
            data-primary="true"
            onClick={handleSave}
            type="button"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
