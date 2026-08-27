import { useEffect, useMemo, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import {
  DEFAULT_WORKSPACE_TAB_POLICY_V3,
  enforceTabPolicy,
  type TabEvictionMeta,
  type WorkspaceTabPolicyV3,
} from "./workspaceTabPolicy";

export interface WorkspaceTabPolicySettingsDialogProps {
  open: boolean;
  policy: WorkspaceTabPolicyV3;
  openTabs?: readonly {
    key: string;
    title: string;
    dirty?: boolean;
    pinned?: boolean;
  }[];
  onApply: (policy: WorkspaceTabPolicyV3) => void;
  onClose: () => void;
}

export function WorkspaceTabPolicySettingsDialog({
  open,
  policy,
  openTabs = [],
  onApply,
  onClose,
}: WorkspaceTabPolicySettingsDialogProps) {
  const [draft, setDraft] = useState<WorkspaceTabPolicyV3>(() => ({ ...policy }));

  useEffect(() => {
    if (open) {
      setDraft({ ...policy });
    }
  }, [open, policy]);

  const evictionPreview = useMemo(() => {
    if (!openTabs.length || draft.limitPerLeaf >= openTabs.length) {
      return null;
    }
    const meta = new Map<string, TabEvictionMeta>(
      openTabs.map((tab, idx) => [
        tab.key,
        {
          key: tab.key,
          dirty: !!tab.dirty,
          pinned: !!tab.pinned,
          preview: false,
          lastUsedAt: 1_000_000 - idx,
        },
      ]),
    );
    const keys = openTabs.map((tab) => tab.key);
    return enforceTabPolicy(keys, meta, draft);
  }, [draft, openTabs]);

  if (!open) return null;

  const updateDraft = (patch: Partial<WorkspaceTabPolicyV3>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const handleApply = () => {
    onApply({
      ...draft,
      limitPerLeaf: Math.max(1, Math.min(50, Math.round(draft.limitPerLeaf))),
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Editor tab policy settings"
        data-testid="workspace-tab-policy-settings-dialog"
        className="w-[min(640px,calc(100vw-32px))] max-w-full rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-10 items-center border-b border-[var(--taomni-code-border)] px-3">
          <span className="font-medium">Editor Tab Policy</span>
          <button
            type="button"
            data-testid="workspace-tab-policy-close"
            aria-label="Close editor tab policy settings"
            className="ml-auto inline-flex h-7 w-7 items-center justify-center"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[min(76vh,640px)] space-y-5 overflow-y-auto p-4 text-xs">
          <section className="space-y-3">
            <h3 className="font-medium">Tab Capacity and Eviction</h3>
            <label className="grid grid-cols-[1fr_240px] items-center gap-3">
              <div>
                <span className="block font-medium">Tab limit per editor split</span>
                <span className="text-[11px] text-[var(--taomni-code-muted)]">
                  Maximum open tabs before evicting clean tabs (1–50)
                </span>
              </div>
              <input
                type="number"
                min={1}
                max={50}
                step={1}
                data-testid="workspace-tab-policy-limit"
                aria-label="Tab limit per editor split"
                value={draft.limitPerLeaf}
                onChange={(event) =>
                  updateDraft({ limitPerLeaf: Number(event.target.value) })
                }
                className="h-7 w-24 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
              />
            </label>

            {evictionPreview?.kind === "evicted" && (
              <div
                data-testid="workspace-tab-policy-eviction-preview"
                className="rounded border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] text-amber-200"
              >
                <div className="font-semibold">Candidate Evictions Preview</div>
                <div className="mt-1">
                  Tightening limit to {draft.limitPerLeaf} will evict{" "}
                  {evictionPreview.evictedKeys.length} tab(s):{" "}
                  <span className="font-mono">
                    {evictionPreview.evictedKeys
                      .map(
                        (k) =>
                          openTabs.find((tab) => tab.key === k)?.title ?? k,
                      )
                      .join(", ")}
                  </span>
                  . Pinned tabs and tabs with unsaved changes are protected.
                </div>
              </div>
            )}

            {evictionPreview?.kind === "over-limit-protected" && (
              <div
                data-testid="workspace-tab-policy-over-limit-warning"
                className="rounded border border-blue-500/30 bg-blue-500/10 p-2.5 text-[11px] text-blue-200"
              >
                <div className="font-semibold">Protected Over-Limit</div>
                <div className="mt-1">{evictionPreview.reason}</div>
              </div>
            )}
          </section>

          <section className="space-y-3 border-t border-[var(--taomni-code-border)] pt-4">
            <h3 className="font-medium">Display and Placement</h3>
            <label className="grid grid-cols-[1fr_240px] items-center gap-3">
              <div>
                <span className="block font-medium">Tab display order</span>
                <span className="text-[11px] text-[var(--taomni-code-muted)]">
                  Controls tab projection in the tab bar
                </span>
              </div>
              <select
                data-testid="workspace-tab-policy-order"
                aria-label="Tab display order"
                value={draft.order}
                onChange={(event) =>
                  updateDraft({
                    order: event.target.value as WorkspaceTabPolicyV3["order"],
                  })
                }
                className="h-7 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
              >
                <option value="open-order">Open order</option>
                <option value="mru">Most recently used (MRU)</option>
                <option value="alphabetical">Alphabetical</option>
              </select>
            </label>

            <label className="grid grid-cols-[1fr_240px] items-center gap-3">
              <div>
                <span className="block font-medium">Open new tab position</span>
                <span className="text-[11px] text-[var(--taomni-code-muted)]">
                  Where newly opened tabs appear
                </span>
              </div>
              <select
                data-testid="workspace-tab-policy-open-position"
                aria-label="Open new tab position"
                value={draft.openPosition}
                onChange={(event) =>
                  updateDraft({
                    openPosition:
                      event.target.value as WorkspaceTabPolicyV3["openPosition"],
                  })
                }
                className="h-7 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
              >
                <option value="end">At the end</option>
                <option value="after-active">Next to active tab</option>
              </select>
            </label>

            <label className="grid grid-cols-[1fr_240px] items-center gap-3">
              <div>
                <span className="block font-medium">
                  Activate after closing tab
                </span>
                <span className="text-[11px] text-[var(--taomni-code-muted)]">
                  Which neighbor becomes active when active tab closes
                </span>
              </div>
              <select
                data-testid="workspace-tab-policy-activate-on-close"
                aria-label="Activate after closing tab"
                value={draft.activateOnClose}
                onChange={(event) =>
                  updateDraft({
                    activateOnClose:
                      event.target
                        .value as WorkspaceTabPolicyV3["activateOnClose"],
                  })
                }
                className="h-7 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
              >
                <option value="mru">Most recently used</option>
                <option value="left">Left tab</option>
                <option value="right">Right tab</option>
              </select>
            </label>

            <label className="grid grid-cols-[1fr_240px] items-center gap-3">
              <div>
                <span className="block font-medium">Pinned tabs layout</span>
                <span className="text-[11px] text-[var(--taomni-code-muted)]">
                  Display pinned tabs separately or inline
                </span>
              </div>
              <select
                data-testid="workspace-tab-policy-pinned-row"
                aria-label="Pinned tabs layout"
                value={draft.pinnedRow}
                onChange={(event) =>
                  updateDraft({
                    pinnedRow:
                      event.target.value as WorkspaceTabPolicyV3["pinnedRow"],
                  })
                }
                className="h-7 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
              >
                <option value="same">In the same row</option>
                <option value="separate">In a separate row</option>
              </select>
            </label>
          </section>

          <section className="space-y-3 border-t border-[var(--taomni-code-border)] pt-4">
            <h3 className="font-medium">Preview Tab Behavior</h3>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-tab-policy-preview-mode"
                checked={draft.previewMode}
                onChange={(event) =>
                  updateDraft({ previewMode: event.target.checked })
                }
              />
              <span>
                Enable preview tab (single-click in file tree opens temporary
                preview)
              </span>
            </label>

            <label
              className={`flex items-center gap-2 ${!draft.previewMode ? "opacity-50" : ""}`}
            >
              <input
                type="checkbox"
                data-testid="workspace-tab-policy-reuse-preview"
                disabled={!draft.previewMode}
                checked={draft.reusePreview}
                onChange={(event) =>
                  updateDraft({ reusePreview: event.target.checked })
                }
              />
              <span>
                Reuse existing preview tab when opening another file in preview
              </span>
            </label>
          </section>
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--taomni-code-border)] p-3">
          <button
            type="button"
            data-testid="workspace-tab-policy-reset"
            className="taomni-btn inline-flex h-7 items-center gap-1.5 px-3"
            onClick={() => {
              setDraft({ ...DEFAULT_WORKSPACE_TAB_POLICY_V3 });
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>
          <button
            type="button"
            data-testid="workspace-tab-policy-cancel"
            className="taomni-btn ml-auto h-7 px-3"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="workspace-tab-policy-apply"
            className="taomni-btn h-7 px-3"
            onClick={handleApply}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
