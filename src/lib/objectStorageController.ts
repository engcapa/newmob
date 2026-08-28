import { useCallback } from "react";
import { joinPath, sftpListLocal, sftpLocalHome, type FileEntry } from "./sftp";
import {
  listenStorageComplete,
  listenStoragePaused,
  listenStorageProgress,
  storageCancelTransfer,
  storageCopyObject,
  storageCreateBucket,
  storageCreateFolder,
  storageDeleteBucket,
  storageDeleteObject,
  storageDeletePrefix,
  storageDownload,
  storageListObjects,
  storageMoveObject,
  storageMovePrefix,
  storagePauseTransfer,
  storageResumeTransfer,
  storageShareUrl,
  storageUpload,
} from "./objectStorage";
import { newTransferId, useTransferStore } from "../stores/transferStore";
import { useObjectStorageStore } from "../stores/objectStorageStore";
import { useAppStore } from "../stores/appStore";
import type { PaneSide } from "../stores/sftpStore";

/** Split a remote object path ("/bucket/a/b.txt") into bucket + key. */
export function splitRemote(path: string): { bucket: string; key: string } {
  const trimmed = path.replace(/^\/+/, "");
  const i = trimmed.indexOf("/");
  if (i < 0) return { bucket: trimmed, key: "" };
  return { bucket: trimmed.slice(0, i), key: trimmed.slice(i + 1) };
}

/** Parent prefix of a key ("a/b/c.txt" -> "a/b/", "c.txt" -> ""). */
function parentPrefix(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? "" : trimmed.slice(0, i + 1);
}

function folderMarkerKey(key: string): string {
  return key.endsWith("/") ? key : `${key}/`;
}

function firstFolderSegment(name: string): string {
  return name.trim().replace(/^[/\\]+/, "").split(/[\\/]/).filter(Boolean)[0] ?? "";
}

function remoteDirEntry(bucket: string, key: string, name: string): FileEntry {
  return {
    name,
    path: `/${bucket}/${key}`,
    size: 0,
    mtime: Math.floor(Date.now() / 1000),
    mode: 0,
    fileType: "dir",
    isHidden: false,
  };
}

function remoteBucketEntry(name: string): FileEntry {
  return {
    name,
    path: `/${name}`,
    size: 0,
    mtime: Math.floor(Date.now() / 1000),
    mode: 0,
    fileType: "dir",
    isHidden: false,
  };
}

