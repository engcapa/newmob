import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceBuildRunToolsDialog } from "./WorkspaceBuildRunToolsDialog";

describe("WorkspaceBuildRunToolsDialog", () => {
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
    });
  });
});
