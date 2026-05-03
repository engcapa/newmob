import {
  Terminal as TerminalIcon,
  Plus,
  Shield,
  Upload,
  RefreshCw,
  Activity,
  ScrollText,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseOpenSshConfig } from "../lib/quickConnect";
import { listLocalShells, openLocalShellAsAdministrator, type LocalShellOption } from "../lib/ipc";
import { AppThemeIconButton } from "./settings/AppThemeSwitcher";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import type { LocalShellSelection } from "../types";

interface WelcomePanelProps {
  onStartLocalTerminal: (shell?: LocalShellSelection) => void;
  onNewSession: () => void;
}

export function WelcomePanel({ onStartLocalTerminal, onNewSession }: WelcomePanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [localShells, setLocalShells] = useState<LocalShellOption[]>([]);
  const [selectedShellId, setSelectedShellId] = useState("");
  const [shellStatus, setShellStatus] = useState<"loading" | "ready" | "error">("loading");
  const { tabs, setStatusMessage } = useAppStore();
  const { sessions, addSession, loadSessions } = useSessionStore();
  const activeConnections = tabs.filter((tab) => tab.type === "terminal" && tab.closable);
  const recentEvents = sessions
    .slice()
    .sort((a, b) => Math.max(b.updated_at, b.last_connected_at ?? 0) - Math.max(a.updated_at, a.last_connected_at ?? 0))
    .slice(0, 5);

  useEffect(() => {
    let cancelled = false;

    listLocalShells()
      .then((shells) => {
        if (cancelled) return;
        setLocalShells(shells);
        setSelectedShellId(shells.find((shell) => shell.isDefault)?.id ?? shells[0]?.id ?? "");
        setShellStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setShellStatus("error");
        setStatusMessage(`Local shell detection failed: ${String(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [setStatusMessage]);

  const selectedShell = useMemo(
    () => localShells.find((shell) => shell.id === selectedShellId),
    [localShells, selectedShellId],
  );

  const handleStartAsAdministrator = async () => {
    try {
      await openLocalShellAsAdministrator(selectedShell?.id);
      setStatusMessage(`Requested administrator terminal for ${selectedShell?.name ?? "local shell"}`);
    } catch (error) {
      setStatusMessage(`Administrator terminal failed: ${String(error)}`);
    }
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const text = await file.text();
    const imported = parseOpenSshConfig(text);
    for (const session of imported) {
      await addSession(session);
    }
    setStatusMessage(`Imported ${imported.length} SSH session${imported.length === 1 ? "" : "s"}`);
  };

  return (
    <div className="w-full h-full flex" style={{ background: "var(--moba-bg)" }}>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".config,.txt,*"
        onChange={(event) => void handleImport(event)}
      />
      <div data-testid="welcome-panel" className="flex-1 overflow-auto px-6 py-8 flex justify-center">
        <div className="w-full max-w-4xl">
          <div className="flex items-center gap-3 mb-4">
            <div
              className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-xl"
              style={{ background: "linear-gradient(135deg, #1e5fa8, #62d36f)" }}
            >
              N
            </div>
            <div>
              <div className="text-xl font-semibold">Welcome to NewMob</div>
              <div className="text-[12px] text-[var(--moba-text-muted)]">
                A cross‑platform port of the MobaXterm experience — Linux • macOS • Windows
              </div>
            </div>
            <div className="ml-auto">
              <AppThemeIconButton />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <LocalTerminalCard
              shells={localShells}
              selectedShell={selectedShell}
              selectedShellId={selectedShellId}
              shellStatus={shellStatus}
              onSelectShell={setSelectedShellId}
              kbd="Ctrl+Shift+T"
              onStart={() => {
                onStartLocalTerminal(
                  selectedShell ? { id: selectedShell.id, name: selectedShell.name } : undefined,
                );
              }}
              onStartAsAdministrator={handleStartAsAdministrator}
            />
            <ActionCard
              icon={<Plus className="w-5 h-5" />}
              title="New session…"
              desc="SSH, RDP, VNC, SFTP, Telnet, Serial, Mosh, WSL, S3 — all in one dialog."
              kbd="Ctrl+Shift+N"
              onClick={() => onNewSession()}
            />
            <ActionCard
              icon={<Upload className="w-5 h-5" />}
              title="Import OpenSSH config"
              desc="Read Host, HostName, User, Port and IdentityFile entries into saved sessions."
              kbd=""
              onClick={() => fileInputRef.current?.click()}
            />
            <ActionCard
              icon={<RefreshCw className="w-5 h-5" />}
              title="Refresh sessions"
              desc="Reload saved sessions from the application database."
              kbd=""
              onClick={() => void loadSessions()}
            />
          </div>

          <div className="mt-6 text-[12px] text-[var(--moba-text-muted)]">
            <div className="font-semibold text-[var(--moba-text)] mb-1">Tips</div>
            <ul className="list-disc pl-5 space-y-0.5">
              <li>Use Quick connect for <span className="moba-mono px-1 border rounded" style={{ background: "var(--moba-input-bg)", borderColor: "var(--moba-divider)" }}>ssh user@host:22</span> or saved sessions.</li>
              <li>Right‑click any session in the sidebar to connect, edit, duplicate, or delete it.</li>
              <li>Drag a session onto a folder in the tree to update its group.</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="w-[260px] border-l p-3 text-[12px]" style={{ borderColor: "var(--moba-divider)", background: "var(--moba-panel-bg)" }}>
        <div className="font-semibold mb-2 flex items-center gap-1"><Activity className="w-3.5 h-3.5" /> Active connections</div>
        {activeConnections.length === 0 ? (
          <EmptyText>No active terminal tabs.</EmptyText>
        ) : (
          activeConnections.slice(0, 5).map((tab) => (
            <ConnRow
              key={tab.id}
              color={tab.ssh ? "#2b5d8b" : "#2f8a3e"}
              name={tab.title}
              meta={tab.ssh ? `ssh • ${tab.ssh.username}@${tab.ssh.host}` : tab.localShell?.name ?? "local shell"}
            />
          ))
        )}
        <div className="mt-4 font-semibold mb-2 flex items-center gap-1"><ScrollText className="w-3.5 h-3.5" /> Last events</div>
        {recentEvents.length === 0 ? (
          <EmptyText>No saved session activity yet.</EmptyText>
        ) : (
          recentEvents.map((session) => (
            <EventRow
              key={session.id}
              icon={session.last_connected_at ? ">" : "+"}
              text={`${session.last_connected_at ? "Connected to" : "Saved"} '${session.name}'`}
              tone={session.last_connected_at ? "ok" : "info"}
            />
          ))
        )}
      </div>
    </div>
  );
}

function LocalTerminalCard({
  shells,
  selectedShell,
  selectedShellId,
  shellStatus,
  onSelectShell,
  kbd,
  onStart,
  onStartAsAdministrator,
}: {
  shells: LocalShellOption[];
  selectedShell?: LocalShellOption;
  selectedShellId: string;
  shellStatus: "loading" | "ready" | "error";
  onSelectShell: (id: string) => void;
  kbd: string;
  onStart: () => void;
  onStartAsAdministrator: () => void;
}) {
  const hasChoices = shells.length > 1;
  const canElevate = selectedShell?.canElevate ?? false;
  const detail = selectedShell?.path ?? (
    shellStatus === "loading" ? "Detecting available shells..." : "Use the system default shell."
  );

  return (
    <div
      className="text-left p-3 rounded-md border hover:shadow-sm transition"
      style={{ borderColor: "var(--moba-card-border)", background: "var(--moba-card-bg)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--moba-accent)" }}><TerminalIcon className="w-5 h-5" /></span>
        <span className="font-semibold">Start local terminal</span>
        {kbd && (
          <span
            className="ml-auto text-[10px] moba-mono px-1.5 py-0.5 rounded border"
            style={{
              background: "var(--moba-input-bg)",
              borderColor: "var(--moba-divider)",
              color: "var(--moba-text-muted)",
            }}
          >
            {kbd}
          </span>
        )}
      </div>
      <div className="text-[12px] text-[var(--moba-text-muted)]">
        {selectedShell ? `Open ${selectedShell.name}.` : "Open a local shell."}
      </div>

      <div className="mt-2 space-y-2">
        {hasChoices ? (
          <select
            className="moba-input h-8 w-full"
            aria-label="Terminal shell"
            value={selectedShellId}
            title={selectedShell?.path}
            onChange={(event) => onSelectShell(event.target.value)}
          >
            {shells.map((shell) => (
              <option key={shell.id} value={shell.id}>
                {shell.name}{shell.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        ) : (
          <div
            className="moba-input h-8 w-full flex items-center truncate"
            title={detail}
            style={{ color: selectedShell ? "var(--moba-text)" : "var(--moba-text-muted)" }}
          >
            {selectedShell?.name ?? (shellStatus === "loading" ? "Detecting shells..." : "Default shell")}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button data-testid="welcome-open-local-terminal" className="moba-btn h-8 px-3" onClick={onStart} type="button">
            Open
          </button>
          {canElevate && (
            <button
              className="moba-btn h-8 px-3 inline-flex items-center gap-1.5"
              onClick={onStartAsAdministrator}
              title="Open as administrator"
              aria-label="Open as administrator"
              type="button"
            >
              <Shield className="w-3.5 h-3.5" />
              <span>Admin</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionCard({
  icon,
  title,
  desc,
  kbd,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  kbd: string;
  onClick: () => void;
}) {
  return (
    <button
      className="text-left p-3 rounded-md border hover:shadow-sm transition"
      style={{ borderColor: "var(--moba-card-border)", background: "var(--moba-card-bg)" }}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--moba-accent)" }}>{icon}</span>
        <span className="font-semibold">{title}</span>
        {kbd && (
          <span
            className="ml-auto text-[10px] moba-mono px-1.5 py-0.5 rounded border"
            style={{
              background: "var(--moba-input-bg)",
              borderColor: "var(--moba-divider)",
              color: "var(--moba-text-muted)",
            }}
          >
            {kbd}
          </span>
        )}
      </div>
      <div className="text-[12px] text-[var(--moba-text-muted)]">{desc}</div>
    </button>
  );
}

function ConnRow({ color, name, meta }: { color: string; name: string; meta: string }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      <div className="flex-1 min-w-0">
        <div className="truncate">{name}</div>
        <div className="text-[10px] text-[var(--moba-text-muted)] moba-mono">{meta}</div>
      </div>
    </div>
  );
}

function EventRow({ icon, text, tone }: { icon: string; text: string; tone: "ok" | "info" | "warn" }) {
  const colors = { ok: "#2f8a3e", info: "#1e5fa8", warn: "#a86b16" }[tone];
  return (
    <div className="flex items-start gap-2 py-0.5 text-[11px]">
      <span style={{ color: colors }} className="moba-mono w-3">{icon}</span>
      <span className="text-[var(--moba-text-muted)]">{text}</span>
    </div>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-[var(--moba-text-muted)] py-1">{children}</div>;
}
