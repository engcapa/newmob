import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionDebugConfiguration, ExecutionRunConfiguration } from "../../../lib/editor/workspace";
import {
  applyRunConfigurationOverride,
  applyRunOverrideToDebugConfiguration,
  parseEnvironmentLines,
  readRunConfigurationOverrides,
  writeRunConfigurationOverride,
} from "./runConfigurationPersistence";

const run: ExecutionRunConfiguration = {
  id: "run:demo",
  projectId: "project:demo",
  label: "Run demo",
  kind: "bin",
  command: {
    executable: "cargo",
    args: ["run", "--bin", "demo", "--"],
    cwd: "/repo",
    env: {},
    display: "cargo run --bin demo --",
    source: "path",
  },
  preLaunchTargets: [],
};

afterEach(() => window.localStorage.clear());

describe("run configuration persistence", () => {
  it("isolates overrides by workspace and appends program arguments", () => {
    writeRunConfigurationOverride("workspace-a", run.id, {
      args: ["hello world", "--verbose"],
      cwd: "/repo/tools",
      env: { LOG_LEVEL: "debug" },
    });
    const override = readRunConfigurationOverrides("workspace-a")[run.id];
    const applied = applyRunConfigurationOverride(run, override);
    expect(applied.command.args).toEqual(["run", "--bin", "demo", "--", "hello world", "--verbose"]);
    expect(applied.command.cwd).toBe("/repo/tools");
    expect(applied.command.env).toEqual({ LOG_LEVEL: "debug" });
    expect(readRunConfigurationOverrides("workspace-b")).toEqual({});
  });

  it("applies args, cwd, and env to the matching DAP payload", () => {
    const debug: ExecutionDebugConfiguration = {
      id: "debug:demo",
      projectId: "project:demo",
      label: "Debug demo",
      adapterId: "lldb",
      request: "launch",
      available: true,
      preLaunchTargets: [],
      launchConfig: { adapterCwd: "/repo", arguments: { program: "/repo/demo", args: [] } },
    };
    const applied = applyRunOverrideToDebugConfiguration(debug, {
      args: ["one"], cwd: "/repo/tools", env: { MODE: "test" },
    });
    expect(applied.launchConfig).toMatchObject({
      adapterCwd: "/repo/tools",
      arguments: { args: ["one"], cwd: "/repo/tools", env: { MODE: "test" } },
    });
  });

  it("parses only valid environment assignments", () => {
    expect(parseEnvironmentLines("A=1\nINVALID\nNOT-VALID=x\nEMPTY=\nB=two=parts")).toEqual({
      A: "1", EMPTY: "", B: "two=parts",
    });
  });
});
