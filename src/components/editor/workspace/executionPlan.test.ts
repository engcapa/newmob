import { describe, expect, it, vi } from "vitest";
import type { ExecutionBuildTarget } from "../../../lib/editor/workspace";
import {
  executeCompoundConfiguration,
  ExecutionPlanError,
  executeTaskPlan,
  resolveBuildTargetPlan,
  validateCompoundExecutionGraph,
} from "./executionPlan";
import type { CompoundExecutionNode } from "./executionPlan";

function target(id: string, dependsOn: string[] = []): ExecutionBuildTarget {
  return {
    id,
    projectId: "project",
    label: id,
    kind: "build",
    command: {
      executable: "tool",
      args: [id],
      cwd: "/repo",
      env: {},
      display: `tool ${id}`,
      source: "path",
    },
    dependsOn,
  };
}

describe("execution plans", () => {
  it("topologically resolves shared dependencies once", () => {
    const targets = [
      target("restore"),
      target("generate", ["restore"]),
      target("compile", ["restore", "generate"]),
      target("test", ["compile"]),
    ];
    expect(resolveBuildTargetPlan(["compile", "test"], targets).map((item) => item.id))
      .toEqual(["restore", "generate", "compile", "test"]);
  });

  it("rejects missing dependencies and cycles before execution", () => {
    expect(() => resolveBuildTargetPlan(["compile"], [target("compile", ["restore"])]))
      .toThrowError(new ExecutionPlanError("Before launch target is missing: restore"));
    expect(() => resolveBuildTargetPlan(["a"], [target("a", ["b"]), target("b", ["a"])]))
      .toThrow(/a -> b -> a/);
    expect(() => resolveBuildTargetPlan(["compile"], [{
      ...target("compile"),
      command: { ...target("compile").command, error: "compiler not found" },
    }])).toThrow(/compiler not found/);
  });

  it("runs serially and stops at the first failing task", async () => {
    const launched: string[] = [];
    const launch = vi.fn((task: string, onExit: (code: number) => void) => {
      launched.push(task);
      onExit(task === "compile" ? 2 : 0);
    });
    const result = await executeTaskPlan(["restore", "compile", "run"], launch);
    expect(launched).toEqual(["restore", "compile"]);
    expect(result).toEqual({ exitCode: 2, completed: ["restore"], failed: "compile" });
  });

  it("validates and executes nested compound configurations", async () => {
    const events: string[] = [];
    const leaf = (id: string): CompoundExecutionNode => ({ id });
    const nested: CompoundExecutionNode = { id: "nested", compoundConfigurationIds: ["a", "b"] };
    const root: CompoundExecutionNode = {
      id: "root",
      compoundConfigurationIds: ["nested", "c"],
      compoundStopOnFailure: false,
    };
    const result = await executeCompoundConfiguration(
      root,
      [nested, leaf("a"), leaf("b"), leaf("c")],
      async (configuration) => {
        events.push(`prepare:${configuration.id}`);
        return 0;
      },
      async (configuration) => {
        events.push(`launch:${configuration.id}`);
        return configuration.id === "b" ? 2 : 0;
      },
    );
    expect(result.exitCode).toBe(2);
    expect(events).toEqual([
      "prepare:root", "prepare:nested", "prepare:a", "launch:a",
      "prepare:b", "launch:b", "prepare:c", "launch:c",
    ]);
  });

  it("rejects missing children, duplicates, and cycles before launching", async () => {
    const leaf = (id: string): CompoundExecutionNode => ({ id });
    await expect(executeCompoundConfiguration(
      { id: "root", compoundConfigurationIds: ["missing"] },
      [],
      async () => 0,
      async () => 0,
    )).rejects.toThrow(/missing child/);
    await expect(executeCompoundConfiguration(
      { id: "root", compoundConfigurationIds: ["a", "a"] },
      [leaf("a")],
      async () => 0,
      async () => 0,
    )).rejects.toThrow(/duplicate child/);
    await expect(executeCompoundConfiguration(
      { id: "root", compoundConfigurationIds: ["a"] },
      [{ id: "a", compoundConfigurationIds: ["root"] }],
      async () => 0,
      async () => 0,
    )).rejects.toThrow(/cycle/);
  });

  it("rejects duplicate configuration ids even when the same object is reused", () => {
    const child = { id: "child" } satisfies CompoundExecutionNode;
    expect(() => validateCompoundExecutionGraph<CompoundExecutionNode>(
      { id: "root", compoundConfigurationIds: ["child"] },
      [child, child],
    )).toThrow("Duplicate run configuration id: child");
    expect(() => validateCompoundExecutionGraph<CompoundExecutionNode>(
      { id: "root", compoundConfigurationIds: ["child"] },
      [{ id: "root" }, child],
    )).toThrow("Duplicate run configuration id: root");
  });

  it("rejects an unavailable compound leaf before preparing any configuration", async () => {
    const prepare = vi.fn(async () => 0);
    const launch = vi.fn(async () => 0);
    const configurations: CompoundExecutionNode[] = [
      { id: "ready" },
      { id: "missing-tool", command: { error: "node was not found" } },
    ];
    await expect(executeCompoundConfiguration(
      { id: "root", compoundConfigurationIds: ["ready", "missing-tool"] },
      configurations,
      prepare,
      launch,
    )).rejects.toThrow("node was not found");
    expect(prepare).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});
