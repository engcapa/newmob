import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { RunPanel, type RunPanelHandle } from "./RunPanel";
import {
  readActiveRunConfigurationSelection,
  readRunConfigurationOverrides,
  writeRunConfigurationOverride,
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

  it("surfaces shared configuration provenance and keeps local overrides local", async () => {
    workspaceMocks.workspaceJavaRunTargets.mockResolvedValue([{
      id: "java-main:src/App.java",
      label: "App",
      mainClass: "App",
      filePath: "/repo/app/src/App.java",
      command: "java App",
      cwd: "/repo/app",
      buildSystem: "single-file",
      modulePath: ".",
    }]);
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [],
      buildTargets: [],
      runConfigurations: [{
        id: "shared-run:team",
        projectId: "shared:workspace",
        label: "Team launch",
        kind: "shared",
        configurationSource: "shared",
        sourceFile: "/repo/app/src/App.java",
        command: {
          executable: "cargo",
          args: ["run"],
          cwd: "/repo/app",
          env: {},
          display: "cargo run",
          source: "path",
        },
        preLaunchTargets: [],
      }],
      debugConfigurations: [],
      tools: [],
      diagnostics: ["invalid optional configuration was ignored"],
    });
    render(<RunPanel workspaceInstanceId="ws" roots={roots} active onRun={vi.fn()} />);

    const configuration = await screen.findByTestId("run-panel-configuration-shared-run:team");
    expect(screen.getByTestId("run-panel-configuration-source-shared-run:team"))
      .toHaveAttribute("data-configuration-source", "shared");
    expect(screen.getByTestId("run-panel-execution-diagnostics"))
      .toHaveTextContent("invalid optional configuration was ignored");

    fireEvent.click(screen.getByLabelText("Edit run configuration Team launch"));
    fireEvent.change(screen.getByTestId("run-configuration-name"), { target: { value: "Local launch" } });
    fireEvent.click(screen.getByTestId("run-configuration-save"));
    const local = await screen.findByTestId("run-panel-configuration-source-shared-run:team");
    expect(local).toHaveAttribute("data-configuration-source", "local");
    expect(configuration).toBeInTheDocument();
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
    fireEvent.change(screen.getByTestId("run-configuration-profiles"), { target: { value: "dev, local" } });
    fireEvent.change(screen.getByTestId("run-configuration-properties"), { target: { value: "server.port=8080" } });
    fireEvent.change(screen.getByTestId("run-configuration-args"), { target: { value: "--verbose" } });
    fireEvent.change(screen.getByTestId("run-configuration-env-file"), { target: { value: ".env" } });
    fireEvent.change(screen.getByTestId("run-configuration-env"), { target: { value: "MODE=explicit" } });
    fireEvent.click(screen.getByTestId("run-configuration-before-launch-build:compile"));
    fireEvent.click(screen.getByTestId("run-configuration-save"));

    expect(await screen.findByTestId("run-panel-configuration-run:app")).toHaveTextContent("Local app");
    fireEvent.click(screen.getByLabelText("Copy run configuration Local app"));
    expect(await screen.findByDisplayValue("Local app copy")).toBeInTheDocument();
    expect(screen.getByTestId("run-configuration-vm-options")).toHaveValue("-Xmx1g");
    expect(screen.getByTestId("run-configuration-profiles")).toHaveValue("dev, local");
    expect(screen.getByTestId("run-configuration-properties")).toHaveValue("server.port=8080");
    expect(screen.getByTestId("run-configuration-env-file")).toHaveValue(".env");

    const named = readRunConfigurationOverrides("ws", "app");
    const copyId = Object.keys(named).find((id) => id.includes(":user:"));
    expect(copyId).toBeTruthy();
    expect(named[copyId!].activeProfiles).toEqual(["dev", "local"]);
    expect(named[copyId!].properties).toEqual({ "server.port": "8080" });
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

  it("resets local launch fields to provider or shared configuration defaults", async () => {
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [],
      buildTargets: [{
        id: "build:compile", projectId: "project:app", label: "Compile", kind: "build",
        command: { executable: "cargo", args: ["build"], cwd: "/repo/app", env: {}, display: "cargo build", source: "path" },
        dependsOn: [],
      }],
      runConfigurations: [{
        id: "run:app", projectId: "project:app", label: "Shared app", kind: "bin",
        command: { executable: "node", args: ["app.js"], cwd: "/repo/app", env: {}, display: "node app.js", source: "path" },
        runtimeOptions: ["--trace-warnings"],
        envFile: ".env.shared",
        preLaunchTargets: ["build:compile"],
      }],
      debugConfigurations: [], tools: [],
    });
    writeRunConfigurationOverride("ws", "run:app", {
      name: "Local app",
      args: [],
      vmOptions: ["--inspect"],
      cwd: "",
      env: {},
      envFile: ".env.local",
      preLaunchTargets: [],
    });
    render(<RunPanel workspaceInstanceId="ws" roots={roots} active onRun={vi.fn()} />);

    fireEvent.click(await screen.findByLabelText("Edit run configuration Local app"));
    expect(screen.getByTestId("run-configuration-vm-options")).toHaveValue("--inspect");
    expect(screen.getByTestId("run-configuration-env-file")).toHaveValue(".env.local");
    expect(screen.getByTestId("run-configuration-before-launch-build:compile")).not.toBeChecked();

    fireEvent.click(screen.getByTestId("run-configuration-reset"));
    expect(screen.getByTestId("run-configuration-name")).toHaveValue("Shared app");
    expect(screen.getByTestId("run-configuration-vm-options")).toHaveValue("--trace-warnings");
    expect(screen.getByTestId("run-configuration-env-file")).toHaveValue(".env.shared");
    expect(screen.getByTestId("run-configuration-before-launch-build:compile")).toBeChecked();
    await waitFor(() => expect(screen.getByTestId("run-panel-configuration-run:app"))
      .toHaveTextContent("Shared app"));
  });

  it("keeps same-id run configuration overrides isolated between roots", async () => {
    const multiRoots = [
      { id: "one", name: "one", path: "/repo/one", kind: "git" as const },
      { id: "two", name: "two", path: "/repo/two", kind: "git" as const },
    ];
    workspaceMocks.workspaceExecutionModel.mockImplementation(async (rootPath: string) => ({
      projects: [], buildTargets: [], debugConfigurations: [], tools: [],
      runConfigurations: [{
        id: "shared-run:dev", projectId: `project:${rootPath}`, label: "Dev", kind: "bin",
        command: { executable: "node", args: ["app.js"], cwd: rootPath, env: {}, display: "node app.js", source: "path" },
        preLaunchTargets: [],
      }],
    }));
    writeRunConfigurationOverride("ws", "shared-run:dev", {
      name: "One dev", args: [], cwd: "", env: {},
    }, "one");
    writeRunConfigurationOverride("ws", "shared-run:dev", {
      name: "Two dev", args: [], cwd: "", env: {},
    }, "two");

    render(<RunPanel workspaceInstanceId="ws" roots={multiRoots} active onRun={vi.fn()} />);

    const rows = await screen.findAllByTestId("run-panel-configuration-shared-run:dev");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("One dev")).toBeInTheDocument();
    expect(screen.getByText("Two dev")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Edit run configuration Two dev"));
    expect(screen.getByTestId("run-configuration-name")).toHaveValue("Two dev");
    fireEvent.change(screen.getByTestId("run-configuration-name"), { target: { value: "Two changed" } });
    fireEvent.click(screen.getByTestId("run-configuration-save"));
    await waitFor(() => expect(within(screen.getByTestId("run-panel-configurations-two"))
      .getByText("Two changed")).toBeInTheDocument());
    expect(readRunConfigurationOverrides("ws", "one")["shared-run:dev"].name).toBe("One dev");
    expect(readRunConfigurationOverrides("ws", "two")["shared-run:dev"].name).toBe("Two changed");
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

  it("executes compound Run children in order and honors stopOnFailure", async () => {
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [], buildTargets: [], debugConfigurations: [], tools: [],
      runConfigurations: [
        {
          id: "run:first", projectId: "project:app", label: "First", kind: "bin",
          command: { executable: "node", args: ["first.js"], cwd: "/repo/app", env: {}, display: "node first.js", source: "path" },
          preLaunchTargets: [],
        },
        {
          id: "run:second", projectId: "project:app", label: "Second", kind: "bin",
          command: { executable: "node", args: ["second.js"], cwd: "/repo/app", env: {}, display: "node second.js", source: "path" },
          preLaunchTargets: [],
        },
        {
          id: "run:all", projectId: "project:app", label: "All", kind: "compound",
          command: { executable: "__taomni_compound__", args: [], cwd: "/repo/app", env: {}, display: "Compound configuration", source: "configured" },
          preLaunchTargets: [],
          compoundConfigurationIds: ["run:first", "run:second"],
          compoundStopOnFailure: true,
        },
      ],
    });
    const launched: string[] = [];
    const onRun = vi.fn((task, onExit: (exitCode: number) => void) => {
      launched.push(task.label);
      onExit(task.label === "First" ? 7 : 0);
    });
    render(<RunPanel workspaceInstanceId="ws" roots={roots} active onRun={onRun} />);

    fireEvent.click(await screen.findByText("All"));
    await waitFor(() => expect(launched).toEqual(["First"]));
    expect(onRun).not.toHaveBeenCalledWith(expect.objectContaining({ label: "Second" }), expect.any(Function));
    expect(await screen.findByText("exit 7")).toBeInTheDocument();
  });

  it("rejects an unavailable compound child before starting any child", async () => {
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [], buildTargets: [], debugConfigurations: [], tools: [],
      runConfigurations: [
        {
          id: "run:ready", projectId: "project:app", label: "Ready", kind: "bin",
          command: { executable: "node", args: ["ready.js"], cwd: "/repo/app", env: {}, display: "node ready.js", source: "path" },
          preLaunchTargets: [],
        },
        {
          id: "run:missing", projectId: "project:app", label: "Missing", kind: "bin",
          command: {
            executable: "missing-runtime", args: [], cwd: "/repo/app", env: {},
            display: "missing-runtime", source: "path", error: "missing-runtime was not found",
          },
          preLaunchTargets: [],
        },
        {
          id: "run:all", projectId: "project:app", label: "All", kind: "compound",
          command: { executable: "__taomni_compound__", args: [], cwd: "/repo/app", env: {}, display: "Compound configuration", source: "configured" },
          preLaunchTargets: [], compoundConfigurationIds: ["run:ready", "run:missing"],
        },
      ],
    });
    const onRun = vi.fn();
    render(<RunPanel workspaceInstanceId="ws" roots={roots} active onRun={onRun} />);

    fireEvent.click(await screen.findByText("All"));
    expect(await screen.findByText(/missing-runtime was not found/)).toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("runs a toolbar compound from its catalog before inactive panel discovery", async () => {
    const child = {
      id: "run:first", projectId: "project:app", label: "First", kind: "bin",
      command: {
        executable: "node", args: ["first.js"], cwd: "/repo/app", env: {},
        display: "node first.js", source: "path" as const,
      },
      preLaunchTargets: [],
    };
    const compound = {
      id: "run:all", projectId: "project:app", label: "All", kind: "compound",
      command: {
        executable: "__taomni_compound__", args: [], cwd: "/repo/app", env: {},
        display: "Compound configuration", source: "configured" as const,
      },
      preLaunchTargets: [],
      compoundConfigurationIds: [child.id],
      compoundStopOnFailure: true,
    };
    const handle = createRef<RunPanelHandle>();
    const launched: string[] = [];
    const onRun = vi.fn((task, onExit: (exitCode: number) => void) => {
      launched.push(task.execution?.executable ?? "");
      onExit(0);
    });
    render(
      <RunPanel
        ref={handle}
        workspaceInstanceId="ws"
        roots={roots}
        active={false}
        onRun={onRun}
      />,
    );

    act(() => {
      handle.current?.run({
        id: compound.id,
        label: compound.label,
        command: compound.command.display,
        cwd: compound.command.cwd,
        source: "Run configuration",
        rootId: "app",
        rootName: "app",
        configuration: true,
        runConfiguration: compound,
        configurationCatalog: [child, compound],
        execution: {
          executable: compound.command.executable,
          args: [],
          source: "configured",
        },
      });
    });

    await waitFor(() => expect(launched).toEqual(["node"]));
    expect(onRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ execution: expect.objectContaining({ executable: "__taomni_compound__" }) }),
      expect.any(Function),
    );
    expect(workspaceMocks.workspaceDetectTasks).not.toHaveBeenCalled();
    expect(workspaceMocks.workspaceJavaRunTargets).not.toHaveBeenCalled();
    expect(workspaceMocks.workspaceExecutionModel).not.toHaveBeenCalled();
  });

  it("does not launch a sentinel for an invalid compound configuration", async () => {
    const invalidConfiguration = {
      id: "run:invalid", projectId: "project:app", label: "Invalid compound", kind: "compound",
      command: {
        executable: "__taomni_compound__", args: [], cwd: "/repo/app", env: {},
        display: "Compound configuration", source: "configured" as const,
        error: "Compound configuration has no valid Run children",
      },
      preLaunchTargets: [], compoundConfigurationIds: [],
    };
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [], buildTargets: [], debugConfigurations: [], tools: [],
      runConfigurations: [invalidConfiguration],
    });
    const handle = createRef<RunPanelHandle>();
    const onRun = vi.fn();
    render(<RunPanel ref={handle} workspaceInstanceId="ws" roots={roots} active onRun={onRun} />);

    const button = await screen.findByTestId("run-panel-configuration-run:invalid");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Compound configuration has no valid Run children");
    handle.current?.run({
      id: invalidConfiguration.id,
      label: invalidConfiguration.label,
      command: invalidConfiguration.command.display,
      cwd: invalidConfiguration.command.cwd,
      source: "Run configuration",
      rootId: "app",
      rootName: "app",
      configuration: true,
      runConfiguration: invalidConfiguration,
      execution: {
        executable: invalidConfiguration.command.executable,
        args: [],
        source: "configured",
        error: invalidConfiguration.command.error,
      },
    });
    expect(onRun).not.toHaveBeenCalled();
    expect(await screen.findByText("Compound configuration has no valid Run children")).toBeInTheDocument();
  });
});
