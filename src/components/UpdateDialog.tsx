import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useUpdateStore } from "../stores/updateStore";
import { useT, type TranslateFn } from "../lib/i18n";

const DANGER = "#e5534b";

// macOS arch tokens get friendly names; other OSes only ever have one
// candidate, so the raw arch is fine there.
function archLabel(t: TranslateFn, os: string | null, target: string): string {
  const arch = target.split("-")[1] ?? target;
  if (os === "darwin") {
    if (arch === "aarch64") return t("update.archAppleSilicon");
    if (arch === "x86_64") return t("update.archIntel");
  }
  return arch;
}

/**
 * Update prompt with two explicit confirmation gates:
 *   #1 — nothing downloads/installs until the user clicks "Download and install"
 *   #2 — the app never restarts on its own; the user clicks "Restart now"
 * Plus a package/arch selector when more than one build can run on this machine.
 */
export function UpdateDialog() {
  const t = useT();
  const s = useUpdateStore();

  const downloading = s.status === "downloading";
  const percent = s.progress?.percent ?? null;
  const installing = downloading && percent === 100;
  const canDownload =
    s.status === "available" && s.targetStatus !== "checking" && s.targetStatus !== "unavailable";
  // A download must run to completion without being dismissed by an accidental
  // click-away or Escape — only the explicit Cancel button (which calls
  // closeDialog directly) can hide it. Every other state is freely dismissable.
  const dismissable = s.status !== "downloading";

  const close = () => {
    if (dismissable) s.closeDialog();
  };

  // The dialog can be dragged by its title bar so it can be moved aside — it
  // matters for the non-modal "checking"/"downloading" states, where the app
  // stays usable underneath. The offset is relative to the centered resting
  // position and is cleared whenever the dialog closes, so each open recenters.
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useEffect(() => {
    if (!s.dialogOpen) setDragOffset({ x: 0, y: 0 });
  }, [s.dialogOpen]);

  useEffect(() => {
    if (!s.dialogOpen) return;
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [s.dialogOpen, dismissable]);

  if (!s.dialogOpen) return null;

  const showArch = s.candidates.length > 1;

  // The "checking" and "downloading" phases render as non-modal floating
  // dialogs: they must not dim or block the rest of the app, and a download
  // must keep running to completion (losing focus must not dismiss it). The
  // user can keep working — and drag the dialog aside by its title bar — while
  // the background work runs. Result states stay modal.
  const nonModal = s.status === "checking" || downloading;

  const onTitlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      originX: dragOffset.x,
      originY: dragOffset.y,
    };
    const handleMove = (ev: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      setDragOffset({
        x: start.originX + (ev.clientX - start.pointerX),
        y: start.originY + (ev.clientY - start.pointerY),
      });
    };
    const stop = () => {
      dragStartRef.current = null;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const title =
    s.status === "checking"
      ? t("update.checkButton")
      : s.status === "error"
        ? t("update.errorTitle")
        : s.status === "ready"
          ? t("update.readyTitle")
          : s.status === "uptodate"
            ? t("update.upToDateTitle")
            : t("update.title");

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center${nonModal ? " pointer-events-none" : ""}`}
      style={nonModal ? undefined : { background: "rgba(0,0,0,0.4)" }}
      onClick={nonModal ? undefined : close}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        aria-modal={nonModal ? undefined : "true"}
        data-testid="update-dialog"
        className={`w-[440px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto rounded shadow-lg p-5${nonModal ? " pointer-events-auto" : ""}`}
        style={{
          background: "var(--taomni-bg)",
          border: "1px solid var(--taomni-card-border)",
          transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="text-lg font-semibold mb-3 cursor-move select-none"
          style={{ touchAction: "none" }}
          onPointerDown={onTitlePointerDown}
        >
          {title}
        </div>

        {s.status === "checking" && (
          <div className="text-[13px] mb-4 flex items-center gap-2" style={{ color: "var(--taomni-text-muted)" }}>
            <span className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-[var(--taomni-text-muted)] border-t-transparent inline-block" />
            {t("update.statusChecking")}
          </div>
        )}

        {s.status === "uptodate" && (
          <div className="text-[13px] mb-4" style={{ color: "var(--taomni-text-muted)" }}>
            {t("update.statusUpToDate")}
          </div>
        )}

        {s.status === "error" && (
          <div data-testid="update-error" className="text-[13px] mb-4" style={{ color: DANGER }}>
            {s.error}
          </div>
        )}

        {s.status === "ready" && (
          <div className="text-[13px] mb-4" style={{ color: "var(--taomni-text-muted)" }}>
            {t("update.readyBody", { version: s.availableVersion ?? "" })}
          </div>
        )}

        {(s.status === "available" || downloading) && (
          <>
            <div className="text-[12px] taomni-mono mb-1" style={{ color: "var(--taomni-text-muted)" }}>
              {t("update.currentVersion", { version: s.currentVersion ?? "" })} →{" "}
              {t("update.newVersion", { version: s.availableVersion ?? "" })}
            </div>
            <div className="text-[13px] font-medium mt-3 mb-1">{t("update.notesTitle")}</div>
            <div
              className="text-[12px] mb-3 max-h-40 overflow-auto whitespace-pre-wrap"
              style={{ color: "var(--taomni-text-muted)" }}
            >
              {s.notes || t("update.noNotes")}
            </div>

            {showArch && (
              <div className="mb-3">
                <div className="text-[13px] font-medium mb-1">{t("update.archTitle")}</div>
                <div className="flex flex-wrap gap-2">
                  {s.candidates.map((target) => {
                    const selected = s.selectedTarget === target;
                    const tags = [
                      target === s.nativeTarget ? t("update.archCurrent") : null,
                      target === s.recommendedTarget ? t("update.archRecommended") : null,
                    ].filter(Boolean);
                    return (
                      <button
                        key={target}
                        type="button"
                        disabled={downloading}
                        onClick={() => void s.setSelectedTarget(target)}
                        className="taomni-btn h-8 px-3 text-[12px]"
                        data-primary={selected ? "true" : undefined}
                        data-testid={`update-arch-${target}`}
                        aria-pressed={selected}
                      >
                        {archLabel(t, s.os, target)}
                        {tags.length ? ` · ${tags.join(" · ")}` : ""}
                      </button>
                    );
                  })}
                </div>
                {s.targetStatus === "checking" && (
                  <div className="text-[12px] mt-1" style={{ color: "var(--taomni-text-muted)" }}>
                    {t("update.archChecking")}
                  </div>
                )}
                {s.targetStatus === "unavailable" && (
                  <div className="text-[12px] mt-1" style={{ color: DANGER }}>
                    {t("update.archUnavailable")}
                  </div>
                )}
                {s.isRosetta && (
                  <div className="text-[12px] mt-1" style={{ color: "var(--taomni-warning-text)" }}>
                    {t("update.rosettaHint")}
                  </div>
                )}
              </div>
            )}

            {downloading && (
              <div className="mb-3" data-testid="update-progress">
                <div className="h-2 rounded overflow-hidden" style={{ background: "var(--taomni-card-border)" }}>
                  <div
                    className="h-full"
                    style={{
                      width: `${percent ?? 0}%`,
                      background: "linear-gradient(90deg, #1e5fa8, #62d36f)",
                      transition: "width 120ms linear",
                    }}
                  />
                </div>
                <div className="text-[12px] mt-1" style={{ color: "var(--taomni-text-muted)" }}>
                  {installing
                    ? t("update.installing")
                    : percent === null
                      ? t("update.downloadingUnknown")
                      : t("update.downloading", { percent })}
                </div>
              </div>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 mt-2">
          {s.status === "available" && (
            <>
              <button type="button" className="taomni-btn h-8 px-4" onClick={s.closeDialog}>
                {t("update.later")}
              </button>
              <button
                type="button"
                className="taomni-btn h-8 px-4"
                data-primary="true"
                disabled={!canDownload}
                onClick={() => void s.startDownload()}
                data-testid="update-download"
              >
                {t("update.downloadAndInstall")}
              </button>
            </>
          )}
          {s.status === "ready" && (
            <>
              <button type="button" className="taomni-btn h-8 px-4" onClick={s.closeDialog}>
                {t("update.later")}
              </button>
              <button
                type="button"
                className="taomni-btn h-8 px-4"
                data-primary="true"
                onClick={() => void s.restart()}
                data-testid="update-restart"
              >
                {t("update.restartNow")}
              </button>
            </>
          )}
          {s.status === "error" && (
            <>
              <button type="button" className="taomni-btn h-8 px-4" onClick={s.closeDialog}>
                {t("common.close")}
              </button>
              <button
                type="button"
                className="taomni-btn h-8 px-4"
                data-primary="true"
                onClick={() => void s.check({ manual: true })}
              >
                {t("update.retry")}
              </button>
            </>
          )}
          {(s.status === "uptodate" || s.status === "checking" || s.status === "downloading") && (
            <button type="button" className="taomni-btn h-8 px-4" onClick={s.closeDialog}>
              {s.status === "downloading" ? t("common.cancel") : t("common.close")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
