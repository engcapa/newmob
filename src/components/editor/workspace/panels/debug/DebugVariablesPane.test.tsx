import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugVariablesPane } from "./DebugVariablesPane";
import type { VarNode } from "./debugPanelShared";

describe("DebugVariablesPane", () => {
  afterEach(cleanup);

  it("renders variables and watches and handles editing", () => {
    const onExpandVariable = vi.fn();
    const onStartEdit = vi.fn();
    const onEditChange = vi.fn();
    const onEditSubmit = vi.fn();
    const onEditCancel = vi.fn();
    const onAddWatch = vi.fn();
    const onRemoveWatch = vi.fn();
    const onWatchInputChange = vi.fn();

    const variables: VarNode[] = [
      {
        name: "count",
        value: "42",
        type: "int",
        variablesReference: 0,
        parentRef: 1,
        dataBreakpointExpression: false,
        children: null,
        expanded: false,
      },
    ];

    const watchNodes: VarNode[] = [
      {
        name: "count > 10",
        value: "true",
        type: "boolean",
        variablesReference: 0,
        parentRef: 0,
        dataBreakpointExpression: true,
        children: null,
        expanded: false,
      },
    ];

    render(
      <DebugVariablesPane
        variables={variables}
        watchNodes={watchNodes}
        watchInput="newExpr"
        onWatchInputChange={onWatchInputChange}
        onAddWatch={onAddWatch}
        onRemoveWatch={onRemoveWatch}
        edit={{ node: null, value: "" }}
        onEditChange={onEditChange}
        onEditSubmit={onEditSubmit}
        onEditCancel={onEditCancel}
        onStartEdit={onStartEdit}
        onExpandVariable={onExpandVariable}
        onExpandWatch={vi.fn()}
        onVariableContextMenu={vi.fn()}
        stopped={true}
        canSetVariable={true}
        canAddDataBreakpoint={true}
      />,
    );

    expect(screen.getByText("count")).toBeInTheDocument();
    expect(screen.getByText("= 42")).toBeInTheDocument();
    expect(screen.getByText("count > 10")).toBeInTheDocument();
    expect(screen.getByText("= true")).toBeInTheDocument();

    // Double click to start edit
    fireEvent.doubleClick(screen.getByText("= 42"));
    expect(onStartEdit).toHaveBeenCalledWith(variables[0]);

    // Watch input
    const watchInputEl = screen.getByTestId("debug-watch-input");
    expect(watchInputEl).toHaveValue("newExpr");
    fireEvent.change(watchInputEl, { target: { value: "count * 2" } });
    expect(onWatchInputChange).toHaveBeenCalledWith("count * 2");
    fireEvent.keyDown(watchInputEl, { key: "Enter" });
    expect(onAddWatch).toHaveBeenCalledTimes(1);

    // Remove watch
    fireEvent.click(screen.getByTitle("Remove watch"));
    expect(onRemoveWatch).toHaveBeenCalledWith(0);
  });
});
