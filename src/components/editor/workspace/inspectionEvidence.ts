import type { LspDiagnostic } from "../../../lib/editor/lsp";

export type ProviderAnalysisEvidenceKind = "nullability" | "taint" | "data-flow" | "related-location";

export interface ProviderAnalysisEvidence {
  kind: ProviderAnalysisEvidenceKind;
  label: string;
  /** Whether the provider explicitly named the analysis category or we inferred it from text. */
  confidence: "explicit" | "inferred";
  relatedCount: number;
  /** Short, bounded source summary suitable for a compact panel. */
  source: string;
}

const KIND_LABELS: Record<ProviderAnalysisEvidenceKind, string> = {
  nullability: "Nullability",
  taint: "Taint flow",
  "data-flow": "Data flow",
  "related-location": "Related location",
};

function boundedText(value: unknown, limit = 4_096): string {
  if (typeof value === "string") return value.slice(0, limit);
  if (value == null || typeof value === "number" || typeof value === "boolean") return String(value ?? "");
  try {
    return JSON.stringify(value).slice(0, limit);
  } catch {
    return "";
  }
}

function providerCategory(diagnostic: LspDiagnostic): {
  kind: ProviderAnalysisEvidenceKind | null;
  confidence: "explicit" | "inferred";
} {
  const data = diagnostic.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const explicitText = Object.entries(record)
      .filter(([key]) => /kind|category|analysis|flow|taint|nullab/i.test(key))
      .map(([, value]) => boundedText(value, 256))
      .join(" ")
      .toLowerCase();
    if (/nullab|nullable|nonnull|not[-_ ]null/.test(explicitText)) {
      return { kind: "nullability", confidence: "explicit" };
    }
    if (/taint|sink|untrusted|injection/.test(explicitText)) {
      return { kind: "taint", confidence: "explicit" };
    }
    if (/data[-_ ]?flow|flow[-_ ]?path|propagat/.test(explicitText)) {
      return { kind: "data-flow", confidence: "explicit" };
    }
  }

  const text = [diagnostic.source, diagnostic.code, diagnostic.message, boundedText(diagnostic.data)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/nullab|nullable|nonnull|not[-_ ]null|may be null|could be null/.test(text)) {
    return { kind: "nullability", confidence: "inferred" };
  }
  if (/taint|source\s*(?:->|to|reaches)\s*sink|untrusted|injection/.test(text)) {
    return { kind: "taint", confidence: "inferred" };
  }
  if (/data[-_ ]?flow|flow\s*path|propagat|reaches\s+(?:a\s+)?sink/.test(text)) {
    return { kind: "data-flow", confidence: "inferred" };
  }
  return { kind: null, confidence: "inferred" };
}

/**
 * Classify evidence already supplied by an LSP provider. This deliberately
 * does not parse source code or construct a client-side data-flow graph.
 */
export function classifyProviderAnalysisEvidence(
  diagnostic: LspDiagnostic,
): ProviderAnalysisEvidence | null {
  const category = providerCategory(diagnostic);
  const kind = category.kind ?? (diagnostic.relatedInformation?.length ? "related-location" : null);
  if (!kind) return null;
  const source = [diagnostic.source, diagnostic.code].filter(Boolean).join(":") || "language-server";
  return {
    kind,
    label: KIND_LABELS[kind],
    confidence: category.kind ? category.confidence : "explicit",
    relatedCount: diagnostic.relatedInformation?.length ?? 0,
    source,
  };
}
