import { useCallback } from "react";
import {
  joinPath,
  listenSftpComplete,
  listenSftpPaused,
  listenSftpProgress,
  sftpCancelTransfer,
  sftpChmod,
  sftpDownload,
  sftpDownloadDir,
  sftpMkdir,
  sftpOpenPath,
  sftpPauseTransfer,
  sftpRemove,
  sftpRename,
  sftpResumeTransfer,
  sftpUpload,
  sftpUploadBytes,
  sftpUploadDir,
  sftpWriteFileText,
  type FileEntry,
  type FsSide,
} from "./sftp";
import { newTransferId, useTransferStore } from "../stores/transferStore";
import { useSftpStore, type PaneSide } from "../stores/sftpStore";
import { useAppStore } from "../stores/appStore";
import { encodeBase64 } from "./ipc";
import { isTauriRuntime } from "./runtime";

export interface TransferStartOpts {
  openAfter?: boolean;
}

export function useSftpController(sessionId: string) {
  const refreshPane = useSftpStore((s) => s.refreshPane);
  const setStatus = useAppStore((s) => s.setStatusMessage);
  const addTransfer = useTransferStore((s) => s.add);
  const patchTransfer = useTransferStore((s) => s.patch);
  const setTransferState = useTransferStore((s) => s.setState);

  const startTransferTracking = useCallback(
    async (transferId: string, refreshSide: PaneSide) => {
      // We must await listener registration BEFORE returning, otherwise a
      // backend (or stub) that emits the completion event synchronously can
      // race past the listeners and leave the queue row stuck as "queued".
      let unlistenProgress: (() => void) | null = null;
      let unlistenComplete: (() => void) | null = null;
      let unlistenPaused: (() => void) | null = null;

      const [progressUnlisten, pausedUnlisten, completeUnlisten] = await Promise.all([
        listenSftpProgress(transferId, (payload) => {
          patchTransfer(transferId, {
            bytes: payload.bytes,
            size: payload.total || undefined,
            rate: payload.rate,
            eta: payload.eta,
            state: "running",
          });
        }),
        listenSftpPaused(transferId, (payload) => {
          // Backend pinged us that the worker is now suspended; mirror that
          // into the UI so the badge flips from "running" to "paused".
          patchTransfer(transferId, {
            bytes: payload.bytes,
            rate: 0,
            eta: 0,
            state: "paused",
          });
        }),
        listenSftpComplete(transferId, (payload) => {
          if (payload.success) {
            setTransferState(transferId, "done");
            setStatus(`Transfer complete: ${transferId}`);
            void refreshPane(sessionId, refreshSide);
          } else {
            const isCancel = (payload.error || "").toLowerCase().includes("cancel");
            setTransferState(
              transferId,
              isCancel ? "cancelled" : "error",
              payload.error ?? "transfer failed",
            );
          }
          unlistenProgress?.();
          unlistenComplete?.();
          unlistenPaused?.();
        }),
      ]);
      unlistenProgress = progressUnlisten;
      unlistenPaused = pausedUnlisten;
      unlistenComplete = completeUnlisten;
    },
    [patchTransfer, refreshPane, sessionId, setStatus, setTransferState],
  );

  const upload = useCallback(
    async (
      entry: FileEntry,
      remoteDir: string,
      opts: TransferStartOpts = {},
    ) => {
      const isDir = entry.fileType === "dir";
      const transferId = newTransferId();
      const remotePath = joinPath(remoteDir, entry.name);
      addTransfer({
        id: transferId,
        sessionId,
        direction: "upload",
        kind: isDir ? "dir" : "file",
        localPath: entry.path,
        remotePath,
        // For folders the backend pre-walks to compute the byte total and
        // emits an initial 0/total progress frame; seed `size: 0` so the UI
        // doesn't briefly show a misleading "directory size" reading.
        size: isDir ? 0 : entry.size,
        bytes: 0,
        rate: 0,
        eta: 0,
        state: "queued",
        startedAt: Date.now(),
        openAfter: isDir ? false : opts.openAfter,
      });
      // Await listener registration so any synchronous completion event from
      // the stub layer cannot race past the listeners.
      await startTransferTracking(transferId, "remote");
      try {
        if (isDir) {
          await sftpUploadDir(sessionId, transferId, entry.path, remotePath);
        } else {
          await sftpUpload(sessionId, transferId, entry.path, remotePath, !!opts.openAfter);
        }
      } catch (err) {
        setStatus(`Upload failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [addTransfer, sessionId, setStatus, startTransferTracking],
  );

  const uploadBlob = useCallback(
    async (
      remoteDir: string,
      file: File,
    ) => {
      const transferId = newTransferId();
      const remotePath = joinPath(remoteDir, file.name);
      addTransfer({
        id: transferId,
        sessionId,
        direction: "upload",
        kind: "file",
        localPath: `OS:${file.name}`,
        remotePath,
        size: file.size,
        bytes: 0,
        rate: 0,
        eta: 0,
        state: "queued",
        startedAt: Date.now(),
      });
      await startTransferTracking(transferId, "remote");
      try {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(
            null,
            Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
          );
        }
        const b64 = btoa(binary);
        await sftpUploadBytes(sessionId, transferId, file.name, remotePath, b64);
      } catch (err) {
        setStatus(`Upload failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [addTransfer, sessionId, setStatus, startTransferTracking],
  );

  const download = useCallback(
    async (
      entry: FileEntry,
      localDir: string,
      opts: TransferStartOpts = {},
    ) => {
      const isDir = entry.fileType === "dir";
      const transferId = newTransferId();
      const localPath = joinPath(localDir, entry.name);
      addTransfer({
        id: transferId,
        sessionId,
        direction: "download",
        kind: isDir ? "dir" : "file",
        localPath,
        remotePath: entry.path,
        // Same reasoning as the upload path: the backend pre-walks the remote
        // tree to derive an accurate total before any bytes are emitted.
        size: isDir ? 0 : entry.size,
        bytes: 0,
        rate: 0,
        eta: 0,
        state: "queued",
        startedAt: Date.now(),
        openAfter: isDir ? false : opts.openAfter,
      });
      await startTransferTracking(transferId, "local");
      try {
        if (isDir) {
          await sftpDownloadDir(sessionId, transferId, entry.path, localPath);
        } else {
          await sftpDownload(sessionId, transferId, entry.path, localPath, !!opts.openAfter);
          if (opts.openAfter && isTauriRuntime()) {
            try {
              await sftpOpenPath(localPath);
            } catch (err) {
              setStatus(`Saved to ${localPath}, but could not open it: ${err}`);
            }
          }
        }
      } catch (err) {
        setStatus(`Download failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [addTransfer, sessionId, setStatus, startTransferTracking],
  );

  const mkdir = useCallback(
    async (parent: string, name: string, side: FsSide) => {
      const target = joinPath(parent, name);
      try {
        await sftpMkdir(sessionId, target, side);
        await refreshPane(sessionId, side);
      } catch (err) {
        setStatus(`mkdir failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [refreshPane, sessionId, setStatus],
  );

  const remove = useCallback(
    async (path: string, side: FsSide, recursive = true) => {
      try {
        await sftpRemove(sessionId, path, side, recursive);
        await refreshPane(sessionId, side);
      } catch (err) {
        setStatus(`Delete failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [refreshPane, sessionId, setStatus],
  );

  const rename = useCallback(
    async (oldPath: string, newName: string, side: FsSide) => {
      const parent = oldPath.includes("/")
        ? oldPath.slice(0, oldPath.lastIndexOf("/")) || "/"
        : "";
      const newPath = joinPath(parent, newName);
      try {
        await sftpRename(sessionId, oldPath, newPath, side);
        await refreshPane(sessionId, side);
      } catch (err) {
        setStatus(`Rename failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [refreshPane, sessionId, setStatus],
  );

  const cancelTransfer = useCallback(async (transferId: string) => {
    try {
      await sftpCancelTransfer(transferId);
      setTransferState(transferId, "cancelled");
    } catch (err) {
      setStatus(`Cancel failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [setStatus, setTransferState]);

  const pauseTransfer = useCallback(async (transferId: string) => {
    try {
      await sftpPauseTransfer(transferId);
      // Reflect the pause optimistically so the UI updates even if the backend
      // chunk loop hasn't observed the flag yet.
      patchTransfer(transferId, { state: "paused", rate: 0, eta: 0 });
    } catch (err) {
      setStatus(`Pause failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [patchTransfer, setStatus]);

  const resumeTransfer = useCallback(async (transferId: string) => {
    try {
      await sftpResumeTransfer(transferId);
      patchTransfer(transferId, { state: "running" });
    } catch (err) {
      setStatus(`Resume failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [patchTransfer, setStatus]);

  const retryTransfer = useCallback(async (transferId: string) => {
    const item = useTransferStore.getState().byId(transferId);
    if (!item) return;
    const { direction, remotePath, localPath, kind, openAfter } = item;
    // Use the explicit `kind` recorded at enqueue time. The previous
    // `size === 0` heuristic mis-classified legitimate empty files as
    // directories and routed them through the dir command.
    const isDir = kind === "dir";
    // Reset the existing row instead of stacking duplicates so the user keeps
    // a clean history of one entry per logical file.
    patchTransfer(transferId, {
      state: "queued",
      bytes: 0,
      rate: 0,
      eta: 0,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    });
    await startTransferTracking(transferId, direction === "upload" ? "remote" : "local");
    try {
      if (direction === "upload") {
        if (isDir) {
          await sftpUploadDir(sessionId, transferId, localPath, remotePath);
        } else {
          await sftpUpload(sessionId, transferId, localPath, remotePath, !!openAfter);
        }
      } else {
        if (isDir) {
          await sftpDownloadDir(sessionId, transferId, remotePath, localPath);
        } else {
          await sftpDownload(sessionId, transferId, remotePath, localPath, !!openAfter);
          if (openAfter && isTauriRuntime()) {
            try {
              await sftpOpenPath(localPath);
            } catch (err) {
              setStatus(`Saved to ${localPath}, but could not open it: ${err}`);
            }
          }
        }
      }
    } catch (err) {
      setStatus(`Retry failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [patchTransfer, sessionId, setStatus, startTransferTracking]);

  const chmod = useCallback(
    async (path: string, mode: number, side: FsSide) => {
      try {
        await sftpChmod(sessionId, path, mode, side);
        await refreshPane(sessionId, side);
      } catch (err) {
        setStatus(`chmod failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [refreshPane, sessionId, setStatus],
  );

  const createFile = useCallback(
    async (parent: string, name: string, side: FsSide) => {
      const target = joinPath(parent, name);
      try {
        await sftpWriteFileText(sessionId, target, side, "");
        await refreshPane(sessionId, side);
      } catch (err) {
        setStatus(`Create file failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [refreshPane, sessionId, setStatus],
  );

  const encodedAuth = useCallback((value: string | null): string | null => {
    if (value == null) return null;
    return encodeBase64(value);
  }, []);

  return {
    upload,
    uploadBlob,
    download,
    mkdir,
    remove,
    rename,
    chmod,
    createFile,
    cancelTransfer,
    pauseTransfer,
    resumeTransfer,
    retryTransfer,
    encodedAuth,
  };
}
