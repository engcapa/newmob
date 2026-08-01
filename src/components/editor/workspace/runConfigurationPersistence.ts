import type {
  ExecutionDebugConfiguration,
  ExecutionRunConfiguration,
} from "../../../lib/editor/workspace";

export interface RunConfigurationOverride {
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export type RunConfigurationOverrides = Record<string, RunConfigurationOverride>;

const KEY_PREFIX = "taomni.codeWorkspace.runConfigurations.v1";
export const RUN_CONFIGURATION_CHANGED_EVENT = "taomni:run-configuration-changed";

function storageKey(workspaceInstanceId: string): string {
  return `${KEY_PREFIX}.${workspaceInstanceId}`;
}

function normalizeOverride(value: unknown): RunConfigurationOverride | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { args?: unknown; cwd?: unknown; env?: unknown };
  const args = Array.isArray(candidate.args)
    ? candidate.args.filter((item): item is string => typeof item === "string")
    : [];
  const cwd = typeof candidate.cwd === "string" ? candidate.cwd.trim() : "";
  const env: Record<string, string> = {};
  if (candidate.env && typeof candidate.env === "object" && !Array.isArray(candidate.env)) {
    for (const [name, item] of Object.entries(candidate.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof item === "string") env[name] = item;
    }
  }
  return { args, cwd, env };
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
  if (value) current[configurationId] = normalizeOverride(value) ?? { args: [], cwd: "", env: {} };
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

export function applyRunConfigurationOverride(
  configuration: ExecutionRunConfiguration,
  override: RunConfigurationOverride | undefined,
): ExecutionRunConfiguration {
  if (!override) return configuration;
  const args = [...configuration.command.args, ...override.args];
  const executable = configuration.command.executable;
  return {
    ...configuration,
    command: {
      ...configuration.command,
      args,
      cwd: override.cwd || configuration.command.cwd,
      env: { ...configuration.command.env, ...override.env },
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
  args.args = override.args;
  if (override.cwd) args.cwd = override.cwd;
  args.env = { ...(typeof args.env === "object" && args.env ? args.env : {}), ...override.env };
  launchConfig.arguments = args;
  if (override.cwd) launchConfig.adapterCwd = override.cwd;
  return { ...configuration, launchConfig };
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
