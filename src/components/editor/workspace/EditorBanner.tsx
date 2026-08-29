import { AlertCircle, AlertTriangle, Info, Lock, X } from "lucide-react";
import type { EditorBannerItem } from "./editorBannerModel";

interface EditorBannerProps {
  banners: EditorBannerItem[];
  onDismiss: (bannerId: string) => void;
}

export function EditorBanner({ banners, onDismiss }: EditorBannerProps) {
  if (banners.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Editor notifications"
      data-testid="code-workspace-editor-banners"
      className="flex flex-col border-b border-[var(--taomni-code-border)] text-[11px]"
    >
      {banners.map((banner) => {
        const icon = banner.category === "read-only" ? (
          <Lock className="h-3.5 w-3.5 shrink-0 text-sky-400" />
        ) : banner.severity === "error" ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
        ) : banner.severity === "warning" ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        ) : (
          <Info className="h-3.5 w-3.5 shrink-0 text-sky-400" />
        );

        const bgClass = banner.severity === "error"
          ? "bg-red-500/10 text-red-200 border-red-500/20"
          : banner.severity === "warning"
          ? "bg-amber-500/10 text-amber-200 border-amber-500/20"
          : "bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-code-text)] border-[var(--taomni-code-border)]";

        return (
          <div
            key={banner.id}
            data-testid={`code-workspace-banner-${banner.id}`}
            data-category={banner.category}
            className={`flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0 ${bgClass}`}
          >
            {icon}
            <div className="min-w-0 flex-1">
              <span className="font-semibold">{banner.title}</span>
              {banner.description && (
                <span className="ml-2 text-[var(--taomni-code-muted)]">{banner.description}</span>
              )}
            </div>
            {banner.actions && banner.actions.length > 0 && (
              <div className="flex shrink-0 items-center gap-1.5">
                {banner.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    data-testid={`banner-action-${action.id}`}
                    onClick={() => void action.run()}
                    className={`rounded px-2 py-0.5 font-medium transition-colors ${
                      action.primary
                        ? "bg-[var(--taomni-accent)] text-[var(--taomni-code-bg)] hover:brightness-110"
                        : action.danger
                        ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                        : "bg-[var(--taomni-code-gutter-bg)] text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-border)]"
                    }`}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
            {banner.dismissible !== false && (
              <button
                type="button"
                aria-label={`Dismiss ${banner.title}`}
                data-testid={`banner-dismiss-${banner.id}`}
                onClick={() => onDismiss(banner.id)}
                className="shrink-0 rounded p-0.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-border)] hover:text-[var(--taomni-code-text)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
