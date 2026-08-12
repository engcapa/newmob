import type {
  ExecutionDebugConfiguration,
  ExecutionRunConfiguration,
  JavaRunTarget,
} from "../../../lib/editor/workspace";

export interface RunConfigurationOverride {
  /** Optional user-facing name. Copies always carry a name. */
  name?: string;
  /** Detected configuration this named copy derives from. */
  baseConfigurationId?: string;
  args: string[];
  vmOptions?: string[];
  cwd: string;
  env: Record<string, string>;
  envFile?: string;
  /** Null means inherit the provider-discovered Before launch targets. */
  preLaunchTargets?: string[] | null;
}

export type RunConfigurationOverrides = Record<string, RunConfigurationOverride>;

/** Convert a source-discovered Java main into the same configuration contract
 * used by structured providers. This keeps Gradle/source-file compatibility
 * launches configurable instead of bypassing the Run/Debug model. */
export function javaRunTargetToExecutionRunConfiguration(
  target: JavaRunTarget,
): ExecutionRunConfiguration {
  const fallback = splitCompatibilityCommand(target.command);
  const execution = target.execution ?? {
    executable: fallback[0] || "java",
    args: fallback.slice(1),
    source: "path" as const,
  };
  return {
    id: target.id,
    projectId: `java-fallback:${target.id}`,
    label: target.label,
    kind: "java-main",
    command: {
      executable: execution.executable,
      args: [...execution.args],
      cwd: target.cwd,
      env: Object.fromEntries(Object.entries(target.environment ?? {}).map(([name, value]) => [name, value.value])),
      display: target.command,
      source: execution.source,
      error: execution.error,
    },
    sourceFile: target.filePath,
    preLaunchTargets: [],
    argumentStrategy: target.buildSystem === "maven"
      ? "maven-exec"
      : target.buildSystem === "gradle"
        ? "gradle-javaexec"
        : "append",
    environmentModes: Object.fromEntries(Object.entries(target.environment ?? {}).map(([name, value]) => [name, value.mode])),
  };
}

/**
 * Recover an argv vector from the display command used by old browser fixtures.
 * Production targets always provide `execution`; this parser is intentionally
 * shell-free and only preserves quoting/escaping needed by legacy test data.
 */
export function splitCompatibilityCommand(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let tokenStarted = false;
  const source = value.trim();
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === "\"" && next === "\"") {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === "\\" && next && (/\s/.test(next) || next === "\"" || next === "'")) {
      current += next;
      index += 1;
      tokenStarted = true;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (tokenStarted) args.push(current);
  return args;
}

const KEY_PREFIX = "taomni.codeWorkspace.runConfigurations.v1";
const ACTIVE_CONFIGURATION_KEY_PREFIX = "taomni.codeWorkspace.activeRunConfiguration.v1";
export const RUN_CONFIGURATION_CHANGED_EVENT = "taomni:run-configuration-changed";

function storageKey(workspaceInstanceId: string): string {
  return `${KEY_PREFIX}.${workspaceInstanceId}`;
}

function activeConfigurationStorageKey(workspaceInstanceId: string): string {
  return `${ACTIVE_CONFIGURATION_KEY_PREFIX}.${workspaceInstanceId}`;
}

function normalizePathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

/** Read the per-file active configuration map used by the Run/Debug toolbar. */
export function readActiveRunConfigurationSelections(
  workspaceInstanceId: string,
): Record<string, string> {
  if (!workspaceInstanceId || typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(activeConfigurationStorageKey(workspaceInstanceId)) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([path, id]) => (
      typeof id === "string" && id.trim() && normalizePathKey(path)
        ? [[normalizePathKey(path), id.trim()]]
        : []
    )));
  } catch {
    return {};
  }
}

export function readActiveRunConfigurationSelection(
  workspaceInstanceId: string,
  sourceFile: string,
): string | null {
  return readActiveRunConfigurationSelections(workspaceInstanceId)[normalizePathKey(sourceFile)] ?? null;
}

