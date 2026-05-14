import { useEffect, useRef } from "react";

export interface AboutDialogProps {
  onClose: () => void;
}

export function AboutDialog({ onClose }: AboutDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-label="About NewMob"
        aria-modal="true"
        data-testid="about-dialog"
        className="w-[380px] rounded shadow-lg p-5"
        style={{ background: "var(--moba-bg)", border: "1px solid var(--moba-card-border)" }}
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
            <div className="text-lg font-semibold">NewMob</div>
            <div
              data-testid="about-version"
              className="text-[12px] moba-mono"
              style={{ color: "var(--moba-text-muted)" }}
            >
              Version {__APP_VERSION__}
            </div>
          </div>
        </div>

        <div className="text-[12px] mb-4" style={{ color: "var(--moba-text-muted)" }}>
          A cross‑platform port of the MobaXterm experience — Linux • macOS • Windows.
        </div>

        <div className="flex justify-end">
          <button
            ref={closeRef}
            type="button"
            className="moba-btn h-8 px-4"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
