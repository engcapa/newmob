import type { LspLocation, LspRange } from "../../../lib/editor/lsp";
import type {
  BuildEvidenceInput,
  CapabilityEvidenceScope,
  CapabilityEvidenceV3,
} from "./capabilityEvidence";
import {
  buildSemanticEnvelope,
  type SemanticQueryEnvelopeV3,
  type UsageEnvelopeLocation,
  type UsageQueryV3,
  type UsageRole,
} from "./semanticQueryEnvelope";

/**
 * §8.20.5 W4 shared usages session. ONE immutable snapshot backs the Find
 * Usages tool window AND the lightweight Show Usages popup — the two surfaces
 * are views over the same truth and never copy results. The session also owns
 * the scope selection model (honest about what plain LSP supports), the pin
 * replace guard and a bounded recent-query stack.
 */

export interface UsageSymbolIdentity {
  uri: string;
  range: LspRange;
  displayName: string;
  /** Provider-opaque symbol handle; null when the server supplies none. */
  providerSymbolId: string | null;
}

export type UsagesScope =
  | "project"
  | "open-files"
  | "tests"
  | "libraries"
  | "custom";

export interface UsagesScopeSelection {
  scope: UsagesScope;
  includeDeclaration: boolean;
  includeLibraries: boolean;
  /**
   * Client-side path classification for the tests bucket (src/test/...).
   * Presented as exactly that — a client scoping of the provider's response,
   * never claimed as a provider scope parameter.
   */
  includeTests: boolean;
}

export const DEFAULT_SCOPE_SELECTION: UsagesScopeSelection = {
  scope: "project",
  includeDeclaration: true,
  includeLibraries: false,
  includeTests: true,
};

export interface UsagesSessionSnapshot {
  id: string;
  createdAt: number;
  symbol: UsageSymbolIdentity;
  selection: UsagesScopeSelection;
  envelope: SemanticQueryEnvelopeV3<UsageEnvelopeLocation>;
  pinned: boolean;
  state: "loading" | "ready" | "stale" | "failed";
  staleReason: string | null;
}

/** Identity inputs the staleness check compares against a live workspace. */
export interface UsagesLiveIdentity {
  providerGeneration: number;
  projectFingerprint: string;
  documentRevision: number;
}

function classifyTestPath(path: string | null): boolean {
  if (!path) return false;
  return /(^|\/)(src[/]test|src[/]it|src[/]testFixtures)(\/|$)/i.test(path);
}

/** Classify one provider location into the typed envelope row. Roles stay
 * unknown: jdtls references carry no read/write classification. */
function toEnvelopeLocation(location: LspLocation): UsageEnvelopeLocation {
  return {
    ...location,
    role: "unknown",
  };
}

function libraryOwned(uri: string, isLibraryUri?: (uri: string) => boolean): boolean {
  if (!isLibraryUri) return false;
  return isLibraryUri(uri);
}

/** Canonical library-owner rule shared by the panel and the session:
 * a file:// URI is a workspace hit only when its path resolves inside some
 * root; everything else (jar/jrt/external) counts as library-owned. */
