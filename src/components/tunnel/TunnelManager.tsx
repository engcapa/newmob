import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus,
  Play,
  Square,
  Pencil,
  Copy,
  Trash2,
  Eye,
  EyeOff,
  Zap,
  Power,
  Network as NetworkIcon,
  GripVertical,
  AlertCircle,
  Loader2,
  CheckCircle2,
  CircleDot,
  Key as KeyIcon,
  TestTube2,
  LogOut,
} from "lucide-react";
import {
  defaultTunnel,
  deleteTunnel,
  listTunnels,
  listTunnelStatuses,
  listenTunnelStatus,
  newTunnelId,
  reorderTunnels,
  startAllTunnels,
  startTunnel,
  stopAllTunnels,
  stopTunnel,
  testTunnel,
  upsertTunnel,
  type TunnelConfig,
  type TunnelStatus,
  type TunnelStatusInfo,
} from "../../lib/tunnel";
import { TunnelEditor } from "./TunnelEditor";
import { useSessionStore } from "../../stores/sessionStore";
import { isTauriRuntime } from "../../lib/runtime";

interface Props {
  onStatusMessage?: (msg: string) => void;
  onClose?: () => void;
}

export function TunnelManager({ onStatusMessage, onClose }: Props) {
  const { sessions, loadSessions } = useSessionStore();
  const [tunnels, setTunnels] = useState<TunnelConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, TunnelStatusInfo>>({});
  const [editing, setEditing] = useState<TunnelConfig | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [editorFocus, setEditorFocus] = useState<"auth" | undefined>(undefined);
  const [revealAuth, setRevealAuth] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const setStatus = useCallback((info: TunnelStatusInfo) => {
    setStatuses((prev) => ({ ...prev, [info.id]: info }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([listTunnels(), listTunnelStatuses()]);
      setTunnels(list.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
      const map: Record<string, TunnelStatusInfo> = {};
      for (const s of st) map[s.id] = s;
      setStatuses(map);
    } catch (err) {
      onStatusMessage?.(`Failed to load tunnels: ${err instanceof Error ? err.message : err}`);
    } finally {
      setLoading(false);
    }
  }, [onStatusMessage]);

  useEffect(() => {
    void loadSessions();
    void refresh();
  }, [loadSessions, refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenTunnelStatus(setStatus).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [setStatus]);

  const handleNew = () => {
    setEditing(null);
    setEditorFocus(undefined);
    setShowEditor(true);
  };

  const handleEdit = (t: TunnelConfig) => {
    setEditing(t);
    setEditorFocus(undefined);
    setShowEditor(true);
  };

  const handleEditKey = (t: TunnelConfig) => {
    setEditing(t);
    setEditorFocus("auth");
    setShowEditor(true);
  };

  const handleTest = async (t: TunnelConfig) => {
    onStatusMessage?.(`Testing tunnel “${t.name}”…`);
    try {
      const msg = await testTunnel(t.id);
      onStatusMessage?.(msg);
    } catch (err) {
      onStatusMessage?.(
        `Test failed for “${t.name}”: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  const handleClone = async (t: TunnelConfig) => {
    const copy: TunnelConfig = {
      ...t,
      id: newTunnelId(),
      name: `${t.name} (copy)`,
      sortOrder: tunnels.length,
    };
    try {
      await upsertTunnel(copy);
      await refresh();
      onStatusMessage?.(`Tunnel cloned: ${copy.name}`);
    } catch (err) {
      onStatusMessage?.(`Clone failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const handleDelete = async (t: TunnelConfig) => {
    if (!window.confirm(`Delete tunnel “${t.name}”?`)) return;
    try {
      await deleteTunnel(t.id);
      await refresh();
      onStatusMessage?.(`Tunnel deleted: ${t.name}`);
    } catch (err) {
      onStatusMessage?.(`Delete failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const handleStart = async (t: TunnelConfig) => {
    setStatus({ id: t.id, status: "starting" });
    try {
      const info = await startTunnel(t.id);
      setStatus(info);
      if (info.status === "error") {
        onStatusMessage?.(`Tunnel “${t.name}” failed: ${info.error ?? "unknown error"}`);
      } else if (info.status === "running") {
        onStatusMessage?.(`Tunnel “${t.name}” running on ${t.listenHost}:${t.listenPort}`);
      } else {
        // "starting" — final outcome will arrive on the tunnel-status event.
        onStatusMessage?.(`Tunnel “${t.name}” starting…`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus({ id: t.id, status: "error", error: msg });
      onStatusMessage?.(`Tunnel “${t.name}” failed: ${msg}`);
    }
  };

  const handleStop = async (t: TunnelConfig) => {
    try {
      const info = await stopTunnel(t.id);
      setStatus(info);
    } catch (err) {
      onStatusMessage?.(`Stop failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const handleStartAll = async () => {
    setBusy(true);
    try {
      const list = await startAllTunnels();
      const map = { ...statuses };
      for (const s of list) map[s.id] = s;
      setStatuses(map);
      const failed = list.filter((s) => s.status === "error").length;
      onStatusMessage?.(failed > 0 ? `Started tunnels with ${failed} error(s)` : "All tunnels started");
    } catch (err) {
      onStatusMessage?.(`Start-all failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStopAll = async () => {
    setBusy(true);
    try {
      const list = await stopAllTunnels();
      const map = { ...statuses };
      for (const s of list) map[s.id] = s;
      setStatuses(map);
      onStatusMessage?.("All tunnels stopped");
    } catch (err) {
      onStatusMessage?.(`Stop-all failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveDraft = async (config: TunnelConfig) => {
    const next: TunnelConfig = {
      ...config,
      sortOrder: config.sortOrder ?? tunnels.length,
    };
    await upsertTunnel(next);
    await refresh();
    setShowEditor(false);
    setEditing(null);
    onStatusMessage?.(`Tunnel saved: ${next.name}`);
  };

  const reorder = async (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= tunnels.length || to >= tunnels.length) return;
    const next = tunnels.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setTunnels(next);
    try {
      await reorderTunnels(next.map((t) => t.id));
    } catch (err) {
      onStatusMessage?.(`Reorder failed: ${err instanceof Error ? err.message : err}`);
      void refresh();
    }
  };

  const tauri = isTauriRuntime();

  return (
    <div
      data-testid="tunnel-manager"
      className="w-full h-full flex flex-col"
      style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}
    >
      {/* Header */}
      <div
        className="px-4 py-2 border-b shrink-0 flex items-center gap-2"
        style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}
      >
        <NetworkIcon className="w-4 h-4" style={{ color: "var(--moba-accent)" }} />
        <div className="text-[13px] font-semibold" style={{ color: "var(--moba-accent)" }}>
          Network tools — SSH tunnels
        </div>
        <div className="text-[11px] ml-2" style={{ color: "var(--moba-text-muted)" }}>
          Graphical port forwarding
        </div>
      </div>

      {!tauri && (
        <div
          className="px-4 py-1.5 text-[11px] border-b shrink-0 flex items-center gap-1.5"
          style={{
            background: "rgba(255,196,0,0.12)",
            borderColor: "var(--moba-divider)",
            color: "var(--moba-text-muted)",
          }}
        >
          <AlertCircle className="w-3 h-3" />
          Tunnels are saved locally for preview, but actually opening a forward requires the desktop build.
        </div>
      )}

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto px-3 py-3">
        <div
          className="rounded border overflow-hidden"
          style={{ borderColor: "var(--moba-divider)", background: "var(--moba-panel-bg)" }}
        >
          <table data-testid="tunnel-list" className="w-full text-[12px] border-collapse">
            <thead>
              <tr style={{ background: "var(--moba-quick-bg)", color: "var(--moba-text)" }}>
                <Th>Order</Th>
                <Th className="text-left">Name</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Forward port</Th>
                <Th className="text-left">Destination server</Th>
                <Th className="text-left">SSH server</Th>
                <Th>Settings</Th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} className="text-center py-6" style={{ color: "var(--moba-text-muted)" }}>
                    Loading tunnels…
                  </td>
                </tr>
              )}
              {!loading && tunnels.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-8" style={{ color: "var(--moba-text-muted)" }}>
                    No tunnels yet — click <strong>New SSH tunnel</strong> below to add one.
                  </td>
                </tr>
              )}
              {!loading &&
                tunnels.map((t, idx) => (
                  <TunnelRow
                    key={t.id}
                    tunnel={t}
                    index={idx}
                    total={tunnels.length}
                    status={statuses[t.id]}
                    revealAuth={!!revealAuth[t.id]}
                    onToggleReveal={() =>
                      setRevealAuth((prev) => ({ ...prev, [t.id]: !prev[t.id] }))
                    }
                    onStart={() => handleStart(t)}
                    onStop={() => handleStop(t)}
                    onEdit={() => handleEdit(t)}
                    onEditKey={() => handleEditKey(t)}
                    onTest={() => handleTest(t)}
                    onClone={() => handleClone(t)}
                    onDelete={() => handleDelete(t)}
                    onMoveUp={() => reorder(idx, idx - 1)}
                    onMoveDown={() => reorder(idx, idx + 1)}
                    onToggleAutostart={async () => {
                      try {
                        await upsertTunnel({ ...t, autostart: !t.autostart });
                        await refresh();
                      } catch (err) {
                        onStatusMessage?.(`Toggle failed: ${err instanceof Error ? err.message : err}`);
                      }
                    }}
                  />
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      <div
        className="h-12 flex items-center px-3 gap-2 border-t shrink-0"
        style={{ background: "var(--moba-quick-bg)", borderColor: "var(--moba-divider)" }}
      >
        <button data-testid="tunnel-new" type="button" className="moba-btn flex items-center gap-1.5" onClick={handleNew}>
          <Plus className="w-3.5 h-3.5" /> New SSH tunnel
        </button>
        <button
          data-testid="tunnel-start-all"
          type="button"
          className="moba-btn flex items-center gap-1.5"
          onClick={handleStartAll}
          disabled={busy || tunnels.length === 0}
        >
          <Play className="w-3.5 h-3.5" style={{ color: "#1f7a4a" }} /> Start all tunnels
        </button>
        <button
          data-testid="tunnel-stop-all"
          type="button"
          className="moba-btn flex items-center gap-1.5"
          onClick={handleStopAll}
          disabled={busy || tunnels.length === 0}
        >
          <Square className="w-3.5 h-3.5" style={{ color: "#b22222" }} /> Stop all tunnels
        </button>
        {onClose && (
          <button
            data-testid="tunnel-exit"
            type="button"
            className="moba-btn flex items-center gap-1.5"
            onClick={onClose}
            title="Close the tunnels tab"
          >
            <LogOut className="w-3.5 h-3.5" /> Exit
          </button>
        )}
        <div className="flex-1" />
        <span className="text-[11px]" style={{ color: "var(--moba-text-muted)" }}>
          {tunnels.length} tunnel{tunnels.length === 1 ? "" : "s"} ·{" "}
          {Object.values(statuses).filter((s) => s.status === "running").length} running
        </span>
      </div>

      {showEditor && (
        <TunnelEditor
          initial={editing ?? undefined}
          sessions={sessions}
          focus={editorFocus}
          onSave={handleSaveDraft}
          onCancel={() => {
            setShowEditor(false);
            setEditing(null);
            setEditorFocus(undefined);
          }}
        />
      )}
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-2 py-1.5 text-[11px] font-semibold text-center border-b ${className}`}
      style={{ borderColor: "var(--moba-divider)", color: "var(--moba-text)" }}
    >
      {children}
    </th>
  );
}

function StatusBadge({ status, error }: { status?: TunnelStatus; error?: string }) {
  const s = status ?? "stopped";
  let icon: React.ReactNode = <CircleDot className="w-3 h-3" style={{ color: "var(--moba-text-muted)" }} />;
  let label = "Stopped";
  let color = "var(--moba-text-muted)";
  if (s === "running") {
    icon = <CheckCircle2 className="w-3 h-3" style={{ color: "#1f7a4a" }} />;
    label = "Running";
    color = "#1f7a4a";
  } else if (s === "starting") {
    icon = <Loader2 className="w-3 h-3 animate-spin" style={{ color: "var(--moba-accent)" }} />;
    label = "Starting…";
    color = "var(--moba-accent)";
  } else if (s === "error") {
    icon = <AlertCircle className="w-3 h-3" style={{ color: "#b22222" }} />;
    label = "Error";
    color = "#b22222";
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px]"
      style={{ color }}
      title={error ?? label}
    >
      {icon}
      {label}
    </span>
  );
}

function TunnelRow({
  tunnel,
  index,
  total,
  status,
  revealAuth,
  onToggleReveal,
  onStart,
  onStop,
  onEdit,
  onEditKey,
  onTest,
  onClone,
  onDelete,
  onMoveUp,
  onMoveDown,
  onToggleAutostart,
}: {
  tunnel: TunnelConfig;
  index: number;
  total: number;
  status?: TunnelStatusInfo;
  revealAuth: boolean;
  onToggleReveal: () => void;
  onStart: () => void;
  onStop: () => void;
  onEdit: () => void;
  onEditKey: () => void;
  onTest: () => void;
  onClone: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleAutostart: () => void;
}) {
  const running = status?.status === "running" || status?.status === "starting";
  const dest =
    tunnel.kind === "Dynamic"
      ? "(SOCKS5 dynamic)"
      : `${tunnel.destHost || "?"}:${tunnel.destPort || "?"}`;
  const sshLabel = `${tunnel.ssh.username || "?"}@${tunnel.ssh.host || "?"}:${tunnel.ssh.port || 22}`;
  const authPreview = useMemo(() => {
    if (tunnel.ssh.authMethod === "Agent") return "agent";
    const data = tunnel.ssh.authData ?? "";
    if (!data) return "(none)";
    if (revealAuth) return data;
    if (tunnel.ssh.authMethod === "PrivateKey") {
      const head = data.length > 24 ? `…${data.slice(-22)}` : data;
      return head;
    }
    return "•".repeat(Math.min(8, Math.max(4, data.length)));
  }, [revealAuth, tunnel.ssh.authData, tunnel.ssh.authMethod]);

  return (
    <tr
      data-testid="tunnel-row"
      data-tunnel-id={tunnel.id}
      className="border-b"
      style={{ borderColor: "var(--moba-divider)" }}
    >
      <Td className="text-center">
        <div className="inline-flex items-center gap-0.5 text-[10px]" style={{ color: "var(--moba-text-muted)" }}>
          <button
            data-testid="tunnel-row-move-up"
            type="button"
            className="px-1 hover:text-[var(--moba-accent)] disabled:opacity-30"
            title="Move up"
            onClick={onMoveUp}
            disabled={index === 0}
          >
            ▲
          </button>
          <GripVertical className="w-3 h-3" />
          <button
            data-testid="tunnel-row-move-down"
            type="button"
            className="px-1 hover:text-[var(--moba-accent)] disabled:opacity-30"
            title="Move down"
            onClick={onMoveDown}
            disabled={index === total - 1}
          >
            ▼
          </button>
        </div>
      </Td>
      <Td>
        <div className="font-semibold text-[12px]">{tunnel.name || "(unnamed)"}</div>
        {tunnel.description && (
          <div className="text-[10.5px]" style={{ color: "var(--moba-text-muted)" }}>
            {tunnel.description}
          </div>
        )}
      </Td>
      <Td className="text-center">
        <span
          className="inline-block px-1.5 py-0.5 rounded text-[11px]"
          style={{
            background: "var(--moba-selected)",
            color: "var(--moba-accent)",
          }}
        >
          {tunnel.kind}
        </span>
      </Td>
      <Td className="text-center">
        <div className="flex items-center justify-center gap-1.5">
          <button
            data-testid="tunnel-row-toggle"
            type="button"
            title={running ? "Stop" : "Start"}
            className="p-1 rounded hover:bg-[var(--moba-hover)]"
            onClick={running ? onStop : onStart}
          >
            {running ? (
              <Square className="w-3.5 h-3.5" style={{ color: "#b22222" }} />
            ) : (
              <Play className="w-3.5 h-3.5" style={{ color: "#1f7a4a" }} />
            )}
          </button>
          <StatusBadge status={status?.status} error={status?.error} />
        </div>
        {status?.status === "error" && status.error && (
          <div className="text-[10.5px] mt-0.5 truncate max-w-[180px] mx-auto" title={status.error} style={{ color: "#b22222" }}>
            {status.error}
          </div>
        )}
      </Td>
      <Td className="text-center moba-mono text-[12px]">
        {tunnel.listenHost}:{tunnel.listenPort || "?"}
      </Td>
      <Td className="moba-mono text-[12px]">{dest}</Td>
      <Td>
        <div className="flex items-center gap-1">
          <span className="moba-mono text-[12px]">{sshLabel}</span>
          <span className="text-[10.5px] px-1 rounded" style={{ background: "var(--moba-hover)", color: "var(--moba-text-muted)" }}>
            {tunnel.ssh.authMethod}
          </span>
          <span className="text-[10.5px] moba-mono" style={{ color: "var(--moba-text-muted)" }}>
            {authPreview}
          </span>
          <button
            data-testid="tunnel-row-toggle-reveal"
            type="button"
            className="p-0.5 hover:text-[var(--moba-accent)]"
            title={revealAuth ? "Hide credentials" : "Show credentials"}
            onClick={onToggleReveal}
          >
            {revealAuth ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </button>
        </div>
      </Td>
      <Td className="text-center">
        <div className="flex items-center justify-center gap-1">
          <IconBtn testId="tunnel-row-edit" title="Edit" onClick={onEdit}>
            <Pencil className="w-3.5 h-3.5" style={{ color: "#2b5d8b" }} />
          </IconBtn>
          <IconBtn testId="tunnel-row-edit-key" title="Manage SSH key / credentials" onClick={onEditKey}>
            <KeyIcon className="w-3.5 h-3.5" style={{ color: "#c97a23" }} />
          </IconBtn>
          <IconBtn testId="tunnel-row-test" title="Test SSH connection" onClick={onTest}>
            <TestTube2 className="w-3.5 h-3.5" style={{ color: "#1e6db8" }} />
          </IconBtn>
          <IconBtn testId="tunnel-row-clone" title="Clone" onClick={onClone}>
            <Copy className="w-3.5 h-3.5" style={{ color: "#7a3d9d" }} />
          </IconBtn>
          <IconBtn
            testId="tunnel-row-autostart"
            title={tunnel.autostart ? "Auto-start enabled (click to disable)" : "Enable auto-start"}
            onClick={onToggleAutostart}
          >
            <Zap
              className="w-3.5 h-3.5"
              style={{ color: tunnel.autostart ? "#c97a23" : "var(--moba-text-muted)" }}
            />
          </IconBtn>
          <IconBtn testId="tunnel-row-delete" title="Delete" onClick={onDelete}>
            <Trash2 className="w-3.5 h-3.5" style={{ color: "#b22222" }} />
          </IconBtn>
          <IconBtn testId="tunnel-row-power" title={running ? "Stop" : "Start"} onClick={running ? onStop : onStart}>
            <Power
              className="w-3.5 h-3.5"
              style={{ color: running ? "#1f7a4a" : "var(--moba-text-muted)" }}
            />
          </IconBtn>
        </div>
      </Td>
    </tr>
  );
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`px-2 py-1.5 align-middle ${className}`}>
      {children}
    </td>
  );
}

function IconBtn({
  title,
  onClick,
  children,
  testId,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      data-testid={testId}
      type="button"
      className="p-1 rounded hover:bg-[var(--moba-hover)]"
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// Re-export so other modules don't have to think about the manager file
export { defaultTunnel };