export function useObjectStorageController(sessionId: string) {
  const refreshPane = useObjectStorageStore((s) => s.refreshPane);
  const upsertRemoteEntry = useObjectStorageStore((s) => s.upsertRemoteEntry);
  const removeRemoteEntries = useObjectStorageStore((s) => s.removeRemoteEntries);
  const setStatus = useAppStore((s) => s.setStatusMessage);
  const addTransfer = useTransferStore((s) => s.add);
  const patchTransfer = useTransferStore((s) => s.patch);
  const setTransferState = useTransferStore((s) => s.setState);

  const startTracking = useCallback(
    async (transferId: string, refreshSide: PaneSide) => {
      let unlistenProgress: (() => void) | null = null;
      let unlistenComplete: (() => void) | null = null;
      let unlistenPaused: (() => void) | null = null;
      const [p, pa, c] = await Promise.all([
        listenStorageProgress(transferId, (payload) => {
          patchTransfer(transferId, {
            bytes: payload.bytes,
            size: payload.total || undefined,
            rate: payload.rate,
            eta: payload.eta,
            state: "running",
          });
        }),
        listenStoragePaused(transferId, (payload) => {
          patchTransfer(transferId, { bytes: payload.bytes, rate: 0, eta: 0, state: "paused" });
        }),
        listenStorageComplete(transferId, (payload) => {
          if (payload.success) {
            setTransferState(transferId, "done");
            void refreshPane(sessionId, refreshSide);
          } else {
            const isCancel = (payload.error || "").toLowerCase().includes("cancel");
            setTransferState(transferId, isCancel ? "cancelled" : "error", payload.error ?? "transfer failed");
          }
          unlistenProgress?.();
          unlistenComplete?.();
          unlistenPaused?.();
        }),
      ]);
      unlistenProgress = p;
      unlistenPaused = pa;
      unlistenComplete = c;
      patchTransfer(transferId, { state: "running" });
    },
    [patchTransfer, refreshPane, sessionId, setTransferState],
  );

  const downloadFile = useCallback(
    async (bucket: string, key: string, localPath: string, size: number) => {
      const transferId = newTransferId();
      addTransfer({
        id: transferId,
        sessionId,
        direction: "download",
        kind: "file",
        localPath,
        remotePath: `/${bucket}/${key}`,
        size,
        bytes: 0,
        rate: 0,
        eta: 0,
        state: "queued",
        startedAt: Date.now(),
      });
      await startTracking(transferId, "local");
      try {
        await storageDownload(sessionId, transferId, bucket, key, localPath);
        setTransferState(transferId, "done");
        await refreshPane(sessionId, "local");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTransferState(transferId, "error", message);
        setStatus(`Download failed: ${message}`);
      }
    },
    [addTransfer, refreshPane, sessionId, setStatus, setTransferState, startTracking],
  );

  const uploadFile = useCallback(
    async (localPath: string, bucket: string, key: string, size: number) => {
      const transferId = newTransferId();
      addTransfer({
        id: transferId,
        sessionId,
        direction: "upload",
        kind: "file",
        localPath,
        remotePath: `/${bucket}/${key}`,
        size,
        bytes: 0,
        rate: 0,
        eta: 0,
        state: "queued",
        startedAt: Date.now(),
      });
      await startTracking(transferId, "remote");
      try {
        await storageUpload(sessionId, transferId, bucket, key, localPath);
        setTransferState(transferId, "done");
        await refreshPane(sessionId, "remote");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTransferState(transferId, "error", message);
        setStatus(`Upload failed: ${message}`);
      }
    },
    [addTransfer, refreshPane, sessionId, setStatus, setTransferState, startTracking],
  );

  // Recursively download every object under `prefix` into `localBase`,
  // enqueuing one transfer per file. Subfolders descend (delimiter listing).
  const downloadPrefixTree = useCallback(
    async (bucket: string, prefix: string, localBase: string) => {
      let token: string | null = null;
      do {
        const page = await storageListObjects(sessionId, bucket, prefix, token);
        for (const e of page.entries) {
          if (e.isDir) {
            await downloadPrefixTree(bucket, e.key, joinPath(localBase, e.name));
          } else {
            await downloadFile(bucket, e.key, joinPath(localBase, e.name), e.size);
          }
        }
        token = page.nextToken ?? null;
      } while (token);
    },
    [downloadFile, sessionId],
  );

  const uploadDirTree = useCallback(
    async (localDir: string, bucket: string, destPrefix: string) => {
      const entries = await sftpListLocal(localDir);
      for (const e of entries) {
        if (e.fileType === "dir") {
          await uploadDirTree(e.path, bucket, `${destPrefix}${e.name}/`);
        } else if (e.fileType === "file") {
          await uploadFile(e.path, bucket, `${destPrefix}${e.name}`, e.size);
        }
      }
    },
    [uploadFile],
  );

  const download = useCallback(
    async (entry: FileEntry, localDir: string) => {
      let dir = localDir;
      if (!dir) dir = await sftpLocalHome().catch(() => "");
      if (!dir) {
        setStatus("Download failed: pick a folder in the LOCAL pane first.");
        return;
      }
      const { bucket, key } = splitRemote(entry.path);
      if (!bucket) return;
      if (entry.fileType === "dir") {
        await downloadPrefixTree(bucket, key, joinPath(dir, entry.name));
      } else {
        await downloadFile(bucket, key, joinPath(dir, entry.name), entry.size);
      }
    },
    [downloadFile, downloadPrefixTree, setStatus],
  );

  const upload = useCallback(
    async (entry: FileEntry, remoteDir: string) => {
      const { bucket, key: prefix } = splitRemote(remoteDir);
      if (!bucket) {
        setStatus("Upload failed: open a bucket first.");
        return;
      }
      if (entry.fileType === "dir") {
        await uploadDirTree(entry.path, bucket, `${prefix}${entry.name}/`);
      } else {
        await uploadFile(entry.path, bucket, `${prefix}${entry.name}`, entry.size);
      }
    },
    [setStatus, uploadDirTree, uploadFile],
  );

  // Create a folder, or — at the bucket-list root — a new bucket.
  const mkdir = useCallback(
    async (remoteParent: string, name: string) => {
      const { bucket, key: prefix } = splitRemote(remoteParent);
      const cleanName = name.trim();
      const folderName = cleanName.replace(/^[/\\]+|[/\\]+$/g, "");
      const visibleName = firstFolderSegment(folderName);
      if (!cleanName || (!bucket && !visibleName)) return;
      try {
        if (!bucket) {
          await storageCreateBucket(sessionId, cleanName);
          await refreshPane(sessionId, "remote");
          upsertRemoteEntry(sessionId, remoteBucketEntry(cleanName));
        } else {
          if (!folderName) return;
          const markerKey = folderMarkerKey(`${prefix}${folderName}`);
          await storageCreateFolder(sessionId, bucket, markerKey);
          await refreshPane(sessionId, "remote");
          if (visibleName) {
            upsertRemoteEntry(
              sessionId,
              remoteDirEntry(bucket, folderMarkerKey(`${prefix}${visibleName}`), visibleName),
            );
          }
        }
      } catch (err) {
        setStatus(`Create failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [refreshPane, sessionId, setStatus, upsertRemoteEntry],
  );

  const remove = useCallback(
    async (entry: FileEntry) => {
      const { bucket, key } = splitRemote(entry.path);
      try {
        if (!key) {
          await storageDeleteBucket(sessionId, bucket);
        } else if (entry.fileType === "dir") {
          await storageDeletePrefix(sessionId, bucket, key);
        } else {
          await storageDeleteObject(sessionId, bucket, key);
        }
        await refreshPane(sessionId, "remote");
        removeRemoteEntries(sessionId, [entry.path]);
      } catch (err) {
        setStatus(`Delete failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [refreshPane, removeRemoteEntries, sessionId, setStatus],
  );

  const rename = useCallback(
    async (entry: FileEntry, newName: string) => {
      const { bucket, key } = splitRemote(entry.path);
      if (!bucket || !key) {
        setStatus("Rename is not supported for buckets.");
        return;
      }
      try {
        const prefix = parentPrefix(key);
        if (entry.fileType === "dir") {
          const oldPrefix = key.endsWith("/") ? key : `${key}/`;
          const newPrefix = `${prefix}${newName}/`;
          await storageMovePrefix(sessionId, bucket, oldPrefix, newPrefix);
          removeRemoteEntries(sessionId, [entry.path]);
          upsertRemoteEntry(sessionId, remoteDirEntry(bucket, newPrefix, newName));
        } else {
          const newKey = `${prefix}${newName}`;
          await storageMoveObject(sessionId, bucket, key, bucket, newKey);
          removeRemoteEntries(sessionId, [entry.path]);
          upsertRemoteEntry(sessionId, {
            ...entry,
            name: newName,
            path: `/${bucket}/${newKey}`,
          });
        }
        await refreshPane(sessionId, "remote");
      } catch (err) {
        setStatus(`Rename failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [refreshPane, removeRemoteEntries, sessionId, setStatus, upsertRemoteEntry],
  );

  const copyTo = useCallback(
    async (entry: FileEntry, destRemoteDir: string) => {
      const src = splitRemote(entry.path);
      const dst = splitRemote(destRemoteDir);
      if (!src.bucket || !dst.bucket || entry.fileType === "dir") {
        setStatus("Copy currently supports single objects between buckets/prefixes.");
        return;
      }
      try {
        await storageCopyObject(sessionId, src.bucket, src.key, dst.bucket, `${dst.key}${entry.name}`);
        await refreshPane(sessionId, "remote");
      } catch (err) {
        setStatus(`Copy failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [refreshPane, sessionId, setStatus],
  );

  const shareUrl = useCallback(
    async (entry: FileEntry, ttlSecs: number): Promise<string | null> => {
      const { bucket, key } = splitRemote(entry.path);
      if (!bucket || !key || entry.fileType === "dir") {
        setStatus("Share links are for single objects only.");
        return null;
      }
      try {
        const url = await storageShareUrl(sessionId, bucket, key, ttlSecs);
        try {
          await navigator.clipboard.writeText(url);
          setStatus("Share link copied to clipboard.");
        } catch {
          setStatus("Share link generated.");
        }
        return url;
      } catch (err) {
        setStatus(`Share failed: ${err instanceof Error ? err.message : err}`);
        return null;
      }
    },
    [sessionId, setStatus],
  );

  const cancelTransfer = useCallback(async (transferId: string) => {
    try {
      await storageCancelTransfer(transferId);
      setTransferState(transferId, "cancelled");
    } catch (err) {
      setStatus(`Cancel failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [setStatus, setTransferState]);

  const pauseTransfer = useCallback(async (transferId: string) => {
    try {
      await storagePauseTransfer(transferId);
      patchTransfer(transferId, { state: "paused", rate: 0, eta: 0 });
    } catch (err) {
      setStatus(`Pause failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [patchTransfer, setStatus]);

  const resumeTransfer = useCallback(async (transferId: string) => {
    try {
      await storageResumeTransfer(transferId);
      patchTransfer(transferId, { state: "running" });
    } catch (err) {
      setStatus(`Resume failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [patchTransfer, setStatus]);

  return {
    download,
    upload,
    mkdir,
    remove,
    rename,
    copyTo,
    shareUrl,
    cancelTransfer,
    pauseTransfer,
    resumeTransfer,
  };
}