export function writeActiveRunConfigurationSelection(
  workspaceInstanceId: string,
  sourceFile: string,
  configurationId: string | null,
): void {
  if (!workspaceInstanceId || typeof window === "undefined") return;
  const path = normalizePathKey(sourceFile);
  if (!path) return;
  const selections = readActiveRunConfigurationSelections(workspaceInstanceId);
  if (configurationId?.trim()) selections[path] = configurationId.trim();
  else delete selections[path];
  try {
    window.localStorage.setItem(activeConfigurationStorageKey(workspaceInstanceId), JSON.stringify(selections));
    window.dispatchEvent(new CustomEvent(RUN_CONFIGURATION_CHANGED_EVENT, {
      detail: { workspaceInstanceId, sourceFile: path, configurationId },
    }));
  } catch {
    // Restricted webviews may reject localStorage writes.
  }
}

function normalizeOverride(value: unknown): RunConfigurationOverride | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as {
    name?: unknown;
    baseConfigurationId?: unknown;
    args?: unknown;
    vmOptions?: unknown;
    cwd?: unknown;
    env?: unknown;
    envFile?: unknown;
    preLaunchTargets?: unknown;
  };
  const args = Array.isArray(candidate.args)
    ? candidate.args.filter((item): item is string => typeof item === "string")
    : [];
  const vmOptions = Array.isArray(candidate.vmOptions)
    ? candidate.vmOptions.filter((item): item is string => typeof item === "string")
    : [];
  const cwd = typeof candidate.cwd === "string" ? candidate.cwd.trim() : "";
  const env: Record<string, string> = {};
  if (candidate.env && typeof candidate.env === "object" && !Array.isArray(candidate.env)) {
    for (const [name, item] of Object.entries(candidate.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof item === "string") env[name] = item;
    }
  }
  const preLaunchTargets = candidate.preLaunchTargets === null
    ? null
    : Array.isArray(candidate.preLaunchTargets)
      ? candidate.preLaunchTargets.filter((item): item is string => typeof item === "string")
      : null;
  return {
    name: typeof candidate.name === "string" ? candidate.name.trim() : "",
    baseConfigurationId: typeof candidate.baseConfigurationId === "string"
      ? candidate.baseConfigurationId.trim()
      : "",
    args,
    vmOptions,
    cwd,
    env,
    envFile: typeof candidate.envFile === "string" ? candidate.envFile.trim() : "",
    preLaunchTargets,
  };
}

export function readRunConfigurationOverrides(workspaceInstanceId: string): RunConfigurationOverrides {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(workspaceInstanceId)) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: RunConfigurationOverrides = {};
    for (const [id, value] of Object.entries(parsed)) {
      const normalized = normalizeOverride(value);
      if (normalized) result[id] = normalized;
    }
    return result;
  } catch {
    return {};
  }
}

export function writeRunConfigurationOverride(
  workspaceInstanceId: string,
  configurationId: string,
  value: RunConfigurationOverride | null,
): RunConfigurationOverrides {
  const current = readRunConfigurationOverrides(workspaceInstanceId);
  if (value) current[configurationId] = normalizeOverride(value) ?? {
    name: "",
    baseConfigurationId: "",
    args: [],
    vmOptions: [],
    cwd: "",
    env: {},
    envFile: "",
    preLaunchTargets: null,
  };
  else delete current[configurationId];
  window.localStorage.setItem(storageKey(workspaceInstanceId), JSON.stringify(current));
  window.dispatchEvent(new CustomEvent(RUN_CONFIGURATION_CHANGED_EVENT, {
    detail: { workspaceInstanceId, configurationId },
  }));
  return current;
}

