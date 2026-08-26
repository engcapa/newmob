/**
 * §8.19.9 R8-D1 production Code Style scheme store.
 *
 * Schemes are named deltas over the built-in default; CRUD helpers are pure
 * (return new state) so tests pin semantics, persistence goes through
 * localStorage with per-scheme validation and corrupt entries are dropped on
 * read. The active scheme participates in the effective-style precedence
 * BELOW EditorConfig (see codeStyleModel.resolveEffectiveCodeStyle).
 */

import {
  DEFAULT_CODE_STYLE_SCHEME,
  type CodeStyleSchemeV2,
} from "./workspaceCodeStyleScheme";
import type { SchemeStyleFields } from "./codeStyleModel";

export const CODE_STYLE_SCHEMES_STORAGE_KEY = "taomni.codeWorkspace.codeStyle.schemes.v1";
export const BUILT_IN_SCHEME_ID = DEFAULT_CODE_STYLE_SCHEME.id;

export interface CodeStyleSchemeStoreState {
  schemes: CodeStyleSchemeV2[];
  /** languageId or "shared" → active scheme id. */
  activeByLanguage: Record<string, string>;
}

export function defaultCodeStyleSchemeStore(): CodeStyleSchemeStoreState {
  return { schemes: [{ ...DEFAULT_CODE_STYLE_SCHEME }], activeByLanguage: {} };
}

const ALLOWED_VALUE_KEYS: ReadonlySet<string> = new Set([
  "tabSize",
  "indentSize",
  "continuationIndent",
  "insertSpaces",
  "endOfLine",
  "trimTrailingWhitespace",
  "insertFinalNewline",
]);

function normalizeScheme(raw: unknown): CodeStyleSchemeV2 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const id = typeof source.id === "string" && source.id.trim() ? source.id : null;
  if (!id || id === BUILT_IN_SCHEME_ID) return null; // built-in is never persisted
  const name = typeof source.name === "string" && source.name.trim() ? source.name.trim() : null;
  if (!name) return null;
  const languageId = typeof source.languageId === "string" && source.languageId
    ? source.languageId
    : "shared";
  const values: CodeStyleSchemeV2["values"] = {};
  if (source.values && typeof source.values === "object" && !Array.isArray(source.values)) {
    for (const [key, entry] of Object.entries(source.values as Record<string, unknown>)) {
      if (!ALLOWED_VALUE_KEYS.has(key)) continue;
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      values[key] = { value: record.value, source: "scheme" };
    }
  }
  const saveActionsSource = (source.saveActions && typeof source.saveActions === "object"
    ? source.saveActions
    : {}) as Record<string, unknown>;
  const exclusionsSource = (source.exclusions && typeof source.exclusions === "object"
    ? source.exclusions
    : {}) as Record<string, unknown>;
  const patterns = Array.isArray(exclusionsSource.patterns)
    ? exclusionsSource.patterns.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : [];
  return {
    schemaVersion: 3,
    id,
    name,
    languageId,
    basedOn: typeof source.basedOn === "string" ? source.basedOn : null,
    values,
    saveActions: {
      format: saveActionsSource.format === true || saveActionsSource.reformat === true,
      organizeImports: saveActionsSource.organizeImports === true,
      rearrange: false,
      cleanup: false,
    },
    exclusions: {
      patterns,
      formatterMarkers: exclusionsSource.formatterMarkers !== false,
    },
  };
}

