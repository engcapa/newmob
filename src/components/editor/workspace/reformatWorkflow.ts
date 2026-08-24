/**
 * §8.19.9 R8-D2 Reformat Code workflow decisions.
 *
 * Pure planner between the ActionHost action and the LSP formatter: every
 * invocation resolves to either an executable plan or a TYPED unavailable
 * reason — never a silent no-op, never a heuristic reformat pretending to be
 * cleanup/rearrange. Scope/rearrange/cleanup stages stay closed until a
 * provider actually supports them (§8.19.9 table).
 */

export interface ReformatCapabilities {
  /** textDocument/formatting advertised by the active provider. */
  formatting: boolean;
  /** textDocument/rangeFormatting advertised by the active provider. */
  rangeFormatting: boolean;
}

export interface ReformatInput {
  scope: "selection" | "file";
  targetPath: string | null;
  /** Lowercase file language id / extension for reason messages. */
  languageId: string | null;
  /** Library/decompiled or otherwise read-only buffers never reformat. */
  readOnly: boolean;
  /** Active non-empty editor selection exists (drives selection scope). */
  hasSelection: boolean;
  capabilities: ReformatCapabilities;
  /** Glob patterns excluding the target (currently fixed empty; reserved). */
  excludedByPattern?: readonly string[];
}

export type ReformatDecision =
  | {
      kind: "execute";
      scope: "selection" | "file";
      /** Which provider stage will run (always "format" in R8-D2). */
      stage: "format";
    }
  | { kind: "unavailable"; scope: "selection" | "file"; reason: string };

/** Decide what one Reformat Code invocation can actually run. */
export function planReformat(input: ReformatInput): ReformatDecision {
  const requestedScope: "selection" | "file" =
    input.scope === "selection" && input.hasSelection ? "selection" : "file";

  if (!input.targetPath) {
    return { kind: "unavailable", scope: requestedScope, reason: "No formattable file is open" };
  }
  if (input.readOnly) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: `${input.targetPath} is read-only and cannot be reformatted`,
    };
  }

  // Reserved exclusion gate: patterns currently always come back empty, but
  // the check stays here so a future exclusion UI cannot silently skip it.
  void input.excludedByPattern;

  if (requestedScope === "selection") {
    if (!input.capabilities.rangeFormatting) {
      if (!input.capabilities.formatting) {
        return {
          kind: "unavailable",
          scope: requestedScope,
          reason: `No formatter provider for ${input.languageId ?? "this file type"} supports selection reformatting`,
        };
      }
      return {
        kind: "unavailable",
        scope: requestedScope,
        reason: "The provider does not support range formatting — clear the selection to reformat the whole file",
      };
    }
    return { kind: "execute", scope: "selection", stage: "format" };
  }

  if (!input.capabilities.formatting) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: `No formatter provider for ${input.languageId ?? "this file type"} is running`,
    };
  }
  return { kind: "execute", scope: "file", stage: "format" };
}