function quoteArgument(value: string): string {
  if (value && /^[A-Za-z0-9_+./:=@\\-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appendOption(existing: string | undefined, options: readonly string[]): string {
  return [existing?.trim(), ...options.map((option) => option.trim())]
    .filter((value): value is string => !!value)
    .join(" ");
}

function runtimeCommand(
  configuration: ExecutionRunConfiguration,
  runtimeOptions: readonly string[],
): ExecutionRunConfiguration["command"] {
  if (runtimeOptions.length === 0) return configuration.command;
  const command = configuration.command;
  const executableName = command.executable.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  let args = [...command.args];
  const env = { ...command.env };
  if (/^(java|java\.exe|node|node\.exe)$/.test(executableName)) {
    args = [...runtimeOptions, ...args];
  } else if (/^(mvn|mvnw|mvn\.cmd|mvnw\.cmd|mvn\.bat|mvnw\.bat)$/.test(executableName)) {
    env.MAVEN_OPTS = appendOption(env.MAVEN_OPTS, runtimeOptions);
  } else if (/^(gradle|gradlew|gradle\.bat|gradlew\.bat|gradle\.cmd|gradlew\.cmd|sbt|sbt\.bat)$/.test(executableName)) {
    env.JAVA_TOOL_OPTIONS = appendOption(env.JAVA_TOOL_OPTIONS, runtimeOptions);
  }
  return {
    ...command,
    args,
    env,
    display: [command.executable, ...args].map(quoteArgument).join(" "),
  };
}

function configuredProgramArguments(
  configuration: ExecutionRunConfiguration,
  args: readonly string[],
): string[] {
  if (configuration.argumentStrategy === "maven-exec") {
    const withoutExisting = configuration.command.args.filter((value) => !value.startsWith("-Dexec.args="));
    return args.length === 0
      ? withoutExisting
      : [...withoutExisting, `-Dexec.args=${args.map(quoteArgument).join(" ")}`];
  }
  if (configuration.argumentStrategy === "gradle-javaexec") {
    const separator = configuration.command.args.indexOf("--args");
    const base = separator >= 0
      ? configuration.command.args.slice(0, separator)
      : [...configuration.command.args];
    return args.length === 0 ? base : [...base, "--args", args.map(quoteArgument).join(" ")];
  }
  if (args.length === 0) return [...configuration.command.args];
  return [...configuration.command.args, ...args];
}

export function applyRunConfigurationOverride(
  configuration: ExecutionRunConfiguration,
  override: RunConfigurationOverride | undefined,
): ExecutionRunConfiguration {
  if (!override) return configuration;
  const runtimeOptions = override.vmOptions ?? [];
  const runtimeApplied = runtimeCommand(configuration, runtimeOptions);
  const args = configuredProgramArguments({ ...configuration, command: runtimeApplied }, override.args);
  const executable = runtimeApplied.executable;
  const executableName = executable.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const environmentModes = { ...configuration.environmentModes };
  if (runtimeOptions.length > 0) {
    if (/^(mvn|mvnw|mvn\.cmd|mvnw\.cmd|mvn\.bat|mvnw\.bat)$/.test(executableName)) {
      environmentModes.MAVEN_OPTS = "append";
    } else if (/^(gradle|gradlew|gradle\.bat|gradlew\.bat|gradle\.cmd|gradlew\.cmd|sbt|sbt\.bat)$/.test(executableName)) {
      environmentModes.JAVA_TOOL_OPTIONS = "append";
    }
  }
  for (const name of Object.keys(override.env)) environmentModes[name] = "replace";
  return {
    ...configuration,
    label: override.name?.trim() || configuration.label,
    baseConfigurationId: override.baseConfigurationId || configuration.baseConfigurationId,
    preLaunchTargets: override.preLaunchTargets ?? configuration.preLaunchTargets,
    runtimeOptions: override.vmOptions?.length ? [...override.vmOptions] : undefined,
    envFile: override.envFile?.trim() || undefined,
    environmentModes,
    command: {
      ...runtimeApplied,
      args,
      cwd: override.cwd || configuration.command.cwd,
      env: { ...runtimeApplied.env, ...override.env },
      display: [executable, ...args].map(quoteArgument).join(" "),
    },
  };
}

export function applyRunOverrideToDebugConfiguration(
  configuration: ExecutionDebugConfiguration,
  override: RunConfigurationOverride | undefined,
): ExecutionDebugConfiguration {
  if (!override) return configuration;
  const launchConfig = structuredClone(configuration.launchConfig);
  const argumentsValue = launchConfig.arguments;
  const args = argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
    ? argumentsValue as Record<string, unknown>
    : {};
  const existingArgs = Array.isArray(args.args)
    ? args.args.filter((item): item is string => typeof item === "string")
    : [];
  args.args = override.args.length > 0 ? [...existingArgs, ...override.args] : existingArgs;
  const existingVmArgs = Array.isArray(args.vmArgs)
    ? args.vmArgs.filter((item): item is string => typeof item === "string")
    : [];
  args.vmArgs = override.vmOptions?.length
    ? [...existingVmArgs, ...override.vmOptions]
    : existingVmArgs;
  if (override.cwd) args.cwd = override.cwd;
  args.env = { ...(typeof args.env === "object" && args.env ? args.env : {}), ...override.env };
  launchConfig.arguments = args;
  if (override.cwd) launchConfig.adapterCwd = override.cwd;
  return {
    ...configuration,
    label: override.name?.trim() || configuration.label,
    preLaunchTargets: override.preLaunchTargets ?? configuration.preLaunchTargets,
    envFile: override.envFile?.trim() || undefined,
    launchConfig,
  };
}

export function resolveEnvironmentFilePath(cwd: string, envFile: string): string {
  const trimmed = envFile.trim();
  if (!trimmed) return "";
  if (/^[A-Za-z]:[\\/]|^[\\/]/.test(trimmed)) return trimmed;
  return `${cwd.replace(/[\\/]+$/, "")}/${trimmed}`;
}

export function mergeDebugEnvironment(
  configuration: ExecutionDebugConfiguration,
  environment: Record<string, string>,
): ExecutionDebugConfiguration {
  if (Object.keys(environment).length === 0) return configuration;
  const launchConfig = structuredClone(configuration.launchConfig);
  const argumentsValue = launchConfig.arguments;
  const args = argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
    ? argumentsValue as Record<string, unknown>
    : {};
  const current = args.env && typeof args.env === "object" && !Array.isArray(args.env)
    ? args.env as Record<string, unknown>
    : {};
  args.env = { ...environment, ...current };
  launchConfig.arguments = args;
  return { ...configuration, launchConfig };
}

export function applyRunOverrideToJavaLaunch(
  launchConfig: Record<string, unknown>,
  override: RunConfigurationOverride | undefined,
  environment: Record<string, string> = {},
): Record<string, unknown> {
  if (!override && Object.keys(environment).length === 0) return launchConfig;
  const currentEnv = launchConfig.env && typeof launchConfig.env === "object" && !Array.isArray(launchConfig.env)
    ? launchConfig.env as Record<string, unknown>
    : {};
  return {
    ...launchConfig,
    ...(override?.args.length ? { args: [...override.args] } : {}),
    ...(override?.vmOptions?.length ? { vmArgs: [...override.vmOptions] } : {}),
    ...(override?.cwd ? { cwd: override.cwd } : {}),
    env: { ...environment, ...currentEnv, ...(override?.env ?? {}) },
  };
}

export function materializeRunConfigurations(
  detected: readonly ExecutionRunConfiguration[],
  overrides: RunConfigurationOverrides,
): ExecutionRunConfiguration[] {
  const result: ExecutionRunConfiguration[] = [];
  for (const configuration of detected) {
    result.push(applyRunConfigurationOverride(configuration, overrides[configuration.id]));
    const copies = Object.entries(overrides)
      .filter(([id, override]) => id !== configuration.id && override.baseConfigurationId === configuration.id)
      .sort(([, left], [, right]) => (left.name ?? "").localeCompare(right.name ?? ""));
    for (const [id, override] of copies) {
      result.push(applyRunConfigurationOverride({
        ...configuration,
        id,
        baseConfigurationId: configuration.id,
      }, override));
    }
  }
  return result;
}

export function createNamedRunConfiguration(
  workspaceInstanceId: string,
  base: ExecutionRunConfiguration,
  name: string,
): string {
  const normalizedName = name.trim() || `${base.label} copy`;
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const originalId = base.baseConfigurationId || base.id;
  const id = `${originalId}:user:${suffix}`;
  const current = readRunConfigurationOverrides(workspaceInstanceId);
  const source = current[base.id] ?? current[originalId];
  writeRunConfigurationOverride(workspaceInstanceId, id, {
    name: normalizedName,
    baseConfigurationId: originalId,
    args: [...(source?.args ?? [])],
    vmOptions: [...(source?.vmOptions ?? base.runtimeOptions ?? [])],
    cwd: source?.cwd ?? "",
    env: { ...(source?.env ?? {}) },
    envFile: source?.envFile ?? base.envFile ?? "",
    preLaunchTargets: [...(source?.preLaunchTargets ?? base.preLaunchTargets)],
  });
  return id;
}

export function parseDotEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const source = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const separator = source.indexOf("=");
    if (separator <= 0) continue;
    const name = source.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let item = source.slice(separator + 1).trim();
    if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))) {
      item = item.slice(1, -1);
    }
    env[name] = item;
  }
  return env;
}

export function parseEnvironmentLines(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    env[name] = trimmed.slice(separator + 1);
  }
  return env;
}

export function formatEnvironmentLines(env: Record<string, string>): string {
  return Object.entries(env).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}
