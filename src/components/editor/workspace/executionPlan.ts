import type { ExecutionBuildTarget } from "../../../lib/editor/workspace";

export class ExecutionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionPlanError";
  }
}

/**
 * Resolve build targets into a stable topological order. Each dependency runs
 * once, missing targets are rejected, and cycles are reported before any task
 * starts. This is shared by Build, Run Before launch, and Debug Before launch.
 */
export function resolveBuildTargetPlan(
  requestedTargetIds: readonly string[],
  targets: readonly ExecutionBuildTarget[],
): ExecutionBuildTarget[] {
  const byId = new Map(targets.map((target) => [target.id, target]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const result: ExecutionBuildTarget[] = [];

  const visit = (id: string) => {
    if (visited.has(id)) return;
    const target = byId.get(id);
    if (!target) throw new ExecutionPlanError(`Before launch target is missing: ${id}`);
    if (target.command.error) {
      throw new ExecutionPlanError(`Build target cannot run (${target.label}): ${target.command.error}`);
    }
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(Math.max(0, cycleStart)), id]
        .map((targetId) => byId.get(targetId)?.label ?? targetId);
      throw new ExecutionPlanError(`Build target dependency cycle: ${cycle.join(" -> ")}`);
    }
    visiting.add(id);
    stack.push(id);
    for (const dependencyId of target.dependsOn) visit(dependencyId);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    result.push(target);
  };

  for (const id of requestedTargetIds) visit(id);
  return result;
}

export interface ExecutionPlanResult<T> {
  exitCode: number;
  completed: T[];
  failed: T | null;
}

/** Run callback-based terminal tasks serially and stop on the first failure. */
export async function executeTaskPlan<T>(
  tasks: readonly T[],
  launch: (task: T, onExit: (exitCode: number) => void) => void,
): Promise<ExecutionPlanResult<T>> {
  const completed: T[] = [];
  for (const task of tasks) {
    const exitCode = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      try {
        launch(task, finish);
      } catch (error) {
        settled = true;
        reject(error);
      }
    });
    if (exitCode !== 0) return { exitCode, completed, failed: task };
    completed.push(task);
  }
  return { exitCode: 0, completed, failed: null };
}
