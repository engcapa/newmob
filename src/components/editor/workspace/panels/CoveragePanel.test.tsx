import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoveragePanel } from "./CoveragePanel";
import { parseLcovCoverage } from "../coverageModel";

afterEach(cleanup);

describe("CoveragePanel", () => {
  const sampleReport = parseLcovCoverage(`
SF:src/auth.ts
DA:1,5
DA:2,5
DA:3,0
LF:3
LH:2
end_of_record
SF:src/db.ts
DA:1,2
DA:2,2
LF:2
LH:2
end_of_record
`);

  it("renders empty state when no report loaded", () => {
    render(
      <CoveragePanel
        report={null}
        coverageEnabled={true}
        onToggleCoverage={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByTestId("coverage-panel-empty")).toBeInTheDocument();
    expect(screen.getByText("No test coverage data loaded")).toBeInTheDocument();
  });

  it("renders coverage overview and files list", () => {
    const onToggleCoverage = vi.fn();
    const onOpenFile = vi.fn();

    render(
      <CoveragePanel
        report={sampleReport}
        coverageEnabled={true}
        onToggleCoverage={onToggleCoverage}
        onOpenFile={onOpenFile}
      />,
    );

    expect(screen.getByTestId("coverage-overall-badge")).toHaveTextContent("80%");
    expect(screen.getByText("src/auth.ts")).toBeInTheDocument();
    expect(screen.getByText("src/db.ts")).toBeInTheDocument();
  });

  it("navigates to uncovered line when clicking a file row", () => {
    const onOpenFile = vi.fn();

    render(
      <CoveragePanel
        report={sampleReport}
        coverageEnabled={true}
        onToggleCoverage={vi.fn()}
        onOpenFile={onOpenFile}
      />,
    );

    const authRow = screen.getByTestId("coverage-row-src/auth.ts");
    fireEvent.click(authRow);

    // Line 3 is the first uncovered line in src/auth.ts
    expect(onOpenFile).toHaveBeenCalledWith("src/auth.ts", 3);
  });

  it("toggles gutter overlay setting", () => {
    const onToggleCoverage = vi.fn();

    render(
      <CoveragePanel
        report={sampleReport}
        coverageEnabled={true}
        onToggleCoverage={onToggleCoverage}
        onOpenFile={vi.fn()}
      />,
    );

    const toggleBtn = screen.getByTestId("coverage-toggle-gutter-btn");
    fireEvent.click(toggleBtn);

    expect(onToggleCoverage).toHaveBeenCalledTimes(1);
  });
});
