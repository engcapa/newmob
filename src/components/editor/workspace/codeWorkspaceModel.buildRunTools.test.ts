import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS,
  normalizeWorkspaceBuildRunTools,
  readWorkspaceBuildRunTools,
  workspaceToolConfig,
  workspaceToolExecutables,
  writeWorkspaceBuildRunTools,
} from "./codeWorkspaceModel";

afterEach(() => {
  window.localStorage.clear();
});

describe("workspace build/run tool persistence", () => {
  it("defaults to automatic tool discovery", () => {
    expect(readWorkspaceBuildRunTools("workspace-a")).toEqual({
      tools: {},
      mavenRun: { jvmArgs: [], inheritProjectJvmArgs: true },
      stepFilters: DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS,
    });
  });

  it("isolates executable overrides by workspace", () => {
    writeWorkspaceBuildRunTools("workspace-a", {
      tools: { maven: { executable: " C:\\Tools\\mvn.cmd " } },
      mavenRun: { jvmArgs: [], inheritProjectJvmArgs: true },
    });
    expect(readWorkspaceBuildRunTools("workspace-a")).toEqual({
      tools: { maven: { executable: "C:\\Tools\\mvn.cmd" } },
      mavenRun: { jvmArgs: [], inheritProjectJvmArgs: true },
      stepFilters: DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS,
    });
    expect(readWorkspaceBuildRunTools("workspace-b")).toEqual({
      tools: {},
      mavenRun: { jvmArgs: [], inheritProjectJvmArgs: true },
      stepFilters: DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS,
    });
  });

  it("keeps generic tool ids and drops malformed entries", () => {
    expect(normalizeWorkspaceBuildRunTools({
      tools: {
        gradle: { executable: "gradle" },
        cargo: { executable: "/opt/rust/bin/cargo" },
        broken: { executable: 42 },
      },
    })).toEqual({
      tools: {
        gradle: { executable: "gradle" },
        cargo: { executable: "/opt/rust/bin/cargo" },
      },
      mavenRun: { jvmArgs: [], inheritProjectJvmArgs: true },
      stepFilters: DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS,
    });
  });

  it("normalizes Maven Run JVM options and flattens the backend config", () => {
    const normalized = normalizeWorkspaceBuildRunTools({
      tools: { maven: { executable: "mvn-custom" } },
      mavenRun: {
        jvmArgs: [" --add-opens=java.base/sun.nio.ch=ALL-UNNAMED ", 42, ""],
        inheritProjectJvmArgs: false,
      },
    });
    expect(normalized).toEqual({
      tools: { maven: { executable: "mvn-custom" } },
      mavenRun: {
        jvmArgs: ["--add-opens=java.base/sun.nio.ch=ALL-UNNAMED"],
        inheritProjectJvmArgs: false,
      },
      stepFilters: DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS,
    });
    expect(workspaceToolConfig(normalized)).toEqual({
      maven: "mvn-custom",
      mavenJvmArgs: ["--add-opens=java.base/sun.nio.ch=ALL-UNNAMED"],
      inheritMavenArgLine: false,
    });
  });

  it("recovers from corrupt JSON and flattens executable overrides", () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.buildRunTools.v1.workspace-a",
      "{broken",
    );
    expect(readWorkspaceBuildRunTools("workspace-a")).toEqual({
      tools: {},
      mavenRun: { jvmArgs: [], inheritProjectJvmArgs: true },
      stepFilters: DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS,
    });
    expect(workspaceToolExecutables({
      tools: {
        maven: { executable: "mvn-custom" },
        gradle: { executable: "gradle-custom" },
      },
      mavenRun: { jvmArgs: [], inheritProjectJvmArgs: true },
    })).toEqual({ maven: "mvn-custom", gradle: "gradle-custom" });
  });

  it("omits the default backend config so automatic argLine inheritance still applies", () => {
    expect(workspaceToolConfig({
      tools: {},
      mavenRun: { jvmArgs: [], inheritProjectJvmArgs: true },
    })).toBeUndefined();
  });
});
