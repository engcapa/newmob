import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StructuredTestResults } from "../../../../lib/editor/workspace";
import type { JavaTestItem } from "../../../../lib/editor/lsp";
import { TestsPanel } from "./TestsPanel";

const item: JavaTestItem = {
  name: "fails",
  fullName: "com.acme.CalcTest#fails",
  kind: "method",
  uri: null,
  range: null,
  children: [],
};

const report: StructuredTestResults = {
  schema: "taomni.codeWorkspace.testResults",
  version: 1,
  source: "junit-xml",
  generatedAt: 1,
  results: [{
    id: item.fullName,
    selector: item.fullName,
    name: item.name,
    className: "com.acme.CalcTest",
    status: "failed",
    durationMs: 25,
    message: "expected 2",
    details: "AssertionError: expected 2",
    filePath: "src/test/java/com/acme/CalcTest.java",
    line: 18,
  }],
  summary: { total: 1, passed: 0, failed: 1, skipped: 0, errors: 0, durationMs: 25 },
  diagnostics: [],
};

describe("TestsPanel", () => {
  afterEach(cleanup);

  it("renders structured summaries, failure details, and rerun actions", async () => {
    const onRerun = vi.fn();
    const onOpenFailure = vi.fn();
    render(
      <TestsPanel
        activeFileTitle="CalcTest.java"
        canDiscover
        active
        onDiscover={vi.fn().mockResolvedValue([item])}
        onRun={vi.fn()}
        onDebug={vi.fn()}
        onRerun={onRerun}
        onOpenFailure={onOpenFailure}
        results={report}
        runDisabled={false}
      />,
    );

    expect(screen.getByTestId("tests-result-summary")).toHaveTextContent("1 total");
    expect(screen.getByTestId(`tests-result-${item.fullName}`)).toHaveTextContent("fails");
    expect(screen.getByTestId(`tests-failure-details-${item.fullName}`)).toHaveTextContent("AssertionError");
    fireEvent.click(screen.getByTestId(`tests-rerun-${item.fullName}`));
    fireEvent.click(screen.getByRole("button", { name: "fails" }));
    expect(onRerun).toHaveBeenCalledWith(report.results[0]);
    expect(onOpenFailure).toHaveBeenCalledWith(report.results[0]);
  });

  it("loads a fresh report on demand and exposes provider diagnostics", async () => {
    const onLoadResults = vi.fn().mockResolvedValue({ ...report, diagnostics: ["No report for module"] });
    render(
      <TestsPanel
        activeFileTitle="CalcTest.java"
        canDiscover
        active={false}
        onDiscover={vi.fn().mockResolvedValue([])}
        onRun={vi.fn()}
        onDebug={vi.fn()}
        onLoadResults={onLoadResults}
        runDisabled={false}
      />,
    );
    fireEvent.click(screen.getByTestId("tests-load-results"));
    await waitFor(() => expect(onLoadResults).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("tests-result-diagnostic")).toHaveTextContent("No report for module");
  });
});
