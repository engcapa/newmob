import type { JavaTestItem } from "../../../../lib/editor/lsp";
import type {
  StructuredTestResult,
  StructuredTestResults,
  StructuredTestSummary,
} from "../../../../lib/editor/workspace";

export interface TestResultGroup {
  className: string;
  results: StructuredTestResult[];
}

/** Keep result rendering deterministic when providers emit duplicate XML rows. */
export function uniqueTestResults(results: readonly StructuredTestResult[]): StructuredTestResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = `${result.id}\u0000${result.className}\u0000${result.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function summarizeTestResults(results: StructuredTestResults | null): StructuredTestSummary | null {
  if (!results) return null;
  return results.summary;
}

export function groupTestResults(results: StructuredTestResults | null): TestResultGroup[] {
  if (!results) return [];
  const groups = new Map<string, StructuredTestResult[]>();
  for (const result of uniqueTestResults(results.results)) {
    const className = result.className || "Unclassified";
    const group = groups.get(className);
    if (group) group.push(result);
    else groups.set(className, [result]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([className, grouped]) => ({
      className,
      results: grouped.sort((left, right) => left.name.localeCompare(right.name)),
    }));
}

function walkTestItems(items: readonly JavaTestItem[], selector: string): JavaTestItem | null {
  for (const item of items) {
    if (item.fullName === selector) return item;
    const child = walkTestItems(item.children, selector);
    if (child) return child;
  }
  return null;
}

/** Reconstruct a runnable Java test when the report contains a node discovery did not return. */
export function testItemForResult(
  result: StructuredTestResult,
  discovered: readonly JavaTestItem[],
): JavaTestItem {
  return walkTestItems(discovered, result.selector) ?? {
    name: result.name,
    fullName: result.selector,
    kind: result.selector.includes("#") ? "method" : "class",
    uri: null,
    range: null,
    children: [],
  };
}

export function resultStatusLabel(status: StructuredTestResult["status"]): string {
  switch (status) {
    case "passed": return "Passed";
    case "failed": return "Failed";
    case "skipped": return "Skipped";
    case "error": return "Error";
    default: return "Unknown";
  }
}

export function formatTestDuration(durationMs: number | null): string {
  if (durationMs == null) return "-";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 2)} s`;
}
