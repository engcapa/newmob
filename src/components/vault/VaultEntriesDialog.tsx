import { useEffect, useState } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import { useModalDraggableAndResizable } from "../../hooks/useModalDraggableAndResizable";
import { useT } from "../../lib/i18n";
import { confirmAppDialog } from "../../lib/appDialogs";
import { X, Shield, Search, Trash2 } from "lucide-react";

export interface VaultEntriesDialogProps {
  onClose: () => void;
}

export function VaultEntriesDialog({ onClose }: VaultEntriesDialogProps) {
  const t = useT();
  const { entries, reloadEntries, deleteEntry } = useVaultStore();
  const [searchQuery, setSearchQuery] = useState("");

  const { containerRef, handleRef } = useModalDraggableAndResizable({
    minWidth: 500,
    minHeight: 400,
  });

  useEffect(() => {
    void reloadEntries().catch(() => undefined);
  }, [reloadEntries]);

  // Escape key support
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

  const filteredEntries = entries.filter((e) => {
    const query = searchQuery.toLowerCase();
    return (
      e.label.toLowerCase().includes(query) ||
      e.kind.toLowerCase().includes(query)
    );
  });

  const handleDelete = (id: string, label: string) => {
    void confirmAppDialog({
      message: t("vaultSettings.confirmDeleteEntry", { label }),
      confirmLabel: t("common.delete"),
      danger: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      void deleteEntry(id);
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(20,30,45,0.4)" }}
    >
      <div
        ref={containerRef}
        className="w-[640px] h-[500px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{
          background: "var(--taomni-panel-bg)",
          borderColor: "var(--taomni-chrome-border)",
          color: "var(--taomni-text)",
        }}
      >
        {/* Title Bar */}
        <div
          ref={handleRef}
          className="h-7 flex items-center px-2 rounded-t-[5px] shrink-0 select-none"
          style={{
            background: "linear-gradient(to bottom, #5895c8, #2b5d8b)",
            color: "white",
          }}
        >
          <Shield className="w-3.5 h-3.5 mr-1.5" />
          <div className="text-[12px] font-semibold">
            {t("vaultSettings.manageEntries")}
          </div>
          <div className="ml-auto flex items-center">
            <button
              title={t("vaultSettings.close")}
              className="hover:bg-red-500 rounded p-0.5 animate-all duration-150"
              onClick={onClose}
              type="button"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Search Bar */}
        <div
          className="px-3 py-2 border-b shrink-0 flex items-center gap-2"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        >
          <div className="relative flex-1 flex items-center">
            <Search className="w-3.5 h-3.5 absolute left-2 text-[var(--taomni-text-muted)] pointer-events-none" />
            <input
              type="search"
              placeholder={t("vaultSettings.searchPlaceholder")}
              className="taomni-input w-full text-[12px] h-7"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ paddingLeft: "28px" }}
            />
          </div>
        </div>

        {/* Content Body */}
        <div
          className="flex-1 min-h-0 overflow-auto px-4 py-3 border-x"
          style={{ borderColor: "var(--taomni-input-border)", background: "var(--taomni-bg)" }}
        >
          {filteredEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
              {searchQuery ? t("vaultSettings.noMatchingEntries") : t("vaultSettings.noEntries")}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {filteredEntries.map((e) => (
                <div
                  key={e.id}
                  data-testid={`vault-entry-${e.id}`}
                  className="flex items-center gap-3 text-[12px] px-3 py-2 rounded transition-colors"
                  style={{
                    border: "1px solid var(--taomni-card-border)",
                    background: "var(--taomni-card-bg, var(--taomni-quick-bg))"
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">{e.label}</div>
                  </div>
                  <span className="taomni-pill scale-90 select-none shrink-0" style={{ color: "var(--taomni-text-muted)" }}>
                    {e.kind}
                  </span>
                  <button
                    type="button"
                    className="p-1 rounded text-red-600 hover:bg-red-500/10 shrink-0"
                    onClick={() => handleDelete(e.id, e.label)}
                    title={t("vaultSettings.deleteEntry")}
                    data-testid={`vault-entry-delete-${e.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="h-12 flex items-center px-4 border-t shrink-0"
          style={{ background: "var(--taomni-quick-bg)", borderColor: "var(--taomni-divider)" }}
        >
          <div className="text-[11px] text-[var(--taomni-text-muted)]">
            {t("vaultSettings.savedEntries", { count: filteredEntries.length })}
          </div>
          <div className="flex-1" />
          <button
            className="taomni-btn px-4 py-1.5 text-[12px]"
            onClick={onClose}
            type="button"
          >
            {t("vaultSettings.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
