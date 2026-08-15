import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBuildRunToolsDialog } from "./WorkspaceBuildRunToolsDialog";

describe("WorkspaceBuildRunToolsDialog", () => {
  afterEach(cleanup);
  it("saves Maven JVM options and project argLine inheritance", () => {
    const onSave = vi.fn();
    render(
      <WorkspaceBuildRunToolsDialog
        config={{
          tools: {},
          mavenRun: { jvmArgs: [], inheritProjectJvmArgs: true },
        }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Maven Run JVM options"), {
      target: {
        value: [
          " --add-opens=java.base/sun.nio.ch=ALL-UNNAMED ",
          "",
          "--enable-native-access=ALL-UNNAMED",
        ].join("\n"),
      },
    });
    fireEvent.click(screen.getByTestId("workspace-maven-inherit-argline"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({
      tools: {},
      mavenRun: {
        jvmArgs: [
          "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED",
          "--enable-native-access=ALL-UNNAMED",
        ],
        inheritProjectJvmArgs: false,
      },
      stepFilters: {
        enabled: true,
        patterns: [
          "java.*",
          "javax.*",
          "sun.*",
          "com.sun.*",
          "jdk.*",
          "org.gradle.*",
          "org.apache.maven.*",
        ],
        skipSynthetics: true,
        skipStaticInitializers: false,
        skipConstructors: false,
      },
    });
  });

  it("configures custom step filters and flags", () => {
    const onSave = vi.fn();
    render(
      <WorkspaceBuildRunToolsDialog
        config={{
          tools: {},
          mavenRun: { jvmArgs: [], inheritProjectJvmArgs: true },
          stepFilters: {
            enabled: true,
            patterns: ["com.mycompany.*"],
            skipSynthetics: false,
            skipStaticInitializers: true,
            skipConstructors: true,
          },
        }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId("workspace-debug-step-filter-patterns"), {
      target: { value: "com.mycompany.internal.*\norg.test.*" },
    });
    fireEvent.click(screen.getByTestId("workspace-debug-skip-synthetics"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      stepFilters: {
        enabled: true,
        patterns: ["com.mycompany.internal.*", "org.test.*"],
        skipSynthetics: true,
        skipStaticInitializers: true,
        skipConstructors: true,
      },
    }));
  });
});