/** Repair-on-read: drop corrupt schemes, always keep the built-in default first. */
export function normalizeCodeStyleSchemeStore(raw: unknown): CodeStyleSchemeStoreState {
  const fallback = defaultCodeStyleSchemeStore();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const source = raw as Record<string, unknown>;

  const schemes: CodeStyleSchemeV2[] = [{ ...DEFAULT_CODE_STYLE_SCHEME }];
  const seen = new Set<string>([BUILT_IN_SCHEME_ID]);
  const names = new Set<string>([DEFAULT_CODE_STYLE_SCHEME.name]);
  if (Array.isArray(source.schemes)) {
    for (const candidate of source.schemes) {
      const scheme = normalizeScheme(candidate);
      if (!scheme || seen.has(scheme.id) || names.has(scheme.name)) continue;
      seen.add(scheme.id);
      names.add(scheme.name);
      schemes.push(scheme);
    }
  }

  const activeByLanguage: Record<string, string> = {};
  if (source.activeByLanguage && typeof source.activeByLanguage === "object") {
    for (const [languageKey, id] of Object.entries(source.activeByLanguage as Record<string, unknown>)) {
      if (typeof languageKey === "string" && typeof id === "string" && seen.has(id)) {
        activeByLanguage[languageKey] = id;
      }
    }
  }
  return { schemes, activeByLanguage };
}

export function readCodeStyleSchemeStore(): CodeStyleSchemeStoreState {
  if (typeof window === "undefined") return defaultCodeStyleSchemeStore();
  try {
    const raw = window.localStorage.getItem(CODE_STYLE_SCHEMES_STORAGE_KEY);
    if (!raw) return defaultCodeStyleSchemeStore();
    return normalizeCodeStyleSchemeStore(JSON.parse(raw));
  } catch {
    return defaultCodeStyleSchemeStore();
  }
}

export function writeCodeStyleSchemeStore(state: CodeStyleSchemeStoreState): void {
  if (typeof window === "undefined") return;
  try {
    // The built-in default carries no user state — persist custom schemes only.
    window.localStorage.setItem(
      CODE_STYLE_SCHEMES_STORAGE_KEY,
      JSON.stringify({
        schemes: state.schemes.filter((scheme) => scheme.id !== BUILT_IN_SCHEME_ID),
        activeByLanguage: state.activeByLanguage,
      }),
    );
  } catch {
    // Storage may be unavailable in restricted webviews.
  }
}

// -- Pure CRUD ----------------------------------------------------------------

export function upsertCodeStyleScheme(
  state: CodeStyleSchemeStoreState,
  scheme: CodeStyleSchemeV2,
): CodeStyleSchemeStoreState {
  const exists = state.schemes.some((entry) => entry.id === scheme.id);
  return {
    ...state,
    schemes: exists
      ? state.schemes.map((entry) => (entry.id === scheme.id ? scheme : entry))
      : [...state.schemes, scheme],
  };
}

export type SchemeMutationError =
  | "unknown-scheme"
  | "built-in-immutable"
  | "duplicate-name"
  | "empty-name";

