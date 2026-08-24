import type { LspDiagnostic, LspLocation, LspRange } from "../../../lib/editor/lsp";

export type ProviderAnalysisEvidenceKind = "nullability" | "taint" | "data-flow" | "related-location";

export interface ProviderAnalysisEvidence {
  kind: ProviderAnalysisEvidenceKind;
  label: string;
  /** Whether the provider explicitly named the analysis category or we inferred it from text. */
  confidence: "explicit" | "inferred";
  /** Evidence provenance; text inference is intentionally weaker than provider metadata. */
  proofLevel: "structured" | "related-location" | "text-inferred";
  /**
   * §8.19.7 DiagnosticPresentationHint: set exactly when the category came
   * from message/source keyword regexes — UI must show that the category is
   * keyword-inferred, and it never enters a semantic evidence ledger.
   */
  presentationHint?: "keyword inferred";
  relatedCount: number;
  /** Short, bounded source summary suitable for a compact panel. */
  source: string;
  /** Ordered provider-supplied flow path steps, when available. */
  flowSteps: ProviderAnalysisFlowStep[];
}

export type ProviderAnalysisFlowStepRole = "source" | "sink" | "propagation" | "related" | "unknown";

export interface ProviderAnalysisFlowStep {
  message: string;
  role: ProviderAnalysisFlowStepRole;
  location: LspLocation | null;
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

function boundedArray(value: unknown, limit = 64): unknown[] {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function parsePosition(value: unknown): { line: number; character: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.line === "number" && Number.isInteger(record.line) && record.line >= 0
    && typeof record.character === "number" && Number.isInteger(record.character) && record.character >= 0
    ? { line: record.line, character: record.character }
    : null;
}

function parseRange(value: unknown): LspRange | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const start = parsePosition(record.start);
  const end = parsePosition(record.end);
  return start && end ? { start, end } : null;
}

function parseLocation(value: unknown): LspLocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const uri = typeof record.uri === "string" ? record.uri.trim() : "";
  const path = typeof record.path === "string" ? record.path.trim() : null;
  const range = parseRange(record.range);
  if ((!uri && !path) || !range) return null;
  return { uri: uri || path!, path: path || null, range };
}

function explicitCategory(data: Record<string, unknown>): ProviderAnalysisEvidenceKind | null {
  const values = [
    data.analysisKind,
    data.analysisCategory,
    data.category,
    data.kind,
    data.flowKind,
  ].filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  const text = values.join(" ");
  if (/nullab|nullable|nonnull|not[-_ ]null/.test(text)) return "nullability";
  if (/taint|sink|untrusted|injection/.test(text)) return "taint";
  if (/data[-_ ]?flow|flow[-_ ]?path|propagat/.test(text)) return "data-flow";
  return null;
}

function flowStepRole(value: unknown): ProviderAnalysisFlowStepRole {
  if (typeof value !== "string") return "unknown";
  const role = value.toLowerCase();
  if (/^source$|origin|entry/.test(role)) return "source";
  if (/^sink$|target|exit/.test(role)) return "sink";
  if (/propagat|intermediate|call|step/.test(role)) return "propagation";
  if (/related|location/.test(role)) return "related";
  return "unknown";
}

function structuredFlowSteps(data: Record<string, unknown>): ProviderAnalysisFlowStep[] {
  const raw = data.flowPath ?? data.flowSteps ?? data.steps ?? data.relatedLocations;
  return boundedArray(raw).flatMap((item): ProviderAnalysisFlowStep[] => {
    if (typeof item === "string") {
      const message = item.trim().slice(0, 512);
      return message ? [{ message, role: "unknown", location: null }] : [];
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const message = [record.message, record.label, record.name, record.description]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim().slice(0, 512) ?? "Provider flow step";
    return [{
      message,
      role: flowStepRole(record.role ?? record.kind ?? record.type),
      location: parseLocation(record.location ?? record),
    }];
  });
}

function providerCategory(diagnostic: LspDiagnostic): {
  kind: ProviderAnalysisEvidenceKind | null;
  confidence: "explicit" | "inferred";
  proofLevel: "structured" | "text-inferred";
  flowSteps: ProviderAnalysisFlowStep[];
} {
  const data = diagnostic.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const flowSteps = structuredFlowSteps(record);
    const kind = explicitCategory(record)
      ?? (record.flowPath || record.flowSteps || record.steps
        ? "data-flow"
        : record.relatedLocations
          ? "related-location"
          : null);
    if (kind) return { kind, confidence: "explicit", proofLevel: "structured", flowSteps };
  }

  const text = [diagnostic.source, diagnostic.code, diagnostic.message, boundedText(diagnostic.data)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/nullab|nullable|nonnull|not[-_ ]null|may be null|could be null/.test(text)) {
    return { kind: "nullability", confidence: "inferred", proofLevel: "text-inferred", flowSteps: [] };
  }
  if (/taint|source\s*(?:->|to|reaches)\s*sink|untrusted|injection/.test(text)) {
    return { kind: "taint", confidence: "inferred", proofLevel: "text-inferred", flowSteps: [] };
  }
  if (/data[-_ ]?flow|flow\s*path|propagat|reaches\s+(?:a\s+)?sink/.test(text)) {
    return { kind: "data-flow", confidence: "inferred", proofLevel: "text-inferred", flowSteps: [] };
  }
  return { kind: null, confidence: "inferred", proofLevel: "text-inferred", flowSteps: [] };
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
    proofLevel: category.kind ? category.proofLevel : "related-location",
    ...(category.proofLevel === "text-inferred" ? { presentationHint: "keyword inferred" as const } : {}),
    relatedCount: diagnostic.relatedInformation?.length ?? 0,
    source,
    // RelatedInformation remains rendered by the panel's dedicated related
    // location section; only provider-declared flow paths belong here.
    flowSteps: category.flowSteps,
  };
}
