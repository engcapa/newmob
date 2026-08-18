import { useState, useMemo, useEffect } from "react";
import { Clock, Search, X, Code2, Edit3 } from "lucide-react";
import {
  navigationHistoryTracker,
  type NavigationLocation,
} from "./navigationHistoryModel";

export interface RecentLocationsDialogProps {
  open: boolean;
  onClose: () => void;
  onSelectLocation: (location: NavigationLocation) => void;
  initialChangedOnly?: boolean;
}

export function RecentLocationsDialog({
  open,
  onClose,
  onSelectLocation,
  initialChangedOnly = false,
}: RecentLocationsDialogProps) {
  const [search, setSearch] = useState("");
  const [changedOnly, setChangedOnly] = useState(initialChangedOnly);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    return navigationHistoryTracker.subscribe(() => {
      setRevision((r) => r + 1);
    });
  }, []);

  useEffect(() => {
    if (open) {
      setChangedOnly(initialChangedOnly);
      setSearch("");
      setSelectedIndex(0);
    }
  }, [open, initialChangedOnly]);

  const locations = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    revision;
    return navigationHistoryTracker.searchLocations(search, changedOnly);
  }, [search, changedOnly, revision]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [locations]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((idx) => (idx + 1) % Math.max(1, locations.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((idx) => (idx - 1 + locations.length) % Math.max(1, locations.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const loc = locations[selectedIndex];
      if (loc) {
        onSelectLocation(loc);
        onClose();
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="recent-locations-title"
      data-testid="recent-locations-dialog"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex h-[75vh] w-full max-w-3xl flex-col rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-2xl text-[12px] text-[var(--taomni-code-fg)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-sky-400" />
            <div>
              <h2 id="recent-locations-title" className="text-[14px] font-semibold">
                Recent Locations
              </h2>
              <p className="text-[11px] text-[var(--taomni-code-muted)] mt-0.5">
                Navigate to recently visited and edited code positions with context preview
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="recent-locations-toggle-changed"
              onClick={() => setChangedOnly((v) => !v)}
              className={`flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium border transition-colors ${
                changedOnly
                  ? "bg-sky-500/20 text-sky-400 border-sky-500/40 font-semibold"
                  : "border-[var(--taomni-code-border)] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
              }`}
            >
              <Edit3 className="h-3.5 w-3.5" />
              <span>Show Edited Only</span>
            </button>
            <button
              type="button"
              data-testid="recent-locations-close"
              onClick={onClose}
              aria-label="Close"
              className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-fg)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)]/30 px-4 py-2">
          <div className="relative flex items-center">
            <Search className="absolute left-2.5 h-4 w-4 text-[var(--taomni-code-muted)]" />
            <input
              type="text"
              autoFocus
              data-testid="recent-locations-search-input"
              placeholder="Search in recent locations and code snippets..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] pl-9 pr-3 text-[12px] text-[var(--taomni-code-fg)] placeholder:text-[var(--taomni-code-muted)] focus:outline-none focus:border-sky-500"
            />
          </div>
        </div>

        {/* List of locations with code preview */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
          {locations.length === 0 ? (
            <div className="p-12 text-center text-[var(--taomni-code-muted)]">
              No recent locations recorded yet.
            </div>
          ) : (
            locations.map((loc, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={loc.id}
                  data-testid={`recent-location-item-${loc.id}`}
                  onClick={() => {
                    onSelectLocation(loc);
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                    isSelected
                      ? "border-sky-500/60 bg-sky-500/10 shadow-sm"
                      : "border-[var(--taomni-code-border)]/60 bg-[var(--taomni-code-active-line-bg)]/20 hover:border-sky-500/40"
                  }`}
                >
                  <div className="flex items-center justify-between pb-1.5 border-b border-[var(--taomni-code-border)]/40 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Code2 className="h-4 w-4 text-sky-400 shrink-0" />
                      <span className="font-medium text-[12px] text-[var(--taomni-code-fg)]">
                        {loc.title}
                      </span>
                      <span className="font-mono text-[11px] text-[var(--taomni-code-muted)]">
                        :{loc.line + 1}
                      </span>
                      {loc.symbolName && (
                        <span className="rounded bg-sky-500/20 text-sky-300 px-1.5 py-0.2 text-[10px] font-mono">
                          {loc.symbolName}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {loc.isEditLocation && (
                        <span className="rounded bg-amber-500/20 text-amber-300 px-1.5 py-0.2 text-[10px] font-medium border border-amber-500/30">
                          Edited
                        </span>
                      )}
                      <span className="text-[10px] text-[var(--taomni-code-muted)] truncate max-w-[200px]">
                        {loc.filePath}
                      </span>
                    </div>
                  </div>

                  {/* Code snippet preview */}
                  <div className="rounded bg-[var(--taomni-code-bg)] p-2 border border-[var(--taomni-code-border)]/40 font-mono text-[11px] text-[var(--taomni-code-fg)] whitespace-pre overflow-x-auto leading-relaxed">
                    {loc.contextSnippet || loc.lineText}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)]/20 px-4 py-2 text-[11px] text-[var(--taomni-code-muted)]">
          <div className="flex items-center gap-3">
            <span>↑↓ Navigate</span>
            <span>↵ Select</span>
            <span>Esc Close</span>
          </div>
          <span>{locations.length} locations available</span>
        </div>
      </div>
    </div>
  );
}