export function copyCodeStyleScheme(
  state: CodeStyleSchemeStoreState,
  sourceId: string,
  newName: string,
): { state: CodeStyleSchemeStoreState; scheme: CodeStyleSchemeV2 } | { error: SchemeMutationError } {
  const trimmed = newName.trim();
  if (!trimmed) return { error: "empty-name" };
  const source = state.schemes.find((scheme) => scheme.id === sourceId);
  if (!source) return { error: "unknown-scheme" };
  if (state.schemes.some((scheme) => scheme.name.toLowerCase() === trimmed.toLowerCase())) {
    return { error: "duplicate-name" };
  }
  const copy: CodeStyleSchemeV2 = {
    ...source,
    id: `scheme-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
    name: trimmed,
    basedOn: source.basedOn ?? source.id,
    values: { ...source.values },
    saveActions: { ...source.saveActions },
  };
  return { state: upsertCodeStyleScheme(state, copy), scheme: copy };
}

export function renameCodeStyleScheme(
  state: CodeStyleSchemeStoreState,
  id: string,
  newName: string,
): CodeStyleSchemeStoreState | { error: SchemeMutationError } {
  const trimmed = newName.trim();
  if (!trimmed) return { error: "empty-name" };
  if (id === BUILT_IN_SCHEME_ID) return { error: "built-in-immutable" };
  const target = state.schemes.find((scheme) => scheme.id === id);
  if (!target) return { error: "unknown-scheme" };
  if (state.schemes.some((scheme) => scheme.id !== id && scheme.name.toLowerCase() === trimmed.toLowerCase())) {
    return { error: "duplicate-name" };
  }
  return upsertCodeStyleScheme(state, { ...target, name: trimmed });
}

export function deleteCodeStyleScheme(
  state: CodeStyleSchemeStoreState,
  id: string,
): CodeStyleSchemeStoreState | { error: SchemeMutationError } {
  if (id === BUILT_IN_SCHEME_ID) return { error: "built-in-immutable" };
  if (!state.schemes.some((scheme) => scheme.id === id)) return { error: "unknown-scheme" };
  const activeByLanguage: Record<string, string> = {};
  for (const [languageKey, activeId] of Object.entries(state.activeByLanguage)) {
    if (activeId !== id) activeByLanguage[languageKey] = activeId;
  }
  return {
    schemes: state.schemes.filter((scheme) => scheme.id !== id),
    activeByLanguage,
  };
}

/** Clear a scheme back to an empty delta over defaults. */
export function resetCodeStyleSchemeValues(
  state: CodeStyleSchemeStoreState,
  id: string,
): CodeStyleSchemeStoreState | { error: SchemeMutationError } {
  const target = state.schemes.find((scheme) => scheme.id === id);
  if (!target) return { error: "unknown-scheme" };
  if (id === BUILT_IN_SCHEME_ID) return state; // already empty by definition
  return upsertCodeStyleScheme(state, { ...target, values: {} });
}

export function setActiveCodeStyleScheme(
  state: CodeStyleSchemeStoreState,
  languageKey: string,
  schemeId: string,
): CodeStyleSchemeStoreState {
  if (!state.schemes.some((scheme) => scheme.id === schemeId)) return state;
  if (schemeId === BUILT_IN_SCHEME_ID) {
    const { [languageKey]: _dropped, ...rest } = state.activeByLanguage;
    void _dropped;
    return { ...state, activeByLanguage: rest };
  }
  return { ...state, activeByLanguage: { ...state.activeByLanguage, [languageKey]: schemeId } };
}

/** Exact-language match, then the shared selection, then the built-in default. */
export function activeSchemeForLanguage(
  state: CodeStyleSchemeStoreState,
  languageId: string | null,
): CodeStyleSchemeV2 {
  const byId = (id: string | undefined) =>
    id ? state.schemes.find((scheme) => scheme.id === id) ?? null : null;
  const exact = languageId ? byId(state.activeByLanguage[languageId]) : null;
  if (exact) return exact;
  const shared = byId(state.activeByLanguage.shared);
  if (shared) return shared;
  return state.schemes.find((scheme) => scheme.id === BUILT_IN_SCHEME_ID)
    ?? DEFAULT_CODE_STYLE_SCHEME;
}

/** Typed field view of a scheme's values (only keys the pipeline understands). */
export function schemeStyleFields(scheme: CodeStyleSchemeV2): SchemeStyleFields {
  const fields: SchemeStyleFields = {};
  const read = (key: string): unknown => scheme.values[key]?.value;
  const tabSize = read("tabSize");
  const indentSize = read("indentSize");
  const continuationIndent = read("continuationIndent");
  const insertSpaces = read("insertSpaces");
  const endOfLine = read("endOfLine");
  const trim = read("trimTrailingWhitespace");
  const finalNewline = read("insertFinalNewline");
  if (typeof tabSize === "number" && Number.isFinite(tabSize) && tabSize > 0) fields.tabSize = tabSize;
  if (typeof indentSize === "number" && Number.isFinite(indentSize) && indentSize > 0) fields.indentSize = indentSize;
  if (typeof continuationIndent === "number" && Number.isFinite(continuationIndent) && continuationIndent > 0) {
    fields.continuationIndent = continuationIndent;
  }
  if (typeof insertSpaces === "boolean") fields.insertSpaces = insertSpaces;
  if (endOfLine === "lf" || endOfLine === "crlf" || endOfLine === "cr") fields.endOfLine = endOfLine;
  if (typeof trim === "boolean") fields.trimTrailingWhitespace = trim;
  if (typeof finalNewline === "boolean") fields.insertFinalNewline = finalNewline;
  return fields;
}
