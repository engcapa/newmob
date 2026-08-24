import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  BUILT_IN_SCHEME_ID,
  defaultCodeStyleSchemeStore,
  normalizeCodeStyleSchemeStore,
  setActiveCodeStyleScheme,
  type CodeStyleSchemeStoreState,
} from "./workspaceCodeStyleSchemes";
import { CodeStyleSettingsDialog } from "./CodeStyleSettingsDialog";

afterEach(() => cleanup());

/** Parent harness that applies onChange results like the real workspace does. */
function LiveDialog(props: {
  initial: CodeStyleSchemeStoreState;
  activeLanguageId: string | null;
  provenance: Parameters<typeof CodeStyleSettingsDialog>[0]["provenance"];
  onChange?: (next: CodeStyleSchemeStoreState) => void;
}) {
  const [store, setStore] = useState(props.initial);
  return (
    <CodeStyleSettingsDialog
      open={true}
      store={store}
      activeLanguageId={props.activeLanguageId}
      provenance={props.provenance}
      onChange={(next) => {
        setStore(next);
        props.onChange?.(next);
      }}
      onClose={vi.fn()}
    />
  );
}

const PROVENANCE = {
  filePath: "app / src / Main.java",
  effectiveLabel: "Spaces: 4 (Scheme)",
  source: "scheme" as const,
  schemeName: "Java Scheme",
};

describe("§8.19.9 R8-D1 Code Style settings dialog", () => {
  it("lists schemes, marks the built-in, and copies into a selected editable scheme", () => {
    const onChange = vi.fn();
    const initial = normalizeCodeStyleSchemeStore({
      schemes: [{ id: "s1", name: "Java Scheme", values: { tabSize: { value: 6 } } }],
    });
    render(
      <LiveDialog initial={initial} activeLanguageId="java" provenance={PROVENANCE} onChange={onChange} />,
    );

    expect(screen.getByTestId("code-style-scheme-row-default")).toBeTruthy();
    expect(screen.getByTestId("code-style-scheme-row-s1")).toBeTruthy();
    expect(screen.getByText("built-in")).toBeTruthy();
    // Provenance panel surfaces the effective resolution + winning layer.
    expect(screen.getByTestId("code-style-provenance-label").textContent).toBe("Spaces: 4 (Scheme)");
    expect(screen.getByTestId("code-style-provenance-source").textContent).toBe("scheme");

    // Select the custom scheme, then copy it.
    fireEvent.click(screen.getByTestId("code-style-scheme-row-s1"));
    fireEvent.click(screen.getByTestId("code-style-copy"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    const created = next.schemes.find((scheme: { id: string }) => scheme.id !== "s1" && scheme.id !== BUILT_IN_SCHEME_ID);
    expect(created.name).toBe("Java Scheme copy");
    // The dialog selects the fresh copy for immediate editing.
    const selectedRow = screen.getByTestId("code-style-scheme-list").querySelector('[aria-selected="true"]');
    expect(selectedRow?.getAttribute("data-testid")).toBe(`code-style-scheme-row-${created.id}`);
  });

  it("renames through the inline editor and reports duplicate-name errors", () => {
    const onChange = vi.fn();
    let store = normalizeCodeStyleSchemeStore({
      schemes: [{ id: "s1", name: "Alpha" }],
    });
    render(
      <CodeStyleSettingsDialog open={true} store={store} activeLanguageId={null} provenance={null} onChange={(next) => { store = next; onChange(next); }} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("code-style-scheme-row-s1"));
    fireEvent.click(screen.getByTestId("code-style-rename"));
    const input = screen.getByTestId("code-style-rename-input") as HTMLInputElement;
    expect(input.value).toBe("Alpha");
    fireEvent.change(input, { target: { value: "default" } }); // collides with built-in name
    fireEvent.click(screen.getByTestId("code-style-rename-confirm"));
    expect(screen.getByTestId("code-style-error").textContent).toContain("already exists");

    fireEvent.change(input, { target: { value: "Beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].schemes.some((scheme: { name: string }) => scheme.name === "Beta")).toBe(true);
  });

  it("deletes only customs and clears dangling per-language activations", () => {
    const onChange = vi.fn();
    const seeded = normalizeCodeStyleSchemeStore({
      schemes: [{ id: "s1", name: "Doomed" }],
      activeByLanguage: {},
    });
    const activated = setActiveCodeStyleScheme(seeded, "java", "s1");
    render(
      <CodeStyleSettingsDialog open={true} store={activated} activeLanguageId="java" provenance={null} onChange={onChange} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId("code-style-delete").hasAttribute("disabled")).toBe(true); // built-in selected initially? no — selection defaults to built-in
    void screen.queryByTestId("code-style-scheme-row-s1");

    // Select the doomed scheme, then delete.
    fireEvent.click(screen.getByTestId("code-style-scheme-row-s1"));
    expect(screen.getByTestId("code-style-delete").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByTestId("code-style-delete"));
    const next = onChange.mock.calls[0][0];
    expect(next.schemes.map((scheme: { id: string }) => scheme.id)).toEqual([BUILT_IN_SCHEME_ID]);
    expect(next.activeByLanguage).toEqual({});
  });

  it("resets a custom scheme back to an empty delta and blocks editing the built-in", () => {
    const onChange = vi.fn();
    const seeded = normalizeCodeStyleSchemeStore({
      schemes: [{ id: "s1", name: "Filled", values: { tabSize: { value: 9 }, insertSpaces: { value: false } } }],
    });
    const { rerender } = render(
      <CodeStyleSettingsDialog open={true} store={seeded} activeLanguageId={null} provenance={null} onChange={onChange} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("code-style-scheme-row-s1"));
    expect((screen.getByTestId("code-style-field-tabSize") as HTMLInputElement).value).toBe("9");
    fireEvent.click(screen.getByTestId("code-style-reset"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.schemes[1].values).toEqual({});

    // Built-in stays read-only: no field inputs rendered.
    rerender(
      <CodeStyleSettingsDialog open={true} store={defaultCodeStyleSchemeStore()} activeLanguageId={null} provenance={null} onChange={onChange} onClose={vi.fn()} />,
    );
    expect(screen.queryByTestId("code-style-field-tabSize")).toBeNull();
    expect(screen.getByTestId("code-style-rename").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("code-style-delete").hasAttribute("disabled")).toBe(true);
  });
});
