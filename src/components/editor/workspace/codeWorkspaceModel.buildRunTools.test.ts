import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeWorkspaceBuildRunTools,
  readWorkspaceBuildRunTools,
  workspaceToolExecutables,
  writeWorkspaceBuildRunTools,
} from "./codeWorkspaceModel";

afterEach(() => {
  window.localStorage.clear();
});

describe("workspace build/run tool persistence", () => {
  it("defaults to automatic tool discovery", () => {
    expect(readWorkspaceBuildRunTools("workspace-a")).toEqual({ tools: {} });
  });

  it("isolates executable overrides by workspace", () => {
    writeWorkspaceBuildRunTools("workspace-a", {
      tools: { maven: { executable: " C:\\Tools\\mvn.cmd " } },
    });
    expect(readWorkspaceBuildRunTools("workspace-a")).toEqual({
      tools: { maven: { executable: "C:\\Tools\\mvn.cmd" } },
    });
    expect(readWorkspaceBuildRunTools("workspace-b")).toEqual({ tools: {} });
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
    });
  });

  it("recovers from corrupt JSON and flattens backend overrides", () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.buildRunTools.v1.workspace-a",
      "{broken",
    );
    expect(readWorkspaceBuildRunTools("workspace-a")).toEqual({ tools: {} });
    expect(workspaceToolExecutables({
      tools: {
        maven: { executable: "mvn-custom" },
        gradle: { executable: "gradle-custom" },
      },
    })).toEqual({ maven: "mvn-custom", gradle: "gradle-custom" });
  });
});