export function libraryUriClassifierForRoots(
  roots: readonly { path: string }[],
  relativePathWithinRoot: (rootPath: string, path: string) => string | null,
): (uri: string) => boolean {
  return (uri) => {
    if (!/^file:/i.test(uri)) return true;
    let path = decodeURIComponent(uri.replace(/^file:\/\//i, ""));
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    return !roots.some((root) => relativePathWithinRoot(root.path, path) !== null);
  };
}

/**
 * Scope the provider locations per the user's selection. Every bucket here is
 * an HONEST CLIENT-SIDE scoping of one document-scope LSP response:
 * - declaration: the location equal to the queried symbol's own range
 * - libraries: URI owner outside every workspace root (existing rule)
 * - tests: src/test-style paths
 */
export function scopeLocations(
  locations: readonly LspLocation[],
  symbol: UsageSymbolIdentity,
  selection: UsagesScopeSelection,
  isLibraryUri?: (uri: string) => boolean,
): readonly LspLocation[] {
  let scoped = locations;
  if (!selection.includeDeclaration) {
    scoped = scoped.filter((location) => !(
      location.uri === symbol.uri
      && location.range.start.line === symbol.range.start.line
      && location.range.start.character === symbol.range.start.character
    ));
  }
  if (!selection.includeLibraries) {
    scoped = scoped.filter((location) => !libraryOwned(location.uri, isLibraryUri));
  }
  if (!selection.includeTests) {
    scoped = scoped.filter((location) => !classifyTestPath(location.path ?? null));
  }
  return scoped;
}

let sessionSequence = 0;

export interface StartUsagesSessionInput {
  symbol: UsageSymbolIdentity;
  selection: UsagesScopeSelection;
  evidence: Omit<BuildEvidenceInput, "capabilityId" | "complete" | "reason">;
  locations: readonly LspLocation[];
  isLibraryUri?: (uri: string) => boolean;
}

const MAX_RECENT_SESSIONS = 10;

export class UsageQuerySession {
  private current: UsagesSessionSnapshot | null = null;
  private recent: UsagesSessionSnapshot[] = [];
  private disposed = false;

  /**
   * Freeze one request into an immutable snapshot. `locations` are the raw
   * provider answer; scoping/enveloping happen HERE so both surfaces see the
   * identical result set.
   */
  start(input: StartUsagesSessionInput): UsagesSessionSnapshot {
    if (this.disposed) throw new Error("UsageQuerySession was disposed");
    const scoped = scopeLocations(input.locations, input.symbol, input.selection, input.isLibraryUri);
    const envelope = buildSemanticEnvelope({
      kind: "usages",
      evidence: input.evidence,
      results: scoped.map(toEnvelopeLocation),
    });
    sessionSequence += 1;
    this.current = Object.freeze({
      id: `${input.evidence.uri}:${sessionSequence}`,
      createdAt: Date.now(),
      symbol: Object.freeze({ ...input.symbol }),
      selection: Object.freeze({ ...input.selection }),
      envelope,
      pinned: false,
      state: "ready",
      staleReason: null,
    });
    this.remember(this.current);
    return this.current;
  }

  /** Loading placeholder for a request in flight (popup + panel share it). */
  startLoading(symbol: UsageSymbolIdentity, selection: UsagesScopeSelection): UsagesSessionSnapshot {
    if (this.disposed) throw new Error("UsageQuerySession was disposed");
    const envelope: SemanticQueryEnvelopeV3<UsageEnvelopeLocation> = {
      queryId: `usages:loading:${++sessionSequence}`,
      kind: "usages",
      evidence: {
        capabilityId: "usages.find",
        languageId: "",
        provider: { id: "", version: null, generation: 0 },
        projectFingerprint: "",
        document: { uri: symbol.uri, revision: 0 },
        scope: "document",
        coverage: {
          complete: false,
          truncated: false,
          providerCount: 0,
          failedProviderCount: 0,
          skippedProviderCount: 0,
          reason: "request in flight",
        },
        requestId: `usages:loading:${sessionSequence}`,
        startedAt: Date.now(),
        completedAt: null,
      },
      results: [],
      nextPageToken: null,
    };
    sessionSequence += 1;
    this.current = Object.freeze({
      id: `${symbol.uri}:loading:${sessionSequence}`,
      createdAt: Date.now(),
      symbol: Object.freeze({ ...symbol }),
      selection: Object.freeze({ ...selection }),
      envelope,
      pinned: false,
      state: "loading",
      staleReason: null,
    });
    return this.current;
  }

  markFailed(reason: string): void {
    if (!this.current) return;
    this.patchCurrent({ state: "failed", staleReason: reason });
  }

  getCurrent(): UsagesSessionSnapshot | null {
    return this.current;
  }

  getRecent(): readonly UsagesSessionSnapshot[] {
    return this.recent;
  }

  /** Restore a recent snapshot as the current view (results are immutable). */
  restore(id: string): UsagesSessionSnapshot | null {
    const found = this.recent.find((snapshot) => snapshot.id === id) ?? null;
    if (found) this.current = found;
    return found;
  }

  setPinned(pinned: boolean): void {
    if (this.current) this.patchCurrent({ pinned });
  }

  isPinned(): boolean {
    return this.current?.pinned ?? false;
  }

  /**
   * Pin replace guard (§8.19.7 lineage): callers must ask before replacing a
   * pinned session; this predicate centralises that decision.
   */
  requiresPinConfirm(): boolean {
    return this.current?.pinned ?? false;
  }

  /**
   * §8.20.5 staleness: a provider restart (generation bump) or project
   * fingerprint change makes the CURRENT snapshot stale with a reason; views
   * render Rerun instead of silently trusting rows.
   */
  stalenessFor(live: UsagesLiveIdentity, currentFingerprint: string): { stale: boolean; reason: string | null } {
    const snapshot = this.current;
    if (!snapshot || snapshot.state !== "ready") return { stale: false, reason: null };
    if (snapshot.envelope.evidence.provider.generation !== live.providerGeneration) {
      return { stale: true, reason: "provider restarted since this query" };
    }
    if (currentFingerprint && snapshot.envelope.evidence.projectFingerprint !== currentFingerprint) {
      return { stale: true, reason: "project model changed since this query" };
    }
    if (
      snapshot.symbol.uri === snapshot.envelope.evidence.document.uri
      && live.documentRevision < snapshot.envelope.evidence.document.revision
    ) {
      // Document went backwards — only possible via reload/revert; treat as change.
      return { stale: true, reason: "document was reloaded since this query" };
    }
    return { stale: false, reason: null };
  }

  applyStaleness(live: UsagesLiveIdentity, currentFingerprint: string): void {
    const { stale, reason } = this.stalenessFor(live, currentFingerprint);
    if (stale) this.patchCurrent({ state: "stale", staleReason: reason });
  }

  dispose(): void {
    this.disposed = true;
    this.current = null;
    this.recent = [];
  }

  private remember(snapshot: UsagesSessionSnapshot): void {
    if (snapshot.state !== "ready") return;
    this.recent = [snapshot, ...this.recent.filter((entry) => entry.id !== snapshot.id)]
      .slice(0, MAX_RECENT_SESSIONS);
  }

  private patchCurrent(patch: Partial<Pick<UsagesSessionSnapshot, "state" | "staleReason" | "pinned">>): void {
    if (!this.current) return;
    this.current = Object.freeze({ ...this.current, ...patch });
    if (this.current.state === "ready") {
      this.recent = [this.current, ...this.recent.filter((entry) => entry.id !== this.current!.id)]
        .slice(0, MAX_RECENT_SESSIONS);
    } else {
      this.recent = this.recent.map((entry) => (entry.id === this.current!.id ? this.current! : entry));
    }
  }
}

export type UsagesScopeProvenance = "provider-requested" | "client-post-filtered" | "unsupported";

/**
 * §8.21.5 V4: Returns provenance attribution for each scope category.
 */
export function usagesScopeProvenance(scope: UsagesScope): UsagesScopeProvenance {
  switch (scope) {
    case "project":
      return "provider-requested";
    case "open-files":
    case "tests":
    case "libraries":
      return "client-post-filtered";
    case "custom":
      return "unsupported";
  }
}

/** Scope-dialog option model: what the picker may offer and why anything is
 * disabled. Plain LSP supports declaration toggling + client-side buckets;
 * provider-native scopes stay disabled with reasons until they exist. */
export function usagesScopeOptions(
  selection: UsagesScopeSelection,
): ReadonlyArray<{
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  provenance: UsagesScopeProvenance;
  reason: string | null;
  toggle: (current: UsagesScopeSelection) => UsagesScopeSelection;
}> {
  void selection;
  return [
    {
      id: "declaration",
      label: "Include declaration",
      checked: selection.includeDeclaration,
      disabled: false,
      provenance: "provider-requested",
      reason: null,
      toggle: (current) => ({ ...current, includeDeclaration: !current.includeDeclaration }),
    },
    {
      id: "libraries",
      label: "Libraries / dependencies",
      checked: selection.includeLibraries,
      disabled: false,
      provenance: "client-post-filtered",
      reason: null,
      toggle: (current) => ({ ...current, includeLibraries: !current.includeLibraries }),
    },
    {
      id: "tests",
      label: "Test sources (client-side path match)",
      checked: selection.includeTests,
      disabled: false,
      provenance: "client-post-filtered",
      reason: null,
      toggle: (current) => ({ ...current, includeTests: !current.includeTests }),
    },
  ];
}

export type UsagesGroupingMode = "file" | "module" | "usage-type" | "none";

export interface UsagesGroupNode {
  key: string;
  label: string;
  kind: "file" | "module" | "usage-type" | "none";
  locations: UsageEnvelopeLocation[];
  count: number;
}

export function hasProviderRoleInformation(locations: readonly UsageEnvelopeLocation[]): boolean {
  return locations.some((loc) => loc.role !== "unknown");
}

export function getRoleFilterStatus(locations: readonly UsageEnvelopeLocation[]): {
  enabled: boolean;
  disabledReason: string | null;
} {
  const hasRoles = hasProviderRoleInformation(locations);
  return {
    enabled: hasRoles,
    disabledReason: hasRoles
      ? null
      : "Provider does not classify read/write usage roles for this language",
  };
}

export function getUsagePreviewSnippet(
  fileText: string,
  range: LspRange,
): { lineText: string; lineIndex: number; highlightFrom: number; highlightTo: number } {
  if (!fileText) {
    return { lineText: "", lineIndex: range.start.line, highlightFrom: 0, highlightTo: 0 };
  }
  const lines = fileText.split("\n");
  const lineIdx = range.start.line;
  const lineText = lines[lineIdx] ?? "";
  const highlightFrom = Math.min(range.start.character, lineText.length);
  const highlightTo = range.start.line === range.end.line
    ? Math.min(range.end.character, lineText.length)
    : lineText.length;

  return {
    lineText,
    lineIndex: lineIdx,
    highlightFrom,
    highlightTo,
  };
}

export function groupUsages(
  locations: readonly UsageEnvelopeLocation[],
  mode: UsagesGroupingMode,
  getModuleName?: (path: string | null) => string,
): UsagesGroupNode[] {
  if (locations.length === 0) return [];
  if (mode === "none") {
    return [
      {
        key: "all",
        label: `All Usages (${locations.length})`,
        kind: "none",
        locations: [...locations],
        count: locations.length,
      },
    ];
  }

  const map = new Map<string, { label: string; kind: UsagesGroupNode["kind"]; locations: UsageEnvelopeLocation[] }>();

  for (const loc of locations) {
    let key: string;
    let label: string;
    let kind: UsagesGroupNode["kind"];

    switch (mode) {
      case "file": {
        key = loc.path || loc.uri;
        const parts = key.split("/");
        label = parts[parts.length - 1] || key;
        kind = "file";
        break;
      }
      case "module": {
        const mod = getModuleName ? getModuleName(loc.path ?? null) : (loc.path ? loc.path.split("/")[1] || "root" : "root");
        key = mod;
        label = mod;
        kind = "module";
        break;
      }
      case "usage-type": {
        key = loc.role;
        kind = "usage-type";
        switch (loc.role) {
          case "read":
            label = "Read Access";
            break;
          case "write":
            label = "Write Access";
            break;
          case "declaration":
            label = "Declaration";
            break;
          default:
            label = "Usage";
            break;
        }
        break;
      }
    }

    let existing = map.get(key);
    if (!existing) {
      existing = { label, kind, locations: [] };
      map.set(key, existing);
    }
    existing.locations.push(loc);
  }

  const groups: UsagesGroupNode[] = [];
  for (const [key, val] of map.entries()) {
    groups.push({
      key,
      label: val.label,
      kind: val.kind,
      locations: val.locations,
      count: val.locations.length,
    });
  }

  return groups;
}

export type { CapabilityEvidenceScope, CapabilityEvidenceV3, UsageRole, UsageQueryV3, SemanticQueryEnvelopeV3, UsageEnvelopeLocation };
