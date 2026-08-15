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

export interface CompoundExecutionNode {
  id: string;
  command?: { error?: string };
  compoundConfigurationIds?: readonly string[];
  compoundParallel?: boolean;
  compoundStopOnFailure?: boolean;
}

/**
 * Validate the complete compound graph before any process starts. The backend
 * performs the same validation for repository files, but this boundary also
 * protects browser fixtures, local configuration copies, and stale models.
 */
export function validateCompoundExecutionGraph<T extends CompoundExecutionNode>(
  root: T,
  configurations: readonly T[],
): Map<string, T> {
  const byId = new Map<string, T>();
  for (const configuration of configurations) {
    if (byId.has(configuration.id)) {
      throw new ExecutionPlanError(`Duplicate run configuration id: ${configuration.id}`);
    }
    byId.set(configuration.id, configuration);
  }
  if (byId.has(root.id)) {
    throw new ExecutionPlanError(`Duplicate run configuration id: ${root.id}`);
  }
  byId.set(root.id, root);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (configuration: T) => {
    if (visited.has(configuration.id)) return;
    if (configuration.command?.error) {
      throw new ExecutionPlanError(
        `Run configuration cannot start (${configuration.id}): ${configuration.command.error}`,
      );
    }
    if (visiting.has(configuration.id)) {
      const cycleStart = stack.indexOf(configuration.id);
      const cycle = [...stack.slice(Math.max(0, cycleStart)), configuration.id];
      throw new ExecutionPlanError(`Compound run configuration cycle: ${cycle.join(" -> ")}`);
    }
    const childIds = configuration.compoundConfigurationIds;
    if (childIds === undefined) {
      visited.add(configuration.id);
      return;
    }
    if (childIds.length === 0) {
      throw new ExecutionPlanError(`Compound run configuration has no children: ${configuration.id}`);
    }
    const unique = new Set<string>();
    visiting.add(configuration.id);
    stack.push(configuration.id);
    for (const childId of childIds) {
      if (unique.has(childId)) {
        throw new ExecutionPlanError(
          `Compound run configuration ${configuration.id} contains duplicate child: ${childId}`,
        );
      }
      unique.add(childId);
      const child = byId.get(childId);
      if (!child) {
        throw new ExecutionPlanError(
          `Compound run configuration ${configuration.id} references missing child: ${childId}`,
        );
      }
      visit(child);
    }
    stack.pop();
    visiting.delete(configuration.id);
    visited.add(configuration.id);
  };
  visit(root);
  return byId;
}

/**
 * Execute an IntelliJ-style compound Run configuration. Each node runs its own
 * Before launch preparation; leaves then launch in declared order or in
 * parallel. Parallel children are all started before failure is known, while
 * sequential children honor stopOnFailure (default true).
 */
export async function executeCompoundConfiguration<T extends CompoundExecutionNode>(
  root: T,
  configurations: readonly T[],
  prepare: (configuration: T) => Promise<number>,
  launch: (configuration: T) => Promise<number>,
): Promise<ExecutionPlanResult<T>> {
  const byId = validateCompoundExecutionGraph(root, configurations);

  const run = async (configuration: T): Promise<ExecutionPlanResult<T>> => {
    const prepareExitCode = await prepare(configuration);
    if (prepareExitCode !== 0) {
      return { exitCode: prepareExitCode, completed: [], failed: configuration };
    }
    const childIds = configuration.compoundConfigurationIds;
    if (childIds === undefined) {
      const exitCode = await launch(configuration);
      return exitCode === 0
        ? { exitCode: 0, completed: [configuration], failed: null }
        : { exitCode, completed: [], failed: configuration };
    }

    const children = childIds.map((id) => byId.get(id)!);
    if (configuration.compoundParallel) {
      const results = await Promise.all(children.map(run));
      const firstFailure = results.find((result) => result.exitCode !== 0);
      return {
        exitCode: firstFailure?.exitCode ?? 0,
        completed: results.flatMap((result) => result.completed),
        failed: firstFailure?.failed ?? null,
      };
    }

    const completed: T[] = [];
    let firstFailure: ExecutionPlanResult<T> | null = null;
    for (const child of children) {
      const result = await run(child);
      completed.push(...result.completed);
      if (result.exitCode !== 0 && !firstFailure) firstFailure = result;
      if (result.exitCode !== 0 && configuration.compoundStopOnFailure !== false) break;
    }
    return {
      exitCode: firstFailure?.exitCode ?? 0,
      completed,
      failed: firstFailure?.failed ?? null,
    };
  };

  return run(root);
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
