import { describe, expect, it, vi } from "vitest";
import type { ExecutionBuildTarget } from "../../../lib/editor/workspace";
import {
  ExecutionPlanError,
  executeTaskPlan,
  resolveBuildTargetPlan,
} from "./executionPlan";

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
});
