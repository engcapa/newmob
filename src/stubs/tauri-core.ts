import type { SessionConfig, SessionGroup, LocalShellOption } from "../lib/ipc";
import {
  isSshSession,
  sshClose,
  sshConnect,
  sshResize,
  sshSignal,
  sshTest,
  sshWrite,
} from "./sshClient";
import {
  isSftpSession,
  sftpAttach,
  sftpDetach,
  sftpListRemote,
  sftpStatRemote,
  sftpMkdirRemote,
  sftpRemoveRemote,
  sftpRenameRemote,
  sftpChmodRemote,
  sftpRealpathRemote,
  sftpReadTextRemote,
  sftpWriteTextRemote,
  sftpUploadBytesRemote,
  sftpDownloadBytesRemote,
  sftpCancel,
} from "./sftpClient";
import {
  vfsHome,
  vfsList,
  vfsStat,
  vfsMkdir,
  vfsRemove,
  vfsRename,
  vfsReadText,
  vfsWriteText,
  vfsReadBytes,
  vfsWriteBytes,
  vfsExportToBrowser,
  VFS_ROOT,
} from "./localVfs";
import { emit } from "./tauri-event";

const SESSION_STORAGE_KEY = "newmob.sessions.v1";
const GROUP_STORAGE_KEY = "newmob.groups.v1";
const TUNNEL_STORAGE_KEY = "newmob.tunnels.v1";

interface StubTunnelStatus {
  id: string;
  status: "stopped" | "starting" | "running" | "error";
  error?: string;
  activeConnections?: number;
}
const tunnelStatuses: Record<string, StubTunnelStatus> = {};

interface StubTunnelConfig {
  id: string;
  name: string;
  kind: "Local" | "Remote" | "Dynamic";
  listenHost: string;
  listenPort: number;
  destHost: string;
  destPort: number;
  sshSessionId?: string | null;
  ssh: {
    host: string;
    port: number;
    username: string;
    authMethod: "Password" | "PrivateKey" | "Agent";
    authData: string | null;
    saveAuth?: boolean;
  };
  description?: string;
  autostart?: boolean;
  sortOrder?: number;
}

