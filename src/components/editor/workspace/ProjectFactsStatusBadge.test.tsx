import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectFactsStatusBadge } from "./ProjectFactsStatusBadge";

const mavenDiscovery = {
  status: "descriptor-only" as const,
  generation: 3,
  descriptors: [{
    path: "/repo/app/pom.xml",
    buildSystem: "maven" as const,
    name: "app",
    root: "/repo/app",
    rawContentSha256: "pom-hash",
    inferredExcludedRoots: ["/repo/app/target"],
  }],
  excludedRoots: ["/repo/app/target"],
  diagnostics: [],
};

afterEach(() => {
  cleanup();
});

describe("ProjectFactsStatusBadge", () => {
  it("shows descriptor discovery without promoting it to ready facts", () => {
    render(
      <ProjectFactsStatusBadge
        status="idle"
        discoveryStatus="descriptor-only"
        discovery={mavenDiscovery}
      />,
    );

    expect(screen.getByTestId("project-facts-discovery-status")).toHaveTextContent("Maven Discovered");
    expect(screen.queryByText(/Ready/)).not.toBeInTheDocument();
  });

  it("keeps loading and degraded facts truth visible alongside discovery", () => {
    const { rerender } = render(
      <ProjectFactsStatusBadge
        status="loading"
        discoveryStatus="descriptor-only"
        discovery={mavenDiscovery}
        reason="Loading project build facts..."
        generation={4}
      />,
    );

    expect(screen.getByTestId("project-facts-status-badge")).toHaveTextContent("Maven Discovered");
    expect(screen.getByTestId("project-facts-status-badge")).toHaveTextContent("Loading Facts");

    rerender(
      <ProjectFactsStatusBadge
        status="degraded"
        discoveryStatus="loading"
        discovery={null}
        discoveryReason="Descriptor scan in progress"
        generation={4}
      />,
    );

    expect(screen.getByTestId("project-facts-discovery-status")).toHaveTextContent("Discovering Project");
    expect(screen.getByTestId("project-facts-status-badge")).toHaveTextContent("Degraded");
  });

  it("refreshes both facts and descriptor discovery through the named control", () => {
    const onRefresh = vi.fn();
    render(
      <ProjectFactsStatusBadge
        status="failed"
        discoveryStatus="failed"
        discovery={null}
        discoveryReason="workspace scan failed"
        reason="tooling unavailable"
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByTestId("project-facts-discovery-status")).toHaveTextContent("Discovery Failed");
    expect(screen.getByText("Facts Failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh project facts and descriptors" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
