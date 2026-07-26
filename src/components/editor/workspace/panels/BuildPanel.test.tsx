import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildPanel } from "./BuildPanel";

const workspaceMocks = vi.hoisted(() => ({
  workspaceTaskTree: vi.fn(),
  workspaceDependencyTree: vi.fn(),
}));

vi.mock("../../../../lib/editor/workspace", () => workspaceMocks);

const roots = [{ id: "app", name: "app", path: "/repo/app", kind: "git" as const }];

describe("BuildPanel", () => {
  beforeEach(() => {
    workspaceMocks.workspaceTaskTree.mockReset().mockResolvedValue([
      {
        source: "Maven",
        tasks: [
          { id: "Maven:clean", label: "clean", command: "mvn clean", cwd: "/repo/app", source: "Maven" },
          { id: "Maven:compile", label: "compile", command: "mvn compile", cwd: "/repo/app", source: "Maven" },
          { id: "Maven:package", label: "package", command: "mvn package", cwd: "/repo/app", source: "Maven" },
          { id: "Maven:rebuild", label: "rebuild", command: "mvn clean compile", cwd: "/repo/app", source: "Maven" },
        ],
      },
      {
        source: "package.json",
        tasks: [
          { id: "package.json:test", label: "test", command: "pnpm run test", cwd: "/repo/app", source: "package.json" },
        ],
      },
    ]);
  });

  afterEach(cleanup);

  it("renders the grouped task tree and runs a task on click", async () => {
    const onRunTask = vi.fn();
    render(<BuildPanel workspaceInstanceId="ws" roots={roots} active onRunTask={onRunTask} />);

    // Group headings render, and a task under Maven runs with root context.
    await screen.findByText("Maven");
    fireEvent.click(await screen.findByTestId("build-panel-task-Maven:package"));
    expect(onRunTask).toHaveBeenCalledWith(
      expect.objectContaining({ command: "mvn package", rootId: "app", rootName: "app" }),
    );
  });

  it("collapses and expands a source group", async () => {
    render(<BuildPanel workspaceInstanceId="ws" roots={roots} active onRunTask={vi.fn()} />);

    const packageTask = await screen.findByTestId("build-panel-task-Maven:clean");
    expect(packageTask).toBeInTheDocument();
    // Collapsing the Maven group hides its tasks.
    fireEvent.click(screen.getByText("Maven"));
    await waitFor(() => expect(screen.queryByTestId("build-panel-task-Maven:clean")).toBeNull());
  });

  it("offers project build and rebuild actions with compile semantics", async () => {
    const onRunTask = vi.fn();
    render(<BuildPanel workspaceInstanceId="ws" roots={roots} active onRunTask={onRunTask} />);
    await screen.findByTestId("build-panel-task-Maven:compile");

    fireEvent.click(screen.getByTestId("build-panel-build-project"));
    expect(onRunTask).toHaveBeenCalledWith(expect.objectContaining({
      label: "compile",
      command: "mvn compile",
    }));
    fireEvent.click(screen.getByTestId("build-panel-rebuild-project"));
    expect(onRunTask).toHaveBeenCalledWith(expect.objectContaining({
      label: "rebuild",
      command: "mvn clean compile",
    }));
  });

  it("shows an empty state when no tasks are detected", async () => {
    workspaceMocks.workspaceTaskTree.mockResolvedValue([]);
    workspaceMocks.workspaceDependencyTree.mockResolvedValue([]);
    render(<BuildPanel workspaceInstanceId="ws" roots={roots} active onRunTask={vi.fn()} />);
    await screen.findByText(/No build tasks detected/);
  });

  it("loads the dependency tree on demand and flags conflicts", async () => {
    workspaceMocks.workspaceDependencyTree.mockResolvedValue([
      {
        group: "org.springframework",
        artifact: "spring-core",
        version: "5.3.0",
        scope: "compile",
        conflict: null,
        children: [
          { group: "org.springframework", artifact: "spring-jcl", version: "5.3.0", scope: "compile", conflict: null, children: [] },
        ],
      },
      {
        group: "com.google.guava",
        artifact: "guava",
        version: "31.0",
        scope: "",
        conflict: "com.google.guava:guava:30.0 -> 31.0",
        children: [],
      },
    ]);
    render(<BuildPanel workspaceInstanceId="ws" roots={roots} active onRunTask={vi.fn()} />);

    // Dependencies are on-demand: nothing fetched until the user clicks Load.
    await screen.findByTestId("build-panel-deps-load-app");
    expect(workspaceMocks.workspaceDependencyTree).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("build-panel-deps-load-app"));
    await waitFor(() => expect(workspaceMocks.workspaceDependencyTree).toHaveBeenCalledWith("/repo/app"));
    await screen.findByText("spring-core");
    // Arbitration conflict surfaces a badge.
    expect(screen.getByText("conflict")).toBeInTheDocument();
  });

  it("surfaces a dependency resolution error", async () => {
    workspaceMocks.workspaceDependencyTree.mockRejectedValue(new Error("mvn not found"));
    render(<BuildPanel workspaceInstanceId="ws" roots={roots} active onRunTask={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("build-panel-deps-load-app"));
    await screen.findByText("mvn not found");
  });

  it("shows the Modules section only for Java roots and loads on demand", async () => {
    const onLoadModules = vi.fn().mockResolvedValue([
      { name: "app", path: "/repo/app", uri: "file:///repo/app" },
      { name: "core", path: "/repo/core", uri: "file:///repo/core" },
    ]);
    render(
      <BuildPanel
        workspaceInstanceId="ws"
        roots={roots}
        active
        onRunTask={vi.fn()}
        onLoadModules={onLoadModules}
      />,
    );

    // Maven group present → Modules section shows, on-demand.
    const loadBtn = await screen.findByTestId("build-panel-modules-load-app");
    expect(onLoadModules).not.toHaveBeenCalled();
    fireEvent.click(loadBtn);
    await waitFor(() => expect(onLoadModules).toHaveBeenCalledWith("/repo/app"));
    await screen.findByText("core");
  });

  it("omits the Modules section when no Java build tasks are present", async () => {
    workspaceMocks.workspaceTaskTree.mockResolvedValue([
      {
        source: "package.json",
        tasks: [
          { id: "package.json:test", label: "test", command: "pnpm run test", cwd: "/repo/app", source: "package.json" },
        ],
      },
    ]);
    render(
      <BuildPanel
        workspaceInstanceId="ws"
        roots={roots}
        active
        onRunTask={vi.fn()}
        onLoadModules={vi.fn()}
      />,
    );
    await screen.findByText("package.json");
    expect(screen.queryByTestId("build-panel-modules-load-app")).toBeNull();
  });
});
