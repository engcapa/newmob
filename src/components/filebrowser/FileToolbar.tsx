import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RefreshCw,
  FolderPlus,
  FilePlus,
  Eye,
  EyeOff,
  Maximize2,
  Download,
  Upload,
  HardDriveUpload,
  Trash2,
  KeyRound,
  FileText,
  Terminal,
} from "lucide-react";
import type { ReactNode } from "react";

interface FileToolbarProps {
  side: "local" | "remote";
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  showHidden: boolean;
  loading?: boolean;
  selectionCount: number;
  canPreview?: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onToggleHidden: () => void;
  onMkdir: () => void;
  onNewFile?: () => void;
  onDelete?: () => void;
  onChmod?: () => void;
  onPreview?: () => void;
  /** Remote pane: download selected files to local. Local pane: undefined. */
  onDownloadSelected?: () => void;
  /** Local pane: upload selected files to remote. Remote pane: undefined. */
  onUploadSelected?: () => void;
  /** Open OS file picker and upload to current dir (remote pane only in browser). */
  onUploadFromDisk?: () => void;
  /** Remote pane only: ask the parent terminal to `cd` into the current dir. */
  onOpenTerminalHere?: () => void;
  onDetach?: () => void;
  rightExtras?: ReactNode;
}

export function FileToolbar(props: FileToolbarProps) {
  const {
    side,
    canBack,
    canForward,
    canUp,
    showHidden,
    loading,
    selectionCount,
    canPreview,
    onBack,
    onForward,
    onUp,
    onRefresh,
    onToggleHidden,
    onMkdir,
    onNewFile,
    onDelete,
    onChmod,
    onPreview,
    onDownloadSelected,
    onUploadSelected,
    onUploadFromDisk,
    onOpenTerminalHere,
    onDetach,
    rightExtras,
  } = props;

  const hasSelection = selectionCount > 0;

  return (
    <div
      className="h-7 flex items-center gap-0.5 px-1 border-b shrink-0 overflow-x-auto"
      style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}
    >
      <ToolBtn title="Back" disabled={!canBack} onClick={onBack}>
        <ArrowLeft className="w-3.5 h-3.5" />
      </ToolBtn>
      <ToolBtn title="Forward" disabled={!canForward} onClick={onForward}>
        <ArrowRight className="w-3.5 h-3.5" />
      </ToolBtn>
      <ToolBtn title="Up" disabled={!canUp} onClick={onUp}>
        <ArrowUp className="w-3.5 h-3.5" />
      </ToolBtn>
      <Sep />
      <ToolBtn title="Refresh" onClick={onRefresh}>
        <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
      </ToolBtn>

      {side === "remote" && onDownloadSelected && (
        <ToolBtn
          title={hasSelection ? `Download ${selectionCount} selected to local` : "Download selected to local"}
          disabled={!hasSelection}
          onClick={onDownloadSelected}
        >
          <Download className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {side === "local" && onUploadSelected && (
        <ToolBtn
          title={hasSelection ? `Upload ${selectionCount} selected to remote` : "Upload selected to remote"}
          disabled={!hasSelection}
          onClick={onUploadSelected}
        >
          <Upload className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {side === "remote" && onUploadFromDisk && (
        <ToolBtn title="Upload files from this computer" onClick={onUploadFromDisk}>
          <HardDriveUpload className="w-3.5 h-3.5" />
        </ToolBtn>
      )}

      <Sep />
      <ToolBtn title="New folder" onClick={onMkdir}>
        <FolderPlus className="w-3.5 h-3.5" />
      </ToolBtn>
      {onNewFile && (
        <ToolBtn title="New file" onClick={onNewFile}>
          <FilePlus className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {onDelete && (
        <ToolBtn
          title={hasSelection ? `Delete ${selectionCount} selected` : "Delete selected"}
          disabled={!hasSelection}
          onClick={onDelete}
          danger
        >
          <Trash2 className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {onChmod && (
        <ToolBtn
          title="Permissions (chmod)…"
          disabled={selectionCount !== 1}
          onClick={onChmod}
        >
          <KeyRound className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {onPreview && (
        <ToolBtn
          title="View / preview text file"
          disabled={!canPreview}
          onClick={onPreview}
        >
          <FileText className="w-3.5 h-3.5" />
        </ToolBtn>
      )}

      <Sep />
      <ToolBtn
        title={showHidden ? "Hide hidden files" : "Show hidden files"}
        onClick={onToggleHidden}
        active={showHidden}
      >
        {showHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </ToolBtn>
      {side === "remote" && onOpenTerminalHere && (
        <ToolBtn title="Open terminal at this path (cd into it)" onClick={onOpenTerminalHere}>
          <Terminal className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {onDetach && (
        <ToolBtn title="Detach to its own window" onClick={onDetach}>
          <Maximize2 className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      <div className="flex-1" />
      {rightExtras}
    </div>
  );
}

function Sep() {
  return (
    <span
      className="inline-block h-4 mx-0.5 shrink-0"
      style={{ width: 1, background: "var(--moba-divider)" }}
    />
  );
}

function ToolBtn({
  children,
  title,
  onClick,
  disabled,
  active,
  danger,
}: {
  children: ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="w-6 h-6 inline-flex items-center justify-center rounded shrink-0 hover:bg-[var(--moba-hover)] disabled:opacity-30 disabled:cursor-default"
      style={{
        background: active ? "var(--moba-selected)" : undefined,
        color: danger && !disabled ? "#c0392b" : undefined,
      }}
    >
      {children}
    </button>
  );
}
