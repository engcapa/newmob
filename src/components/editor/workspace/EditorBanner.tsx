import { useState } from "react";
import { AlertCircle, AlertTriangle, Info, Lock, X } from "lucide-react";
import { editorBannerDismissalKey, type EditorBannerItem } from "./editorBannerModel";

interface EditorBannerProps {
  banners: readonly EditorBannerItem[];
  onDismiss: (dismissalKey: string) => void;
}

function actionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "The action failed";
}

export function EditorBanner({ banners, onDismiss }: EditorBannerProps) {
  const [runningActions, setRunningActions] = useState<Set<string>>(new Set());
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  const runAction = async (banner: EditorBannerItem, actionId: string, run: () => void | Promise<void>) => {
    const actionKey = `${editorBannerDismissalKey(banner)}:${actionId}`;
    setActionErrors((current) => {
      if (!(actionKey in current)) return current;
      const next = { ...current };
      delete next[actionKey];
      return next;
    });
    setRunningActions((current) => new Set(current).add(actionKey));
    try {
      await run();
    } catch (error) {
      setActionErrors((current) => ({ ...current, [actionKey]: actionErrorMessage(error) }));
    } finally {
      setRunningActions((current) => {
        const next = new Set(current);
        next.delete(actionKey);
        return next;
      });
    }
  };

  if (banners.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Editor notifications"
      aria-live="polite"
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
            data-condition-generation={banner.conditionGeneration}
            className={`flex flex-wrap items-start gap-x-2 gap-y-1 border-b px-3 py-1.5 last:border-b-0 ${bgClass}`}
          >
            {icon}
            <div className="min-w-0 flex-1 basis-48">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-semibold">{banner.title}</span>
                {banner.description && (
                  <span className="break-words text-[var(--taomni-code-muted)]">{banner.description}</span>
                )}
              </div>
              {(banner.actions ?? []).map((action) => {
                const actionKey = `${editorBannerDismissalKey(banner)}:${action.id}`;
                const error = actionErrors[actionKey];
                if (!error) return null;
                return (
                  <div
                    key={`error-${action.id}`}
                    id={`banner-action-error-${action.id}`}
                    role="alert"
                    data-testid={`banner-action-error-${action.id}`}
                    className="mt-1 break-words text-red-700 dark:text-red-300"
                  >
                    {action.label} failed: {error}
                  </div>
                );
              })}
            </div>
            {banner.actions && banner.actions.length > 0 && (
              <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
                {banner.actions.map((action) => {
                  const actionKey = `${editorBannerDismissalKey(banner)}:${action.id}`;
                  const errorId = `banner-action-error-${action.id}`;
                  const running = runningActions.has(actionKey);
                  return (
                    <button
                      key={action.id}
                      type="button"
                      data-testid={`banner-action-${action.id}`}
                      aria-describedby={actionErrors[actionKey] ? errorId : undefined}
                      aria-busy={running || undefined}
                      disabled={running}
                      onClick={() => void runAction(banner, action.id, action.run)}
                      className={`max-w-full whitespace-normal break-words rounded px-2 py-0.5 text-left font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--taomni-accent)] disabled:cursor-wait disabled:opacity-60 ${
                        action.primary
                          ? "bg-[var(--taomni-accent)] text-[var(--taomni-code-bg)] hover:brightness-110"
                          : action.danger
                          ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                          : "bg-[var(--taomni-code-gutter-bg)] text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-border)]"
                      }`}
                    >
                      {action.label}
                    </button>
                  );
                })}
              </div>
            )}
            {banner.dismissible !== false && (
              <button
                type="button"
                aria-label={`Dismiss ${banner.title}`}
                data-testid={`banner-dismiss-${banner.id}`}
                title={`Dismiss ${banner.title}`}
                onClick={() => onDismiss(editorBannerDismissalKey(banner))}
                className="shrink-0 rounded p-0.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-border)] hover:text-[var(--taomni-code-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--taomni-accent)]"
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
