import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildPanel } from "./BuildPanel";

const workspaceMocks = vi.hoisted(() => ({
  workspaceTaskTree: vi.fn(),
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
          { id: "Maven:package", label: "package", command: "mvn package", cwd: "/repo/app", source: "Maven" },
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

  it("shows an empty state when no tasks are detected", async () => {
    workspaceMocks.workspaceTaskTree.mockResolvedValue([]);
    render(<BuildPanel workspaceInstanceId="ws" roots={roots} active onRunTask={vi.fn()} />);
    await screen.findByText(/No build tasks detected/);
  });
});
