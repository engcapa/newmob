import { useCallback, useEffect, useState } from "react";
import { FilePanel } from "./FilePanel";
import { ChmodDialog } from "./ChmodDialog";
import { useSftpStore } from "../../stores/sftpStore";
import { useSftpController } from "../../lib/sftpController";
import { sftpOpenPath, effectiveFileType, type FileEntry } from "../../lib/sftp";
import { useAppStore } from "../../stores/appStore";
import type { MenuItem } from "../ContextMenu";
import { useT } from "../../lib/i18n";
import { useConfirmDialog, useTextInputDialog } from "../sidebar/ConfirmDialog";

interface Props {
  /** Stable id used to namespace this tab's pane state in `sftpStore`. */
  tabId: string;
  initialPath: string;
}

/**
 * Single-pane local file browser used by File-type sessions. Reuses the
 * same `FilePanel` (toolbar, sortable columns, breadcrumb, hidden toggle,
 * filter box) as the SFTP browser's local pane — wiring the LOCAL side of
 * a synthetic store entry that has no remote channel attached.
 */
export function LocalFileBrowserPanel({ tabId, initialPath }: Props) {
  const t = useT();
  const session = useSftpStore((s) => s.sessions[tabId]);
  const attachLocalOnly = useSftpStore((s) => s.attachLocalOnly);
  const detachLocalOnly = useSftpStore((s) => s.detachLocalOnly);
  const navigate = useSftpStore((s) => s.navigate);
  const setStatus = useAppStore((s) => s.setStatusMessage);
  const controller = useSftpController(tabId);
  const { confirm: confirmDialog, render: confirmDialogRender } = useConfirmDialog();
  const { promptText, render: textInputDialogRender } = useTextInputDialog();

  const [chmodPrompt, setChmodPrompt] = useState<{ entries: FileEntry[] } | null>(null);
  const [filterText, setFilterText] = useState("");

  useEffect(() => {
    if (!session?.attached) {
      void attachLocalOnly(tabId, initialPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  useEffect(() => {
    return () => {
      detachLocalOnly(tabId);
    };
  }, [tabId, detachLocalOnly]);

  const handleOpen = useCallback(async (entries: FileEntry[]) => {
    for (const entry of entries) {
      if (effectiveFileType(entry) === "dir") {
        await navigate(tabId, "local", entry.path);
        return;
      }
      try {
        await sftpOpenPath(entry.path);
      } catch (err) {
        setStatus(t("fileBrowser.statusFailedToOpen", { name: entry.name, error: String(err) }));
      }
    }
  }, [navigate, setStatus, tabId, t]);

  const handleDoubleClick = useCallback(async (entry: FileEntry) => {
    if (effectiveFileType(entry) === "dir") {
      await navigate(tabId, "local", entry.path);
      return;
    }
    try {
      await sftpOpenPath(entry.path);
    } catch (err) {
      setStatus(t("fileBrowser.statusFailedToOpen", { name: entry.name, error: String(err) }));
    }
  }, [navigate, setStatus, tabId, t]);

  const renameEntry = useCallback(
    async (entry: FileEntry) => {
      const next = await promptText({
        title: t("fileBrowser.promptRenameTitle"),
        initialValue: entry.name,
      });
      if (next && next !== entry.name) {
        void controller.rename(entry.path, next, "local");
      }
    },
    [controller, promptText, t],
  );

  const deleteEntries = useCallback(
    async (entries: FileEntry[]) => {
      if (entries.length === 0) return;
      const summary = entries.length === 1
        ? entries[0].name
        : t("fileBrowser.summaryItems", { count: entries.length });
      const confirmed = await confirmDialog({
        message: t("fileBrowser.confirmDeleteSummary", { summary }),
        confirmLabel: t("common.delete"),
        danger: true,
      });
      if (!confirmed) return;
      for (const entry of entries) {
        void controller.remove(entry.path, "local", true);
      }
    },
    [confirmDialog, controller, t],
  );

  const createFolder = useCallback(
    async () => {
      const name = await promptText({
        title: t("fileBrowser.promptNewFolderTitle"),
        initialValue: t("fileBrowser.promptNewFolderDefault"),
      });
      if (name) void controller.mkdir(session?.local.path ?? "", name, "local");
    },
    [controller, promptText, session?.local.path, t],
  );

  const createFile = useCallback(
    async () => {
      const name = await promptText({
        title: t("fileBrowser.promptNewFileTitle"),
        initialValue: t("fileBrowser.promptNewFileDefault"),
      });
      if (name) void controller.createFile(session?.local.path ?? "", name, "local");
    },
    [controller, promptText, session?.local.path, t],
  );

  const localContext = useCallback(
    (entry: FileEntry, _anchor: { x: number; y: number }, selectedEntries: FileEntry[]): MenuItem[] => {
      const targets = selectedEntries.length > 0 ? selectedEntries : [entry];
      const target = targets[0] ?? entry;
      const multi = targets.length > 1;
      const items: MenuItem[] = [];
      const effective = effectiveFileType(entry);
      items.push({
        label: effective === "dir"
          ? t("fileBrowser.contextOpenFolder")
          : multi
            ? t("fileBrowser.contextOpenFiles", { count: targets.length })
            : t("fileBrowser.contextOpen"),
        onClick: () => void handleOpen(targets),
      });
      if (!multi) {
        items.push({
          label: t("fileBrowser.contextRevealInOs"),
          onClick: () => {
            const path = effective === "dir" ? target.path : (session?.local.path ?? "");
            void sftpOpenPath(path).catch((err) => setStatus(t("fileBrowser.statusOpenFailed", { error: String(err) })));
          },
        });
      }
      if (!multi) {
        items.push({
          label: t("fileBrowser.contextRename"),
          onClick: () => void renameEntry(target),
        });
      }
      items.push({
        label: multi ? t("fileBrowser.contextPermissionsCount", { count: targets.length }) : t("fileBrowser.contextPermissions"),
        onClick: () => setChmodPrompt({ entries: targets }),
      });
      items.push({
        label: multi ? t("fileBrowser.contextDeleteCount", { count: targets.length }) : t("fileBrowser.contextDelete"),
        onClick: () => void deleteEntries(targets),
        danger: true,
      });
      return items;
    },
    [deleteEntries, handleOpen, renameEntry, session?.local.path, setStatus, t],
  );

  const localEmptyContext = useCallback(
    (): MenuItem[] => [
      {
        label: t("fileBrowser.contextNewFolder"),
        onClick: () => void createFolder(),
      },
      {
        label: t("fileBrowser.contextNewFile"),
        onClick: () => void createFile(),
      },
      {
        label: t("fileBrowser.contextRefresh"),
        onClick: () => {
          void useSftpStore.getState().refreshPane(tabId, "local");
        },
      },
      {
        label: t("fileBrowser.contextOpenCurrentInOs"),
        onClick: () => {
          void sftpOpenPath(session?.local.path ?? "")
            .catch((err) => setStatus(t("fileBrowser.statusOpenFailed", { error: String(err) })));
        },
      },
    ],
    [createFile, createFolder, session?.local.path, setStatus, tabId, t],
  );

  if (!session?.attached) {
    return (
      <div
        className="w-full h-full flex items-center justify-center text-[12px]"
        style={{ background: "var(--taomni-bg)", color: "var(--taomni-text-muted)" }}
      >
        {t("fileBrowser.localBrowserLoading")}
      </div>
    );
  }

  return (
    <div
      data-testid="file-browser-pane"
      data-tab-id={tabId}
      className="w-full h-full flex flex-col"
      style={{ background: "var(--taomni-bg)" }}
    >
      <FilePanel
        sessionId={tabId}
        side="local"
        onItemDoubleClick={(e) => void handleDoubleClick(e)}
        onItemContext={localContext}
        onEmptyContext={localEmptyContext}
        onOpenLocalSelected={(entries) => void handleOpen(entries)}
        onRevealInOs={(path) => {
          if (!path) return;
          void sftpOpenPath(path).catch((err) => setStatus(t("fileBrowser.statusOpenFailed", { error: String(err) })));
        }}
        filterText={filterText}
        onFilterTextChange={setFilterText}
        onDeleteSelected={(entries) => {
          void deleteEntries(entries);
        }}
        onChmodSelected={(entries) => {
          if (entries.length === 0) return;
          setChmodPrompt({ entries });
        }}
        onNewFolder={() => void createFolder()}
        onNewFile={() => void createFile()}
      />

      {chmodPrompt && (
        <ChmodDialog
          entries={chmodPrompt.entries}
          onCancel={() => setChmodPrompt(null)}
          onApply={(mode, recursive) => {
            for (const entry of chmodPrompt.entries) {
              if (recursive && entry.fileType === "dir") {
                void controller.chmodRecursive(entry.path, mode, "local");
              } else {
                void controller.chmod(entry.path, mode, "local");
              }
            }
            setChmodPrompt(null);
          }}
        />
      )}
      {confirmDialogRender}
      {textInputDialogRender}
    </div>
  );
}
