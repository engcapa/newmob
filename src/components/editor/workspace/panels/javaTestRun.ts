import type { JavaTestItem } from "../../../../lib/editor/lsp";

/** Which build tool drives the test run (detected from the workspace root). */
export type JavaTestBuildTool = "maven" | "gradle";

/**
 * Build a terminal command that runs a single test class/method (M8 E, run-only).
 * Maven uses `-Dtest=Class#method`; Gradle uses `--tests 'Class.method'`. This is
 * the pragmatic run path — structured pass/fail results + debug-test come later.
 */
export function javaTestRunCommand(
  tool: JavaTestBuildTool,
  item: JavaTestItem,
  runner: string,
): string {
  // fullName is a class FQN, or `com.example.Class#method` for a method.
  const [className, method] = item.fullName.split("#");
  if (tool === "maven") {
    const selector = method ? `${className}#${method}` : className;
    return `${runner} test -Dtest='${selector}'`;
  }
  // Gradle test filter uses dotted `Class.method`.
  const selector = method ? `${className}.${method}` : className;
  return `${runner} test --tests '${selector}'`;
}

/** Wrapper-aware default runner name for a tool (frontend can't stat the FS). */
export function defaultRunner(tool: JavaTestBuildTool): string {
  return tool === "maven" ? "mvn" : "gradle";
}
