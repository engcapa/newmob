import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { RunPanel, type RunPanelHandle } from "./RunPanel";

const workspaceMocks = vi.hoisted(() => ({
  workspaceDetectTasks: vi.fn(),
  workspaceExecutionModel: vi.fn(),
  workspaceJavaRunTargets: vi.fn(),
}));

vi.mock("../../../../lib/editor/workspace", () => workspaceMocks);

const roots = [{ id: "app", name: "app", path: "/repo/app", kind: "git" as const }];

describe("RunPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    workspaceMocks.workspaceDetectTasks.mockReset().mockResolvedValue([{
      id: "package.json:test",
      label: "test",
      command: "pnpm run test",
      cwd: "/repo/app",
      source: "package.json",
    }]);
    workspaceMocks.workspaceJavaRunTargets.mockReset().mockResolvedValue([]);
    workspaceMocks.workspaceExecutionModel.mockReset().mockResolvedValue({
      projects: [],
      buildTargets: [],
      runConfigurations: [],
      debugConfigurations: [],
      tools: [],
    });
  });

  afterEach(cleanup);

  it("detects tasks, launches them, and records exit status", async () => {
    let finish!: (exitCode: number) => void;
    const onRun = vi.fn((_task, onExit: (exitCode: number) => void) => {
      finish = onExit;
    });
    render(
      <RunPanel
        workspaceInstanceId="ws"
        roots={roots}
        active
        onRun={onRun}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /test/ }));
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({ command: "pnpm run test", rootId: "app" }),
      expect.any(Function),
    );
    expect(screen.getByText("running")).toBeInTheDocument();
    finish(0);
    await waitFor(() => expect(screen.getByText("exit 0")).toBeInTheDocument());
  });

  it("persists custom tasks and reruns the latest task through its handle", async () => {
    const handle = createRef<RunPanelHandle>();
    const onRun = vi.fn();
    render(
      <RunPanel
        ref={handle}
        workspaceInstanceId="ws"
        roots={roots}
        active
        onRun={onRun}
      />,
    );
    await screen.findByRole("button", { name: /test/ });
    fireEvent.change(screen.getByLabelText("Custom task command"), { target: { value: "pnpm lint" } });
    fireEvent.click(screen.getByLabelText("Add custom task"));
    expect(await screen.findByTitle("pnpm lint — /repo/app")).toBeInTheDocument();
    expect(window.localStorage.getItem("taomni.codeWorkspace.customTasks.v1.ws")).toContain("pnpm lint");

    fireEvent.click(screen.getByTitle("pnpm lint — /repo/app"));
    expect(handle.current?.rerunLast()).toBe(true);
    expect(onRun).toHaveBeenCalledTimes(2);
  });

  it("discovers Java main classes as first-class run targets", async () => {
    workspaceMocks.workspaceJavaRunTargets.mockResolvedValue([{
      id: "java-main:src/main/java/com/example/App.java",
      label: "com.example.App",
      mainClass: "com.example.App",
      filePath: "/repo/app/src/main/java/com/example/App.java",
      command: "./mvnw -q compile exec:java",
      cwd: "/repo/app",
      buildSystem: "maven",
      modulePath: ".",
    }]);
    const onRun = vi.fn();
    render(
      <RunPanel
        workspaceInstanceId="ws"
        roots={roots}
        active
        onRun={onRun}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /com\.example\.App/ }));
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "com.example.App",
        command: "./mvnw -q compile exec:java",
        source: "Java · maven",
      }),
      expect.any(Function),
    );
  });

  it("separates structured run configurations from compatibility tasks", async () => {
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [{
        id: "project:rust",
        provider: "cargo",
        root: "/repo/app",
        manifest: "/repo/app/Cargo.toml",
        module: "app",
        languages: ["rust"],
        toolchain: "cargo",
        diagnostics: [],
      }],
      buildTargets: [],
      runConfigurations: [{
        id: "run:app",
        projectId: "project:rust",
        label: "Run app",
        kind: "bin",
        command: {
          executable: "cargo",
          args: ["run", "--bin", "app", "--"],
          cwd: "/repo/app",
          env: {},
          display: "cargo run --bin app --",
          source: "path",
        },
        preLaunchTargets: [],
      }],
      debugConfigurations: [],
      tools: [],
    });
    const onRun = vi.fn();
    render(<RunPanel workspaceInstanceId="ws" roots={roots} active onRun={onRun} />);

    expect(await screen.findByText("Run configurations")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Run app"));
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({
      command: "cargo run --bin app --",
      configuration: true,
    }), expect.any(Function));
  });
});
