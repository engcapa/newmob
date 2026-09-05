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
      reason: "no-candidates" | "already-imported" | "excluded" | "paste-mode-none" | "disabled";
    };

export interface PlanAutoImportParams {
  symbolName: string;
  candidates: readonly AutoImportCandidate[];
  documentText: string;
  settings?: AutoImportSettings;
  isPaste?: boolean;
}

/**
 * Plans auto-import for a symbol or pasted code snippet without side effects.
 */
export function planAutoImport(params: PlanAutoImportParams): AutoImportPlanOutcome {
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
  const sorted = [...validCandidates].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

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

  // 4. Single unambiguous candidate
  if (sorted.length === 1 && (settings.addUnambiguousImportsOnTheFly || (params.isPaste && settings.pasteImportMode === "all"))) {
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

function computeImportInsertionOffset(documentText: string): number {
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
