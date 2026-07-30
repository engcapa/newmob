import { useEffect, useRef } from "react";
import { useT } from "../lib/i18n";
import { useUpdateStore } from "../stores/updateStore";

export interface AboutDialogProps {
  onClose: () => void;
}

export function AboutDialog({ onClose }: AboutDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const t = useT();
  const { check } = useUpdateStore();

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [onClose]);

  const handleCheckUpdate = () => {
    onClose();
    void check({ manual: true });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t("about.title")}
        aria-modal="true"
        data-testid="about-dialog"
        className="w-[380px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto rounded shadow-lg p-5"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-3">
          <div
            className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-xl shrink-0"
            style={{ background: "linear-gradient(135deg, #1e5fa8, #62d36f)" }}
          >
            N
          </div>
          <div>
            <div className="text-lg font-semibold">{t("app.name")}</div>
            <div
              tabIndex={0}
              role="button"
              data-testid="about-version"
              className="text-[12px] taomni-mono cursor-pointer hover:underline outline-none focus:underline"
              style={{ color: "var(--taomni-text-muted)" }}
              title={t("about.versionTooltip")}
              onClick={handleCheckUpdate}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  e.preventDefault();
                  handleCheckUpdate();
                }
              }}
            >
              {t("about.version", { version: __APP_VERSION__ })}
            </div>
          </div>
        </div>

        <div className="text-[12px] mb-4" style={{ color: "var(--taomni-text-muted)" }}>
          {t("about.description")}
        </div>

        <div className="flex items-center justify-between mt-4">
          <button
            type="button"
            className="taomni-btn h-8 px-3 text-[12px]"
            onClick={handleCheckUpdate}
            data-testid="about-check-update"
          >
            {t("update.checkButton")}
          </button>
          <button
            ref={closeRef}
            type="button"
            className="taomni-btn h-8 px-4"
            onClick={onClose}
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
