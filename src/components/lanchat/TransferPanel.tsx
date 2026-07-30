import { useMemo, useState, type CSSProperties } from "react";
import {
  ArrowUpDown,
  ExternalLink,
  FileText,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";
import type { LanGroup, LanPeer, LanTransferProgress } from "../../types";

export function formatTransferBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `剩余 ${Math.ceil(seconds)} 秒`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `剩余 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `剩余 ${hours} 小时 ${rest} 分钟` : `剩余 ${hours} 小时`;
}

export function transferPercent(t: LanTransferProgress): number {
  if (t.size <= 0) return t.state === "done" ? 100 : 0;
  return Math.max(0, Math.min(100, Math.floor((t.transferred / t.size) * 100)));
}

function isOngoingTransfer(t: LanTransferProgress): boolean {
  return t.state === "offering" || t.state === "active" || t.state === "paused";
}

function isFinishedTransfer(t: LanTransferProgress): boolean {
  return t.state === "done" || t.state === "failed" || t.state === "cancelled" || t.state === "rejected";
}

function stateText(t: LanTransferProgress): string {
  const pct = transferPercent(t);
  const verb = t.direction === "send" ? "发送" : "接收";
  switch (t.state) {
    case "offering":
      return t.direction === "send" ? "等待对方接收" : "等待接收";
    case "active":
      return `${verb}中 ${pct}%`;
    case "paused":
      return `已暂停 ${pct}%`;
    case "done":
      return "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "rejected":
      return "对方已拒绝";
    default:
      return t.state;
  }
}

function detailText(t: LanTransferProgress): string {
  if (t.state === "active") {
    const eta = formatEta(t.eta);
    return [formatTransferBytes(t.rate) + "/s", eta].filter(Boolean).join(" · ");
  }
  if (t.state === "done") return `${formatTransferBytes(t.size)} · 已完成`;
  return `${formatTransferBytes(t.transferred)} / ${formatTransferBytes(t.size)}`;
}

function progressColor(t: LanTransferProgress): string {
  if (t.state === "failed" || t.state === "cancelled" || t.state === "rejected") return "var(--busy,#ef4444)";
  if (t.state === "paused") return "var(--taomni-text-muted)";
  return "linear-gradient(90deg,var(--taomni-accent-soft),var(--taomni-accent))";
}

function conversationLabel(
  convId: string,
  roster: LanPeer[],
  groups: LanGroup[],
  ownName: string,
): string {
  if (convId.startsWith("direct:")) {
    const peerId = convId.slice("direct:".length);
    return roster.find((p) => p.id === peerId)?.name ?? (peerId ? peerId.slice(0, 8) : ownName);
  }
  if (convId.startsWith("group:")) {
    const groupId = convId.slice("group:".length);
    return groups.find((g) => g.id === groupId)?.name ?? "群组";
  }
  return "会话";
}

function actionButtonStyle(accent = false): CSSProperties {
  return {
    color: accent ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
    border: "1px solid var(--taomni-divider)",
    background: "var(--taomni-card-bg)",
  };
}

export function FileTransferCard({ transfer }: { transfer: LanTransferProgress }) {
  const transferControl = useLanChatStore((s) => s.transferControl);
  const openTransfer = useLanChatStore((s) => s.openTransfer);
  const openTransferFolder = useLanChatStore((s) => s.openTransferFolder);
  const sendFilePath = useLanChatStore((s) => s.sendFilePath);
  const transferPath = useLanChatStore((s) => s.transferPaths[transfer.transferId]);
  const pct = transferPercent(transfer);
  const paused = transfer.state === "paused";
  const canPauseOrCancel = isOngoingTransfer(transfer);
  const canOpen = transfer.state === "done" && !!transferPath;
  const canResend = transfer.direction === "send" && !!transferPath && isFinishedTransfer(transfer);

  return (
    <div
      data-testid="lanchat-file-card"
      data-transfer-id={transfer.transferId}
      data-transfer-state={transfer.state}
      className="min-w-[230px] max-w-[380px] rounded-lg p-3"
      style={{
        background: "var(--taomni-card-bg)",
        border: "1px solid var(--taomni-card-border)",
        boxShadow: "var(--taomni-shadow-sm)",
      }}
    >
      <div className="flex items-start gap-2.5">
        <div
          className="grid h-9 w-9 flex-none place-items-center rounded-lg"
          style={{
            background: "color-mix(in srgb, var(--taomni-accent) 13%, transparent)",
            color: "var(--taomni-accent)",
          }}
        >
          <FileText className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold" title={transfer.name}>
            {transfer.name}
          </div>
          <div className="mt-0.5 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
            {formatTransferBytes(transfer.size)} · {transfer.direction === "send" ? "发送" : "接收"} · {stateText(transfer)}
          </div>
        </div>
      </div>

      <div
        className="mt-2 h-1.5 overflow-hidden rounded"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        style={{ background: "var(--taomni-divider)" }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: progressColor(transfer),
            transition: "width .2s",
          }}
        />
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <div
          className="min-w-0 flex-1 truncate text-[11px]"
          style={{ color: transfer.state === "failed" ? "var(--busy,#ef4444)" : "var(--taomni-text-muted)" }}
        >
          {detailText(transfer)}
        </div>
        {canPauseOrCancel ? (
          <>
            <button
              type="button"
              title={paused ? "继续" : "暂停"}
              onClick={() => void transferControl(transfer.transferId, paused ? "resume" : "pause")}
              className="grid h-7 w-7 place-items-center rounded-md"
              style={actionButtonStyle()}
            >
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              title="取消"
              onClick={() => void transferControl(transfer.transferId, "cancel")}
              className="grid h-7 w-7 place-items-center rounded-md"
              style={actionButtonStyle()}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : null}
        {canOpen ? (
          <>
            <button
              type="button"
              title="打开文件"
              onClick={() => void openTransfer(transfer.transferId)}
              className="grid h-7 w-7 place-items-center rounded-md"
              style={actionButtonStyle(true)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="打开所在目录"
              onClick={() => void openTransferFolder(transfer.transferId)}
              className="grid h-7 w-7 place-items-center rounded-md"
              style={actionButtonStyle(true)}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
          </>
        ) : null}
        {canResend ? (
          <button
            type="button"
            title="重新发送"
            onClick={() => void sendFilePath(transferPath)}
            className="grid h-7 w-7 place-items-center rounded-md"
            style={actionButtonStyle(true)}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TransferTrayItem({
  transfer,
  convLabel,
}: {
  transfer: LanTransferProgress;
  convLabel: string;
}) {
  const transferControl = useLanChatStore((s) => s.transferControl);
  const openTransfer = useLanChatStore((s) => s.openTransfer);
  const pct = transferPercent(transfer);
  const paused = transfer.state === "paused";
  const canPauseOrCancel = isOngoingTransfer(transfer);

  return (
    <div className="rounded-md px-2 py-1.5" style={{ background: "var(--taomni-hover)" }}>
      <div className="flex items-center gap-2">
        <span className="w-3 text-center text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
          {transfer.direction === "send" ? "↑" : "↓"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-medium">{transfer.name}</span>
            <span className="shrink-0 text-[10px]" style={{ color: "var(--taomni-text-muted)" }}>
              {convLabel}
            </span>
          </div>
          <div className="text-[11px]" style={{ color: transfer.state === "failed" ? "var(--busy,#ef4444)" : "var(--taomni-text-muted)" }}>
            {stateText(transfer)} · {detailText(transfer)}
          </div>
        </div>
        {canPauseOrCancel ? (
          <>
            <button
              type="button"
              title={paused ? "继续" : "暂停"}
              onClick={() => void transferControl(transfer.transferId, paused ? "resume" : "pause")}
              className="grid h-6 w-6 place-items-center rounded-md"
              style={{ color: "var(--taomni-text-muted)" }}
            >
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              title="取消"
              onClick={() => void transferControl(transfer.transferId, "cancel")}
              className="grid h-6 w-6 place-items-center rounded-md"
              style={{ color: "var(--taomni-text-muted)" }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : transfer.state === "done" ? (
          <button
            type="button"
            title="打开文件"
            onClick={() => void openTransfer(transfer.transferId)}
            className="grid h-6 w-6 place-items-center rounded-md"
            style={{ color: "var(--taomni-accent)" }}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded" style={{ background: "var(--taomni-divider)" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: progressColor(transfer) }} />
      </div>
    </div>
  );
}

export function TransferTrayButton({
  placement = "bottom",
}: {
  placement?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const transfers = useLanChatStore((s) => s.transfers);
  const roster = useLanChatStore((s) => s.roster);
  const groups = useLanChatStore((s) => s.groups);
  const profile = useLanChatStore((s) => s.profile);
  const clearCompletedTransfers = useLanChatStore((s) => s.clearCompletedTransfers);

  const { all, active, recent } = useMemo(() => {
    const allTransfers = Object.values(transfers)
      .filter((t) => t.state !== "rejected")
      .sort((a, b) => a.transferId.localeCompare(b.transferId));
    return {
      all: allTransfers,
      active: allTransfers.filter(isOngoingTransfer),
      recent: allTransfers.filter((t) => isFinishedTransfer(t)).slice(0, 8),
    };
  }, [transfers]);

  if (all.length === 0) return null;

  const singleActive = active.length === 1 ? active[0] : null;
  const badge = active.length > 1
    ? String(active.length)
    : singleActive
      ? `${transferPercent(singleActive)}%`
      : "";
  const popoverPosition = placement === "top" ? "bottom-full mb-1" : "top-full mt-1";

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="lanchat-transfer-tray"
        title="文件传输"
        onClick={() => setOpen((v) => !v)}
        className="relative grid h-7 w-8 place-items-center rounded-md"
        style={{ color: active.length > 0 ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
      >
        <ArrowUpDown className="h-4 w-4" />
        {badge ? (
          <span
            className="absolute -right-1 -top-1 min-w-4 rounded-full px-1 text-center text-[9px] font-semibold leading-4 text-white"
            style={{ background: "var(--taomni-accent)" }}
          >
            {badge}
          </span>
        ) : null}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-[150]" onClick={() => setOpen(false)} />
          <div
            data-testid="lanchat-transfer-tray-popover"
            className={`absolute right-0 z-[151] ${popoverPosition} w-[330px] max-w-[calc(100vw-24px)] rounded-lg p-2 text-[12px]`}
            style={{
              background: "var(--taomni-card-bg)",
              border: "1px solid var(--taomni-card-border)",
              boxShadow: "var(--taomni-shadow-lg)",
            }}
          >
            <div className="mb-1 flex items-center px-1 text-[11px] font-semibold" style={{ color: "var(--taomni-text-muted)" }}>
              当前传输
              {active.length > 0 ? <span className="ml-1">({active.length})</span> : null}
            </div>
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {active.length > 0 ? (
                active.map((t) => (
                  <TransferTrayItem
                    key={t.transferId}
                    transfer={t}
                    convLabel={conversationLabel(t.convId, roster, groups, profile?.name ?? "我")}
                  />
                ))
              ) : (
                <div className="px-2 py-3 text-center text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
                  没有进行中的传输
                </div>
              )}
            </div>

            <div className="my-2 h-px" style={{ background: "var(--taomni-divider)" }} />
            <div className="mb-1 flex items-center gap-2 px-1">
              <span className="text-[11px] font-semibold" style={{ color: "var(--taomni-text-muted)" }}>
                最近完成
              </span>
              {recent.length > 0 ? (
                <button
                  type="button"
                  onClick={() => void clearCompletedTransfers()}
                  className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]"
                  style={{ color: "var(--taomni-text-muted)", border: "1px solid var(--taomni-divider)" }}
                >
                  <Trash2 className="h-3 w-3" />
                  清理已完成
                </button>
              ) : null}
            </div>
            <div className="flex max-h-44 flex-col gap-1 overflow-y-auto">
              {recent.length > 0 ? (
                recent.map((t) => (
                  <TransferTrayItem
                    key={t.transferId}
                    transfer={t}
                    convLabel={conversationLabel(t.convId, roster, groups, profile?.name ?? "我")}
                  />
                ))
              ) : (
                <div className="px-2 py-3 text-center text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
                  暂无完成记录
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Kept as a compatibility export; transfer UI now lives in the tray and
 * message-stream cards instead of a persistent bottom panel. */
export function TransferPanel() {
  return <TransferTrayButton placement="top" />;
}
