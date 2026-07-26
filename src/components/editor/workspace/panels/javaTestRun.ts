import type { JavaTestItem } from "../../../../lib/editor/lsp";

/** Which build tool drives the test run (detected from the workspace root). */
export type JavaTestBuildTool = "maven" | "gradle";

/**
 * Extend a detected build-tool `test` command to run one class/method (M8 E).
 * Maven uses `-Dtest=Class#method`; Gradle uses `--tests 'Class.method'`. This is
 * deliberately based on the whole detected command so wrappers and module task
 * selectors survive; structured pass/fail results remain a later enhancement.
 */
export function javaTestRunCommand(
  tool: JavaTestBuildTool,
  item: JavaTestItem,
  testCommand: string,
): string {
  // fullName is a class FQN, or `com.example.Class#method` for a method.
  const [className, method] = item.fullName.split("#");
  if (tool === "maven") {
    const selector = method ? `${className}#${method}` : className;
    return `${testCommand} -Dtest='${selector}'`;
  }
  // Gradle test filter uses dotted `Class.method`.
  const selector = method ? `${className}.${method}` : className;
  return `${testCommand} --tests '${selector}'`;
}
