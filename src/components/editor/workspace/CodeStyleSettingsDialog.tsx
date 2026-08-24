import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { CodeStyleSource } from "./codeStyleModel";
import {
  BUILT_IN_SCHEME_ID,
  copyCodeStyleScheme,
  deleteCodeStyleScheme,
  renameCodeStyleScheme,
  resetCodeStyleSchemeValues,
  setActiveCodeStyleScheme,
  type CodeStyleSchemeStoreState,
  type SchemeMutationError,
} from "./workspaceCodeStyleSchemes";
import { DEFAULT_CODE_STYLE_SCHEME, type CodeStyleSchemeV2 } from "./workspaceCodeStyleScheme";

const MUTATION_ERROR_LABEL: Record<SchemeMutationError, string> = {
  "unknown-scheme": "Scheme no longer exists",
  "built-in-immutable": "The built-in default cannot be modified — copy it first",
  "duplicate-name": "A scheme with this name already exists",
  "empty-name": "Scheme name must not be empty",
};

interface CodeStyleSettingsDialogProps {
  open: boolean;
  store: CodeStyleSchemeStoreState;
  /** Language offered for per-language activation (current file), besides "shared". */
  activeLanguageId: string | null;
  /** Provenance panel for the file the dialog was opened from. */
  provenance: {
    filePath: string;
    effectiveLabel: string;
    source: CodeStyleSource;
    schemeName: string;
  } | null;
  /** Parent owns persistence; every mutation flows through here. */
  onChange: (next: CodeStyleSchemeStoreState) => void;
  onClose: () => void;
}

/**
 * §8.19.9 R8-D1 Code Style scheme management (§8.18.9.4 model): list,
 * copy/rename/delete/reset, per-language activation and typed field deltas.
 * The built-in default is immutable — customization starts from a copy.
 * Field provenance is shown for the current file's effective resolution.
 */
