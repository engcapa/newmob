/**
 * ED-IMPORT-001: Provider-backed on-the-fly & paste auto-import model.
 * Enforces dynamic classpath/provider candidates (rejects fixed dictionaries),
 * configurable unambiguous auto-apply vs ambiguous user choice, and clean undo boundaries.
 */

export interface AutoImportSettings {
  addUnambiguousImportsOnTheFly: boolean;
  optimizeImportsOnTheFly: boolean;
  pasteImportMode: "all" | "ask" | "none";
  excludedPackages: readonly string[];
}

export const DEFAULT_AUTO_IMPORT_SETTINGS: AutoImportSettings = {
  addUnambiguousImportsOnTheFly: true,
  optimizeImportsOnTheFly: false,
  pasteImportMode: "ask",
  excludedPackages: ["com.sun.*", "sun.*", "jdk.internal.*"],
};

export interface AutoImportCandidate {
  symbolName: string;
  fullyQualifiedName: string;
  sourcePackage: string;
  origin: "provider" | "classpath";
  priority?: number;
}

export type AutoImportNoneReason =
  | "no-candidates"
  | "already-imported"
  | "excluded"
  | "paste-mode-none"
  | "disabled"
  | "stale-generation"
  | "unready-facts"
  | "untrusted-facts";

export type AutoImportPlanOutcome =
  | {
      outcome: "auto-apply";
      candidate: AutoImportCandidate;
      importStatement: string;
      insertionOffset: number;
    }
  | {
      outcome: "ambiguous";
      candidates: readonly AutoImportCandidate[];
      requiresPrompt: true;
    }
  | {
      outcome: "none";
      reason: AutoImportNoneReason;
    };

export interface PlanAutoImportParams {
  symbolName: string;
  candidates: readonly AutoImportCandidate[];
  documentText: string;
  settings?: AutoImportSettings;
  isPaste?: boolean;
  projectFactsStatus?: "ready" | "loading" | "degraded" | "untrusted" | "stale" | "failed";
  generation?: number;
  expectedGeneration?: number;
}

export const DEFAULT_JAVA_PACKAGE_PRIORITIES: Record<string, number> = {
  "java.util": 10,
  "java.io": 8,
  "java.nio": 8,
  "java.net": 6,
  "java.time": 5,
  "java.math": 5,
  "java.text": 4,
  "java.sql": 3,
  "java.awt": 1,
};

export function computePackagePriority(pkg: string): number {
  for (const [prefix, prio] of Object.entries(DEFAULT_JAVA_PACKAGE_PRIORITIES)) {
    if (pkg === prefix || pkg.startsWith(prefix + ".")) {
      return prio;
    }
  }
  return 0;
}

/**
 * Plans auto-import for a symbol or pasted code snippet without side effects.
 * ED-IMPORT-001 A1, A2, A3.
 */
export function planAutoImport(params: PlanAutoImportParams): AutoImportPlanOutcome {
  // ED-IMPORT-001-A3: stale generation or unready facts apply zero edits
  if (params.projectFactsStatus && params.projectFactsStatus !== "ready") {
    if (params.projectFactsStatus === "untrusted") {
      return { outcome: "none", reason: "untrusted-facts" };
    }
    return { outcome: "none", reason: "unready-facts" };
  }
  if (
    params.expectedGeneration !== undefined &&
    params.generation !== undefined &&
    params.generation !== params.expectedGeneration
  ) {
    return { outcome: "none", reason: "stale-generation" };
  }

  const settings = params.settings ?? DEFAULT_AUTO_IMPORT_SETTINGS;
  const currentImports = extractCurrentImports(params.documentText);

  // 1. Filter out already imported or excluded candidates
  const validCandidates = params.candidates.filter((cand) => {
    if (cand.symbolName !== params.symbolName) {
      return false;
    }
    if (currentImports.has(cand.fullyQualifiedName)) {
      return false;
    }
    if (isPackageExcluded(cand.sourcePackage, settings.excludedPackages)) {
      return false;
    }
    return true;
  });

  if (validCandidates.length === 0) {
    if (params.candidates.some((c) => currentImports.has(c.fullyQualifiedName))) {
      return { outcome: "none", reason: "already-imported" };
    }
    if (params.candidates.some((c) => isPackageExcluded(c.sourcePackage, settings.excludedPackages))) {
      return { outcome: "none", reason: "excluded" };
    }
    return { outcome: "none", reason: "no-candidates" };
  }

  // 2. Sort candidates by priority (e.g. java.util > java.awt)
  const sorted = [...validCandidates].sort((a, b) => {
    const prioA = a.priority ?? computePackagePriority(a.sourcePackage);
    const prioB = b.priority ?? computePackagePriority(b.sourcePackage);
    return prioB - prioA;
  });

  // 3. Paste mode checks
  if (params.isPaste) {
    if (settings.pasteImportMode === "none") {
      return { outcome: "none", reason: "paste-mode-none" };
    }
    if (settings.pasteImportMode === "ask") {
      return {
        outcome: "ambiguous",
        candidates: sorted,
        requiresPrompt: true,
      };
    }
  }

  // 4. Single unambiguous candidate or highest priority if clearly distinct
  if (
    sorted.length === 1 &&
    (settings.addUnambiguousImportsOnTheFly || (params.isPaste && settings.pasteImportMode === "all"))
  ) {
    const candidate = sorted[0];
    const importStatement = `import ${candidate.fullyQualifiedName};\n`;
    const insertionOffset = computeImportInsertionOffset(params.documentText);
    return {
      outcome: "auto-apply",
      candidate,
      importStatement,
      insertionOffset,
    };
  }

  if (sorted.length > 1) {
    return {
      outcome: "ambiguous",
      candidates: sorted,
      requiresPrompt: true,
    };
  }

  return { outcome: "none", reason: "disabled" };
}

