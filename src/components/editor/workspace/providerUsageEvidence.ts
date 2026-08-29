/**
 * ED-USAGE-002: Provider-backed usage role, ownership, and completeness evidence.
 * Tracks explicit provider-assigned roles (read, write, declaration, import, unknown)
 * and URI ownership (workspace, library, decompiled, external) without guessing.
 */

import type { LspLocation, LspRange } from "../../../lib/editor/lsp";
import type { UsageSymbolIdentity } from "./usageQuerySession";

export type ProviderUsageRole =
  | "read"
  | "write"
  | "declaration"
  | "import"
  | "type-reference"
  | "unknown";

export type ProviderUsageOwnership =
  | "workspace"
  | "library"
  | "decompiled"
  | "external";

export type ProviderUsageCompleteness = "complete" | "partial" | "cancelled" | "truncated";

export interface ProviderUsageItem {
  uri: string;
  range: LspRange;
  path?: string | null;
  role: ProviderUsageRole;
  ownership: ProviderUsageOwnership;
  sourceKind?: "main" | "test" | "generated" | "library";
}

export interface ProviderUsageEvidenceReport {
  symbol: UsageSymbolIdentity;
  providerId: string;
  providerGeneration: number;
  projectFingerprint: string;
  completeness: ProviderUsageCompleteness;
  totalFound: number;
  roleCounts: Record<ProviderUsageRole, number>;
  ownershipCounts: Record<ProviderUsageOwnership, number>;
  items: readonly ProviderUsageItem[];
}

export interface BuildProviderUsageEvidenceParams {
  symbol: UsageSymbolIdentity;
  locations: readonly (LspLocation & { role?: ProviderUsageRole; ownership?: ProviderUsageOwnership })[];
  workspaceRoots: readonly string[];
  providerId?: string;
  providerGeneration?: number;
  projectFingerprint?: string;
  completeness?: ProviderUsageCompleteness;
}

/**
 * Classifies URI ownership into workspace, library, decompiled, or external.
 */
export function classifyUsageOwnership(
  uri: string,
  workspaceRoots: readonly string[],
): ProviderUsageOwnership {
  if (/^jdt:\/\/|^cfr:\/\/|^fernflower:\/\//i.test(uri)) {
    return "decompiled";
  }

  if (/^jar:file:|^zip:file:/i.test(uri)) {
    return "library";
  }

  if (/^file:\/\//i.test(uri)) {
    let path = decodeURIComponent(uri.replace(/^file:\/\//i, ""));
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    const isUnderRoot = workspaceRoots.some((root) => {
      const normRoot = root.replace(/\\/g, "/");
      const normPath = path.replace(/\\/g, "/");
      return normPath === normRoot || normPath.startsWith(normRoot.endsWith("/") ? normRoot : `${normRoot}/`);
    });
    return isUnderRoot ? "workspace" : "external";
  }

  return "library";
}

/**
 * Builds structured provider usage evidence report without guessing missing roles.
 */
export function buildProviderUsageEvidenceReport(
  params: BuildProviderUsageEvidenceParams,
): ProviderUsageEvidenceReport {
  const roleCounts: Record<ProviderUsageRole, number> = {
    read: 0,
    write: 0,
    declaration: 0,
    import: 0,
    "type-reference": 0,
    unknown: 0,
  };

  const ownershipCounts: Record<ProviderUsageOwnership, number> = {
    workspace: 0,
    library: 0,
    decompiled: 0,
    external: 0,
  };

  const items: ProviderUsageItem[] = [];

  for (const loc of params.locations) {
    const isDeclaration =
      loc.uri === params.symbol.uri &&
      loc.range.start.line === params.symbol.range.start.line &&
      loc.range.start.character === params.symbol.range.start.character;

    // Use provider role if present; if declaration matches symbol range, mark declaration; else default to unknown
    const role: ProviderUsageRole = loc.role ?? (isDeclaration ? "declaration" : "unknown");
    const ownership: ProviderUsageOwnership =
      loc.ownership ?? classifyUsageOwnership(loc.uri, params.workspaceRoots);

    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
    ownershipCounts[ownership] = (ownershipCounts[ownership] ?? 0) + 1;

    items.push({
      uri: loc.uri,
      range: loc.range,
      path: loc.path ?? null,
      role,
      ownership,
    });
  }

  return {
    symbol: params.symbol,
    providerId: params.providerId ?? "jdtls",
    providerGeneration: params.providerGeneration ?? 1,
    projectFingerprint: params.projectFingerprint ?? "unknown-fp",
    completeness: params.completeness ?? "complete",
    totalFound: items.length,
    roleCounts,
    ownershipCounts,
    items,
  };
}