function loadTunnels(): StubTunnelConfig[] {
  try {
    return JSON.parse(localStorage.getItem(TUNNEL_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveTunnels(list: StubTunnelConfig[]): void {
  // Strip secrets unless saveAuth is true (mirrors how the desktop vault behaves).
  const sanitized = list.map((t) => ({
    ...t,
    ssh: {
      ...t.ssh,
      authData: t.ssh.saveAuth ? t.ssh.authData : (t.ssh.authMethod === "PrivateKey" ? t.ssh.authData : null),
    },
  }));
  localStorage.setItem(TUNNEL_STORAGE_KEY, JSON.stringify(sanitized));
}

function loadSessions(): SessionConfig[] {
  try {
    return JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveSessions(sessions: SessionConfig[]): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
}

function loadGroups(): SessionGroup[] {
  try {
    return JSON.parse(localStorage.getItem(GROUP_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveGroups(groups: SessionGroup[]): void {
  localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(groups));
}

type InvokeArgs = Record<string, unknown>;

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

function bytesB64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToB64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
    );
  }
  return btoa(binary);
}

export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  switch (cmd) {
    case "list_sessions": {
      return loadSessions() as T;
    }
    case "get_session": {
      const sessions = loadSessions();
      const session = sessions.find((s) => s.id === (args?.id as string));
      if (!session) throw new Error(`Session not found: ${args?.id}`);
      return session as T;
    }
    case "save_session": {
      const sessions = loadSessions();
      const config = args?.config as SessionConfig;
      const idx = sessions.findIndex((s) => s.id === config.id);
      if (idx >= 0) sessions[idx] = config;
      else sessions.push(config);
      saveSessions(sessions);
      return undefined as T;
    }
    case "delete_session": {
      const sessions = loadSessions();
      saveSessions(sessions.filter((s) => s.id !== (args?.id as string)));
      return undefined as T;
    }
    case "mark_session_connected": {
      const sessions = loadSessions();
      const now = Math.floor(Date.now() / 1000);
      const idx = sessions.findIndex((s) => s.id === (args?.id as string));
      if (idx >= 0) {
        sessions[idx] = { ...sessions[idx], last_connected_at: now };
        saveSessions(sessions);
        return now as T;
      }
      return 0 as T;
    }
    case "list_session_groups": {
      return loadGroups() as T;
    }
    case "save_session_group": {
      const groups = loadGroups();
      const group = args?.group as SessionGroup;
      const idx = groups.findIndex((g) => g.id === group.id);
      if (idx >= 0) groups[idx] = group;
      else groups.push(group);
      saveGroups(groups);
      return undefined as T;
    }
    case "delete_session_group": {
      const groups = loadGroups();
      saveGroups(groups.filter((g) => g.id !== (args?.id as string)));
      return undefined as T;
    }
    case "list_local_shells": {
      const shells: LocalShellOption[] = [
        {
          id: "browser-shell",
          name: "Browser preview (SSH only)",
          path: "/dev/null",
          args: [],
          isDefault: true,
          canElevate: false,
        },
      ];
      return shells as T;
    }
    case "list_system_fonts": {
      return [] as T;
    }
    case "select_private_key_file": {
      const current = (args?.currentPath as string | null) || "~/.ssh/id_ed25519";
      const selected = window.prompt("Private key path", current);
      return (selected?.trim() || null) as T;
    }
    case "create_local_terminal": {
      throw new Error(
        "Local terminal is not available in browser preview. Use the Quick connect bar or 'New session' to open an SSH connection (e.g. demo@test.rebex.net).",
      );
    }
    case "create_ssh_terminal": {
      const cols = (args?.cols as number) ?? 80;
      const rows = (args?.rows as number) ?? 24;
      // The browser preview can't honour proxy / port-forwarding rows; we
      // simply ignore `networkSettingsJson` here and let the WS proxy
      // handle the SSH connection directly.
      return (await sshConnect({
        host: args?.host as string,
        port: (args?.port as number) || 22,
        username: args?.username as string,
        authMethod: args?.authMethod as string,
        authData: (args?.authData as string | null) ?? null,
        cols,
        rows,
      })) as T;
    }
    case "test_ssh_connection": {
      // The browser preview can't honour proxy / port-forwarding rows
      // either; we ignore `networkSettingsJson` here for symmetry with
      // `create_ssh_terminal` so testing a session in web preview
      // exercises the same path the spawned terminal will take.
      return (await sshTest({
        host: args?.host as string,
        port: (args?.port as number) || 22,
        username: args?.username as string,
        authMethod: args?.authMethod as string,
        authData: (args?.authData as string | null) ?? null,
      })) as T;
    }
    case "write_terminal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) sshWrite(sid, args?.data as string);
      return undefined as T;
    }
    case "resize_terminal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) sshResize(sid, args?.cols as number, args?.rows as number);
      return undefined as T;
    }
    case "send_terminal_signal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) sshSignal(sid, args?.signal as string);
      return undefined as T;
    }
    case "close_terminal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) sshClose(sid);
      return undefined as T;
    }
    case "open_local_shell_as_administrator": {
      throw new Error("Administrator local terminals are not available in browser preview.");
    }
    case "exit_app": {
      window.close();
      return undefined as T;
    }

    // ---------- SFTP commands ----------
    case "sftp_attach": {
      const sid = args?.sessionId as string;
      const result = await sftpAttach({
        sessionId: sid,
        host: args?.host as string,
        port: (args?.port as number) || 22,
        username: args?.username as string,
        authMethod: (args?.authMethod as string) || "Password",
        authData: (args?.authData as string | null) ?? null,
      });
      return result as T;
    }
    case "sftp_detach": {
      await sftpDetach(args?.sessionId as string);
      return undefined as T;
    }
    case "sftp_list_remote": {
      const sid = args?.sessionId as string;
      const path = (args?.path as string) || ".";
      const entries = await sftpListRemote(sid, path);
      return entries as T;
    }
    case "sftp_list_local": {
      const path = (args?.path as string) || "";
      const entries = await vfsList(path);
      return entries as T;
    }
    case "sftp_local_home": {
      const home = await vfsHome();
      return home as T;
    }
    case "sftp_local_drives": {
      return [{ id: "vfs", label: VFS_ROOT, path: VFS_ROOT }] as T;
    }
    case "sftp_mkdir": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        await vfsMkdir(args?.path as string);
      } else {
        await sftpMkdirRemote(args?.sessionId as string, args?.path as string);
      }
      return undefined as T;
    }
    case "sftp_remove": {
      const side = (args?.side as string) ?? "remote";
      const recursive = !!args?.recursive;
      if (side === "local") {
        await vfsRemove(args?.path as string, recursive);
      } else {
        await sftpRemoveRemote(args?.sessionId as string, args?.path as string, recursive);
      }
      return undefined as T;
    }
    case "sftp_rename": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        await vfsRename(args?.oldPath as string, args?.newPath as string);
      } else {
        await sftpRenameRemote(
          args?.sessionId as string,
          args?.oldPath as string,
          args?.newPath as string,
        );
      }
      return undefined as T;
    }
    case "sftp_stat": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        return (await vfsStat(args?.path as string)) as T;
      }
      const entry = await sftpStatRemote(args?.sessionId as string, args?.path as string);
      return entry as T;
    }
    case "sftp_chmod": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        // The browser preview's local "FS" is the in-memory VFS, which does
        // not track POSIX permission bits. Treat chmod as a successful no-op
        // so the UI flow matches the desktop build.
        return undefined as T;
      }
      await sftpChmodRemote(
        args?.sessionId as string,
        args?.path as string,
        args?.mode as number,
      );
      return undefined as T;
    }
    case "sftp_upload_dir":
    case "sftp_download_dir": {
      // Folder transfers require a recursive walk over the SFTP bridge that
      // the browser-preview proxy does not expose. Surface a friendly error
      // and emit a completion frame so the queue row finalises.
      const transferId = args?.transferId as string;
      const message = "Folder transfers are not available in browser preview. Try the desktop build.";
      void emit(`sftp-transfer-complete-${transferId}`, {
        success: false,
        error: message,
      });
      throw new Error(message);
    }
    case "sftp_realpath": {
      const path = await sftpRealpathRemote(args?.sessionId as string, args?.path as string);
      return path as T;
    }
    case "sftp_read_file_text": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        return (await vfsReadText(args?.path as string)) as T;
      }
      const max = (args?.maxBytes as number) ?? 4 * 1024 * 1024;
      return (await sftpReadTextRemote(
        args?.sessionId as string,
        args?.path as string,
        max,
      )) as T;
    }
    case "sftp_write_file_text": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        await vfsWriteText(args?.path as string, args?.contents as string);
      } else {
        await sftpWriteTextRemote(
          args?.sessionId as string,
          args?.path as string,
          args?.contents as string,
        );
      }
      return undefined as T;
    }
    case "sftp_upload": {
      // In the web stub, "local" path is a virtual VFS path.
      const sid = args?.sessionId as string;
      const transferId = args?.transferId as string;
      const localPath = args?.localPath as string;
      const remotePath = args?.remotePath as string;
      const data = await vfsReadBytes(localPath);
      const total = data.byteLength;
      const b64 = arrayBufferToB64(data);
      void emit(`sftp-progress-${transferId}`, { bytes: 0, total, rate: 0, eta: 0 });
      try {
        await sftpUploadBytesRemote(sid, transferId, remotePath, b64);
        void emit(`sftp-progress-${transferId}`, { bytes: total, total, rate: 0, eta: 0 });
        void emit(`sftp-transfer-complete-${transferId}`, { success: true, finalPath: remotePath });
      } catch (err) {
        void emit(`sftp-transfer-complete-${transferId}`, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return undefined as T;
    }
    case "sftp_download": {
      const sid = args?.sessionId as string;
      const transferId = args?.transferId as string;
      const remotePath = args?.remotePath as string;
      const localPath = args?.localPath as string;
      const openAfter = !!args?.openAfter;
      try {
        const b64 = await sftpDownloadBytesRemote(sid, transferId, remotePath);
        const buf = bytesB64ToArrayBuffer(b64);
        await vfsWriteBytes(localPath, buf);
        const total = buf.byteLength;
        void emit(`sftp-progress-${transferId}`, { bytes: total, total, rate: 0, eta: 0 });
        void emit(`sftp-transfer-complete-${transferId}`, {
          success: true,
          finalPath: localPath,
        });
        if (openAfter) {
          vfsExportToBrowser(basename(localPath), buf);
        }
      } catch (err) {
        void emit(`sftp-transfer-complete-${transferId}`, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return undefined as T;
    }
    case "sftp_upload_bytes": {
      const sid = args?.sessionId as string;
      const transferId = args?.transferId as string;
      const remotePath = args?.remotePath as string;
      const bytesB64 = args?.bytesB64 as string;
      const total = atob(bytesB64).length;
      void emit(`sftp-progress-${transferId}`, { bytes: 0, total, rate: 0, eta: 0 });
      try {
        await sftpUploadBytesRemote(sid, transferId, remotePath, bytesB64);
        void emit(`sftp-progress-${transferId}`, { bytes: total, total, rate: 0, eta: 0 });
        void emit(`sftp-transfer-complete-${transferId}`, { success: true, finalPath: remotePath });
      } catch (err) {
        void emit(`sftp-transfer-complete-${transferId}`, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return undefined as T;
    }
    case "sftp_download_bytes": {
      const sid = args?.sessionId as string;
      const transferId = args?.transferId as string;
      const remotePath = args?.remotePath as string;
      const b64 = await sftpDownloadBytesRemote(sid, transferId, remotePath);
      void emit(`sftp-transfer-complete-${transferId}`, { success: true });
      return b64 as T;
    }
    case "sftp_cancel_transfer": {
      // Best-effort: cancel on every attached SFTP session.
      // (browser stub doesn't track per-transfer mapping)
      const transferId = args?.transferId as string;
      // Iterate is not exposed; provide a no-op fallback.
      // We emit "cancelled" so the UI can finish even if the underlying
      // request keeps running on the proxy.
      void emit(`sftp-transfer-complete-${transferId}`, {
        success: false,
        error: "cancelled",
      });
      // attempt to cancel on any session it might belong to:
      const sid = (args?.sessionId as string) || "";
      if (sid && isSftpSession(sid)) sftpCancel(sid, transferId);
      return undefined as T;
    }
    case "sftp_pause_transfer": {
      // Browser stub doesn't have a real per-transfer worker to suspend,
      // but we still emit the paused event so the UI flips to "paused".
      const transferId = args?.transferId as string;
      void emit(`sftp-paused-${transferId}`, {
        bytes: 0,
        total: 0,
        rate: 0,
        eta: 0,
      });
      return undefined as T;
    }
    case "sftp_resume_transfer": {
      // No-op in browser preview; the real backend will start re-emitting
      // progress events when the worker resumes.
      return undefined as T;
    }
    case "open_sftp_window": {
      const sessionId = args?.sessionId as string;
      const url = new URL(window.location.href);
      url.searchParams.set("sftp", sessionId);
      url.hash = "";
      const features = "width=1200,height=760,resizable=yes,scrollbars=yes";
      const handle = window.open(
        url.toString(),
        `newmob_sftp_${sessionId}`,
        features,
      );
      if (!handle) {
        throw new Error(
          "Browser blocked the SFTP window. Allow pop-ups for this site.",
        );
      }
      return undefined as T;
    }
    case "sftp_open_path": {
      // No real OS shell in browser preview.
      throw new Error(
        "Opening files with the OS shell is not available in browser preview. Use 'Download to local' to save the file.",
      );
    }
    case "list_tunnels": {
      return loadTunnels() as T;
    }
    case "upsert_tunnel": {
      const config = args?.config as StubTunnelConfig;
      const list = loadTunnels();
      const idx = list.findIndex((t) => t.id === config.id);
      if (idx >= 0) list[idx] = config;
      else list.push(config);
      saveTunnels(list);
      return config as T;
    }
    case "delete_tunnel": {
      const id = args?.id as string;
      saveTunnels(loadTunnels().filter((t) => t.id !== id));
      delete tunnelStatuses[id];
      return undefined as T;
    }
    case "start_tunnel": {
      const id = args?.id as string;
      const tunnel = loadTunnels().find((t) => t.id === id);
      if (!tunnel) throw new Error(`Tunnel ${id} not found`);
      tunnelStatuses[id] = {
        id,
        status: "error",
        error: "Tunnels can only be opened in the desktop build of NewMob.",
      };
      void emit("tunnel-status", tunnelStatuses[id]);
      return tunnelStatuses[id] as T;
    }
    case "stop_tunnel": {
      const id = args?.id as string;
      tunnelStatuses[id] = { id, status: "stopped" };
      void emit("tunnel-status", tunnelStatuses[id]);
      return tunnelStatuses[id] as T;
    }
    case "start_all_tunnels": {
      const list = loadTunnels();
      for (const t of list) {
        tunnelStatuses[t.id] = {
          id: t.id,
          status: "error",
          error: "Desktop-only feature in preview mode.",
        };
        void emit("tunnel-status", tunnelStatuses[t.id]);
      }
      return list.map((t) => tunnelStatuses[t.id]) as T;
    }
    case "stop_all_tunnels": {
      const list = loadTunnels();
      for (const t of list) {
        tunnelStatuses[t.id] = { id: t.id, status: "stopped" };
        void emit("tunnel-status", tunnelStatuses[t.id]);
      }
      return list.map((t) => tunnelStatuses[t.id]) as T;
    }
    case "get_tunnel_status": {
      const id = args?.id as string;
      return (tunnelStatuses[id] ?? { id, status: "stopped" }) as T;
    }
    case "list_tunnel_statuses": {
      return Object.values(tunnelStatuses) as T;
    }
    case "test_tunnel": {
      throw new Error("Testing tunnels is only available in the desktop build.");
    }
    case "reorder_tunnels": {
      const ids = (args?.ids as string[]) ?? [];
      const list = loadTunnels();
      const byId = new Map(list.map((t) => [t.id, t]));
      const next: StubTunnelConfig[] = [];
      ids.forEach((id, idx) => {
        const t = byId.get(id);
        if (!t) return;
        next.push({ ...t, sortOrder: idx });
        byId.delete(id);
      });
      for (const t of byId.values()) next.push(t);
      saveTunnels(next);
      return undefined as T;
    }
    default:
      console.warn(`[tauri-stub] Unknown invoke command: ${cmd}`, args);
      return undefined as T;
  }
}