export function CodeStyleSettingsDialog({
  open,
  store,
  activeLanguageId,
  provenance,
  onChange,
  onClose,
}: CodeStyleSettingsDialogProps) {
  const [selectedId, setSelectedId] = useState<string>(BUILT_IN_SCHEME_ID);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!store.schemes.some((scheme) => scheme.id === selectedId)) {
      setSelectedId(BUILT_IN_SCHEME_ID);
    }
  }, [open, store.schemes, selectedId]);

  if (!open) return null;

  const selected = store.schemes.find((scheme) => scheme.id === selectedId)
    ?? DEFAULT_CODE_STYLE_SCHEME;
  const isBuiltIn = selected.id === BUILT_IN_SCHEME_ID;

  const failWith = (message: string): void => setError(message);

  const valueOf = (key: string): string => String(selected.values[key]?.value ?? "");

  const writeValue = (key: string, raw: string): void => {
    if (isBuiltIn) return;
    let value: unknown;
    if (key === "insertSpaces" || key === "trimTrailingWhitespace" || key === "insertFinalNewline") {
      value = raw === "true";
    } else if (raw === "") {
      value = undefined;
    } else {
      const numeric = Number(raw);
      value = key === "endOfLine" ? raw : Number.isFinite(numeric) ? numeric : raw;
    }
    const values = { ...selected.values };
    if (value === undefined) delete values[key];
    else values[key] = { value, source: "scheme" };
    onChange({
      ...store,
      schemes: store.schemes.map((entry) =>
        entry.id === selected.id ? { ...entry, values } : entry),
    });
  };

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Workspace code style settings"
        data-testid="workspace-code-style-dialog"
        className="flex max-h-[80vh] w-[640px] max-w-[calc(100vw-32px)] flex-col rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[12px] shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <span className="font-medium">Code Style</span>
          <select
            aria-label="Active code style scope"
            data-testid="code-style-active-scope-select"
            className="ml-auto rounded border border-[var(--taomni-code-border)] bg-transparent px-1 py-0.5 text-xs"
            value={activeLanguageId ?? "shared"}
            onChange={(event) => {
              const languageKey = event.target.value;
              onChange(setActiveCodeStyleScheme(store, languageKey, selectedId));
            }}
          >
            {[...new Set(["shared", ...(activeLanguageId ? [activeLanguageId] : [])])].map((key) => (
              <option key={key} value={key}>{key === "shared" ? "All languages (shared)" : key}</option>
            ))}
          </select>
          <button
            type="button"
            data-testid="code-style-close"
            aria-label="Close code style settings"
            className="rounded p-1 hover:bg-[var(--taomni-code-hover)]"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-56 shrink-0 flex-col border-r border-[var(--taomni-code-border)]">
            <ul
              role="listbox"
              aria-label="Code style schemes"
              data-testid="code-style-scheme-list"
              className="min-h-0 flex-1 overflow-y-auto py-1"
            >
              {store.schemes.map((scheme: CodeStyleSchemeV2) => (
                <li key={scheme.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={scheme.id === selectedId}
                    data-testid={`code-style-scheme-row-${scheme.id}`}
                    className={`flex w-full items-center gap-1 px-3 py-1 text-left ${
                      scheme.id === selectedId
                        ? "bg-[var(--taomni-code-active-line-bg)]"
                        : "hover:bg-[var(--taomni-code-hover)]"
                    }`}
                    onClick={() => setSelectedId(scheme.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{scheme.name}</span>
                    {scheme.id === BUILT_IN_SCHEME_ID && (
                      <span className="shrink-0 rounded bg-[var(--taomni-code-active-line-bg)] px-1 text-[9px]">
                        built-in
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex shrink-0 flex-wrap gap-1 border-t border-[var(--taomni-code-border)] p-2">
              <button
                type="button"
                data-testid="code-style-copy"
                className="rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 hover:bg-[var(--taomni-code-hover)]"
                onClick={() => {
                  const base = `${selected.name} copy`;
                  let name = base;
                  let suffix = 2;
                  while (store.schemes.some((scheme) => scheme.name.toLowerCase() === name.toLowerCase())) {
                    name = `${base} ${suffix}`;
                    suffix += 1;
                  }
                  const result = copyCodeStyleScheme(store, selected.id, name);
                  if ("error" in result) {
                    failWith(MUTATION_ERROR_LABEL[result.error]);
                    return;
                  }
                  if (error) setError(null);
                  setSelectedId(result.scheme.id);
                  onChange(result.state);
                }}
              >
                Copy
              </button>
              <button
                type="button"
                data-testid="code-style-rename"
                disabled={isBuiltIn}
                className="rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 hover:bg-[var(--taomni-code-hover)] disabled:opacity-40"
                onClick={() => {
                  setRenaming(true);
                  setRenameDraft(selected.name);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                data-testid="code-style-delete"
                disabled={isBuiltIn}
                className="rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 hover:bg-[var(--taomni-code-hover)] disabled:opacity-40"
                onClick={() => {
                  const result = deleteCodeStyleScheme(store, selected.id);
                  if ("error" in result) {
                    failWith(MUTATION_ERROR_LABEL[result.error]);
                    return;
                  }
                  if (error) setError(null);
                  setSelectedId(BUILT_IN_SCHEME_ID);
                  onChange(result);
                }}
              >
                Delete
              </button>
              <button
                type="button"
                data-testid="code-style-reset"
                disabled={isBuiltIn}
                title="Clear all fields back to defaults"
                className="rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 hover:bg-[var(--taomni-code-hover)] disabled:opacity-40"
                onClick={() => {
                  const result = resetCodeStyleSchemeValues(store, selected.id);
                  if ("error" in result) {
                    failWith(MUTATION_ERROR_LABEL[result.error]);
                    return;
                  }
                  if (error) setError(null);
                  onChange(result);
                }}
              >
                Reset
              </button>
            </div>
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            {error && (
              <div
                role="alert"
                data-testid="code-style-error"
                className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px]"
              >
                {error}
              </div>
            )}
            {renaming && !isBuiltIn && (
              <div className="mb-3 flex items-center gap-1">
                <input
                  data-testid="code-style-rename-input"
                  aria-label="Scheme name"
                  className="min-w-0 flex-1 rounded border border-[var(--taomni-code-border)] bg-transparent px-1.5 py-0.5"
                  value={renameDraft}
                  autoFocus
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      const result = renameCodeStyleScheme(store, selected.id, renameDraft);
                      if ("error" in result) {
                        failWith(MUTATION_ERROR_LABEL[result.error]);
                        return;
                      }
                      if (error) setError(null);
                      setRenaming(false);
                      onChange(result);
                    } else if (event.key === "Escape") {
                      setRenaming(false);
                    }
                  }}
                />
                <button
                  type="button"
                  data-testid="code-style-rename-confirm"
                  className="rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 hover:bg-[var(--taomni-code-hover)]"
                  onClick={() => {
                    const result = renameCodeStyleScheme(store, selected.id, renameDraft);
                    if ("error" in result) {
                      failWith(MUTATION_ERROR_LABEL[result.error]);
                      return;
                    }
                    if (error) setError(null);
                    setRenaming(false);
                    onChange(result);
                  }}
                >
                  OK
                </button>
                <button
                  type="button"
                  data-testid="code-style-rename-cancel"
                  className="rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 hover:bg-[var(--taomni-code-hover)]"
                  onClick={() => setRenaming(false)}
                >
                  Cancel
                </button>
              </div>
            )}

            {isBuiltIn ? (
              <p className="mb-3 text-[11px] text-[var(--taomni-code-muted)]">
                The built-in Default scheme resolves every field from EditorConfig, the
                language defaults or detection. Copy it to define explicit overrides.
              </p>
            ) : (
              <>
                <p className="mb-2 text-[11px] text-[var(--taomni-code-muted)]">
                  Empty fields inherit EditorConfig → language defaults → detection
                  (scheme sits below EditorConfig).
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ["tabSize", "Tab size", "number"],
                    ["indentSize", "Indent size", "number"],
                    ["continuationIndent", "Continuation indent", "number"],
                    ["insertSpaces", "Use spaces", "bool"],
                    ["endOfLine", "End of line", "eol"],
                    ["trimTrailingWhitespace", "Trim trailing whitespace", "bool"],
                    ["insertFinalNewline", "Insert final newline", "bool"],
                  ] as const).map(([key, label, kind]) => (
                    <label key={key} className="flex items-center gap-2 text-[11px]">
                      <span className="w-36 shrink-0 truncate" title={label}>{label}</span>
                      {kind === "bool" ? (
                        <input
                          type="checkbox"
                          data-testid={`code-style-field-${key}`}
                          checked={valueOf(key) === "true"}
                          onChange={(event) => writeValue(key, event.target.checked ? "true" : "false")}
                        />
                      ) : kind === "eol" ? (
                        <select
                          data-testid={`code-style-field-${key}`}
                          className="min-w-0 flex-1 rounded border border-[var(--taomni-code-border)] bg-transparent px-1 py-0.5"
                          value={valueOf(key)}
                          onChange={(event) => writeValue(key, event.target.value)}
                        >
                          <option value="">(inherit)</option>
                          <option value="lf">lf</option>
                          <option value="crlf">crlf</option>
                          <option value="cr">cr</option>
                        </select>
                      ) : (
                        <input
                          type="number"
                          min={kind === "number" ? 1 : undefined}
                          data-testid={`code-style-field-${key}`}
                          className="min-w-0 flex-1 rounded border border-[var(--taomni-code-border)] bg-transparent px-1 py-0.5"
                          value={valueOf(key)}
                          placeholder="(inherit)"
                          onChange={(event) => writeValue(key, event.target.value)}
                        />
                      )}
                    </label>
                  ))}
                </div>
              </>
            )}

            {provenance && (
              <div
                data-testid="code-style-provenance"
                className="mt-4 rounded border border-[var(--taomni-code-border)] p-2 text-[11px]"
              >
                <div className="mb-1 font-medium">Effective style · provenance</div>
                <div className="text-[var(--taomni-code-muted)]">{provenance.filePath}</div>
                <div className="mt-1">
                  Resolved: <span data-testid="code-style-provenance-label">{provenance.effectiveLabel}</span>
                </div>
                <div>
                  Winning layer:{" "}
                  <span data-testid="code-style-provenance-source">{provenance.source}</span>
                  {" · "}active scheme: {provenance.schemeName}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
