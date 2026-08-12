import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { RunPanel, type RunPanelHandle } from "./RunPanel";
import {
  readActiveRunConfigurationSelection,
  writeActiveRunConfigurationSelection,
} from "../runConfigurationPersistence";

const workspaceMocks = vi.hoisted(() => ({
  workspaceDetectTasks: vi.fn(),
  workspaceExecutionModel: vi.fn(),
  workspaceJavaRunTargets: vi.fn(),
  workspaceReadLooseFile: vi.fn(),
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
    workspaceMocks.workspaceReadLooseFile.mockReset().mockResolvedValue({ text: "FROM_FILE=yes\nMODE=file" });
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

    expect(await screen.findByText("Run configurations")).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId("run-panel-configuration-java-main:src/main/java/com/example/App.java"));
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "com.example.App",
        command: "./mvnw -q compile exec:java",
        configuration: true,
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

  it("edits and copies named configurations with VM, dotenv, env, and Before launch settings", async () => {
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [],
      buildTargets: [{
        id: "build:compile", projectId: "project:app", label: "Compile", kind: "build",
        command: { executable: "cargo", args: ["build"], cwd: "/repo/app", env: {}, display: "cargo build", source: "path" },
        dependsOn: [],
      }],
      runConfigurations: [{
        id: "run:app", projectId: "project:app", label: "Run app", kind: "bin",
        command: { executable: "cargo", args: ["run", "--"], cwd: "/repo/app", env: {}, display: "cargo run --", source: "path" },
        preLaunchTargets: [],
      }],
      debugConfigurations: [], tools: [],
    });
    const onRun = vi.fn((_task, onExit: (exitCode: number) => void) => onExit(0));
    render(<RunPanel workspaceInstanceId="ws" roots={roots} active onRun={onRun} />);

    fireEvent.click(await screen.findByLabelText("Edit run configuration Run app"));
    fireEvent.change(screen.getByTestId("run-configuration-name"), { target: { value: "Local app" } });
    fireEvent.change(screen.getByTestId("run-configuration-vm-options"), { target: { value: "-Xmx1g" } });
    fireEvent.change(screen.getByTestId("run-configuration-args"), { target: { value: "--verbose" } });
    fireEvent.change(screen.getByTestId("run-configuration-env-file"), { target: { value: ".env" } });
    fireEvent.change(screen.getByTestId("run-configuration-env"), { target: { value: "MODE=explicit" } });
    fireEvent.click(screen.getByTestId("run-configuration-before-launch-build:compile"));
    fireEvent.click(screen.getByTestId("run-configuration-save"));

    expect(await screen.findByTestId("run-panel-configuration-run:app")).toHaveTextContent("Local app");
    fireEvent.click(screen.getByLabelText("Copy run configuration Local app"));
    expect(await screen.findByDisplayValue("Local app copy")).toBeInTheDocument();
    expect(screen.getByTestId("run-configuration-vm-options")).toHaveValue("-Xmx1g");
    expect(screen.getByTestId("run-configuration-env-file")).toHaveValue(".env");

    const namedId = JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.runConfigurations.v1.ws") ?? "{}",
    ) as Record<string, unknown>;
    const copyId = Object.keys(namedId).find((id) => id.includes(":user:"));
    expect(copyId).toBeTruthy();
    writeActiveRunConfigurationSelection("ws", "/repo/app/src/main.rs", copyId!);
    fireEvent.click(screen.getByTestId("run-configuration-delete"));
    await waitFor(() => expect(screen.queryByDisplayValue("Local app copy")).not.toBeInTheDocument());
    expect(readActiveRunConfigurationSelection("ws", "/repo/app/src/main.rs")).toBe("run:app");

    fireEvent.click(screen.getByTestId("run-panel-configuration-run:app"));
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(2));
    expect(onRun.mock.calls[0][0]).toMatchObject({ label: "Compile", command: "cargo build" });
    expect(onRun.mock.calls[1][0]).toMatchObject({
      label: "Local app",
      environment: { FROM_FILE: { value: "yes", mode: "replace" }, MODE: { value: "explicit", mode: "replace" } },
    });
  });

  it("reports dotenv read failures in Run History without launching", async () => {
    workspaceMocks.workspaceReadLooseFile.mockRejectedValue(new Error("read /repo/app/.env: denied"));
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [], buildTargets: [], debugConfigurations: [], tools: [],
      runConfigurations: [{
        id: "run:app", projectId: "project:app", label: "Run app", kind: "bin",
        command: { executable: "cargo", args: ["run"], cwd: "/repo/app", env: {}, display: "cargo run", source: "path" },
        preLaunchTargets: [], envFile: ".env",
      }],
    });
    const onRun = vi.fn();
    render(<RunPanel workspaceInstanceId="ws" roots={roots} active onRun={onRun} />);

    fireEvent.click(await screen.findByText("Run app"));
    expect(await screen.findByText("read /repo/app/.env: denied")).toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("reports a missing Before launch target without starting the run", async () => {
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [], buildTargets: [], debugConfigurations: [], tools: [],
      runConfigurations: [{
        id: "run:app", projectId: "project:app", label: "Run app", kind: "bin",
        command: { executable: "cargo", args: ["run"], cwd: "/repo/app", env: {}, display: "cargo run", source: "path" },
        preLaunchTargets: ["build:missing"],
      }],
    });
    const onRun = vi.fn();
    render(<RunPanel workspaceInstanceId="ws" roots={roots} active onRun={onRun} />);
    fireEvent.click(await screen.findByText("Run app"));
    expect(await screen.findByText(/Before launch target is missing/)).toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();
  });
});