/**
 * Parses AutoImportCandidates from provider code actions.
 */
export function parseProviderImportCandidates(
  actions: readonly { title: string }[],
): AutoImportCandidate[] {
  const candidates: AutoImportCandidate[] = [];
  const seen = new Set<string>();

  for (const action of actions) {
    const title = action.title.trim();
    // Match "Import 'Symbol' (package.Symbol)" or "Import 'package.Symbol'"
    const match1 = title.match(/import\s+['"]?([A-Za-z0-9_]+)['"]?\s*\((([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+))\)/i);
    if (match1) {
      const symbolName = match1[1];
      const fullyQualifiedName = match1[2];
      const lastDot = fullyQualifiedName.lastIndexOf(".");
      const sourcePackage = lastDot !== -1 ? fullyQualifiedName.slice(0, lastDot) : "";
      if (!seen.has(fullyQualifiedName)) {
        seen.add(fullyQualifiedName);
        candidates.push({
          symbolName,
          fullyQualifiedName,
          sourcePackage,
          origin: "provider",
          priority: computePackagePriority(sourcePackage),
        });
      }
      continue;
    }

    // Match "Add import 'package.Symbol'" or "Import package.Symbol"
    const match2 = title.match(/(?:add\s+)?import\s+['"]?(([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+))['"]?/i);
    if (match2) {
      const fullyQualifiedName = match2[1];
      const lastDot = fullyQualifiedName.lastIndexOf(".");
      const symbolName = lastDot !== -1 ? fullyQualifiedName.slice(lastDot + 1) : fullyQualifiedName;
      const sourcePackage = lastDot !== -1 ? fullyQualifiedName.slice(0, lastDot) : "";
      if (!seen.has(fullyQualifiedName)) {
        seen.add(fullyQualifiedName);
        candidates.push({
          symbolName,
          fullyQualifiedName,
          sourcePackage,
          origin: "provider",
          priority: computePackagePriority(sourcePackage),
        });
      }
    }
  }
  return candidates;
}

export interface PlanPasteAutoImportsParams {
  pastedText: string;
  documentText: string;
  candidates: readonly AutoImportCandidate[];
  settings?: AutoImportSettings;
  projectFactsStatus?: "ready" | "loading" | "degraded" | "untrusted" | "stale" | "failed";
  generation?: number;
  expectedGeneration?: number;
}

export type PasteAutoImportPlanResult =
  | {
      outcome: "auto-apply";
      appliedCandidates: AutoImportCandidate[];
      importStatements: string[];
      insertionOffset: number;
    }
  | {
      outcome: "ambiguous";
      ambiguousCandidates: readonly AutoImportCandidate[];
      requiresPrompt: true;
    }
  | {
      outcome: "none";
      reason: AutoImportNoneReason;
    };

/**
 * Plans auto-imports for code pasted into a document.
 */
export function planPasteAutoImports(params: PlanPasteAutoImportsParams): PasteAutoImportPlanResult {
  const settings = params.settings ?? DEFAULT_AUTO_IMPORT_SETTINGS;
  if (settings.pasteImportMode === "none") {
    return { outcome: "none", reason: "paste-mode-none" };
  }
  if (params.projectFactsStatus && params.projectFactsStatus !== "ready") {
    return {
      outcome: "none",
      reason: params.projectFactsStatus === "untrusted" ? "untrusted-facts" : "unready-facts",
    };
  }
  if (
    params.expectedGeneration !== undefined &&
    params.generation !== undefined &&
    params.generation !== params.expectedGeneration
  ) {
    return { outcome: "none", reason: "stale-generation" };
  }

  const tokens = scanPastedTypeTokens(params.pastedText);
  if (tokens.length === 0) {
    return { outcome: "none", reason: "no-candidates" };
  }

  const appliedCandidates: AutoImportCandidate[] = [];
  const ambiguousCandidates: AutoImportCandidate[] = [];
  let currentDocText = params.documentText;

  for (const token of tokens) {
    const plan = planAutoImport({
      symbolName: token,
      candidates: params.candidates,
      documentText: currentDocText,
      settings,
      isPaste: true,
      projectFactsStatus: params.projectFactsStatus,
      generation: params.generation,
      expectedGeneration: params.expectedGeneration,
    });

    if (plan.outcome === "auto-apply") {
      appliedCandidates.push(plan.candidate);
      currentDocText = `${plan.importStatement}${currentDocText}`;
    } else if (plan.outcome === "ambiguous") {
      ambiguousCandidates.push(...plan.candidates);
    }
  }

  if (ambiguousCandidates.length > 0 && settings.pasteImportMode === "ask") {
    return {
      outcome: "ambiguous",
      ambiguousCandidates,
      requiresPrompt: true,
    };
  }

  if (appliedCandidates.length > 0) {
    const importStatements = appliedCandidates.map((c) => `import ${c.fullyQualifiedName};\n`);
    const insertionOffset = computeImportInsertionOffset(params.documentText);
    return {
      outcome: "auto-apply",
      appliedCandidates,
      importStatements,
      insertionOffset,
    };
  }

  return { outcome: "none", reason: "no-candidates" };
}

export interface PasteWithImportsChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * Builds atomic transaction changes for pasting text and inserting import statements.
 * ED-IMPORT-001 A4: single transaction ensures one undo removes both paste and imports.
 */
export function buildPasteWithImportsChanges(params: {
  documentText: string;
  pasteOffset: number;
  pastedText: string;
  importStatements: readonly string[];
  insertionOffset: number;
}): {
  changes: PasteWithImportsChange[];
  newDocumentText: string;
} {
  const combinedImports = params.importStatements.join("");
  if (!combinedImports) {
    return {
      changes: [{ from: params.pasteOffset, to: params.pasteOffset, insert: params.pastedText }],
      newDocumentText:
        params.documentText.slice(0, params.pasteOffset) +
        params.pastedText +
        params.documentText.slice(params.pasteOffset),
    };
  }

  const changes: PasteWithImportsChange[] = [
    { from: params.insertionOffset, to: params.insertionOffset, insert: combinedImports },
    { from: params.pasteOffset, to: params.pasteOffset, insert: params.pastedText },
  ].sort((a, b) => a.from - b.from);

  let newDocumentText: string;
  if (params.insertionOffset <= params.pasteOffset) {
    newDocumentText =
      params.documentText.slice(0, params.insertionOffset) +
      combinedImports +
      params.documentText.slice(params.insertionOffset, params.pasteOffset) +
      params.pastedText +
      params.documentText.slice(params.pasteOffset);
  } else {
    newDocumentText =
      params.documentText.slice(0, params.pasteOffset) +
      params.pastedText +
      params.documentText.slice(params.pasteOffset, params.insertionOffset) +
      combinedImports +
      params.documentText.slice(params.insertionOffset);
  }

  return { changes, newDocumentText };
}

/**
 * Scans pasted text for likely type tokens (capitalized identifiers).
 */
export function scanPastedTypeTokens(pastedText: string): string[] {
  const matches = pastedText.match(/\b[A-Z][A-Za-z0-9_]*\b/g);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

function extractCurrentImports(documentText: string): Set<string> {
  const current = new Set<string>();
  const regex = /^\s*import\s+(?:static\s+)?([A-Za-z0-9_.*]+)\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(documentText)) !== null) {
    if (match[1]) {
      current.add(match[1].trim());
    }
  }
  return current;
}

function isPackageExcluded(packageName: string, patterns: readonly string[]): boolean {
  for (const pat of patterns) {
    if (pat.endsWith(".*")) {
      const prefix = pat.slice(0, -2);
      if (packageName === prefix || packageName.startsWith(prefix + ".")) {
        return true;
      }
    } else if (packageName === pat) {
      return true;
    }
  }
  return false;
}

export function computeImportInsertionOffset(documentText: string): number {
  // Find last import statement
  const importRegex = /^\s*import\s+[^;]+;\r?\n/gm;
  let lastImportEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(documentText)) !== null) {
    lastImportEnd = match.index + match[0].length;
  }
  if (lastImportEnd !== -1) {
    return lastImportEnd;
  }

  // Fallback: after package statement
  const pkgRegex = /^\s*package\s+[^;]+;\r?\n/m;
  const pkgMatch = pkgRegex.exec(documentText);
  if (pkgMatch) {
    return pkgMatch.index + pkgMatch[0].length;
  }

  return 0;
}
