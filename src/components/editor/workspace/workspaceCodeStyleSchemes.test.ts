import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_SCHEME_ID,
  activeSchemeForLanguage,
  copyCodeStyleScheme,
  defaultCodeStyleSchemeStore,
  deleteCodeStyleScheme,
  normalizeCodeStyleSchemeStore,
  readCodeStyleSchemeStore,
  renameCodeStyleScheme,
  resetCodeStyleSchemeValues,
  schemeStyleFields,
  setActiveCodeStyleScheme,
  writeCodeStyleSchemeStore,
} from "./workspaceCodeStyleSchemes";

afterEach(() => {
  window.localStorage.clear();
});

describe("§8.19.9 R8-D1 code style scheme store", () => {
  it("always materializes the built-in default, even for corrupt payloads", () => {
    for (const garbage of [null, "x", 42, { schemes: "nope" }, { schemes: [{ id: "default", name: "Fake" }] }]) {
      const store = normalizeCodeStyleSchemeStore(garbage);
      expect(store.schemes).toHaveLength(1);
      expect(store.schemes[0].id).toBe(BUILT_IN_SCHEME_ID);
      expect(store.schemes[0].name).toBe("Default");
    }
    // Corrupt entries are dropped; valid ones survive with typed values only.
    const store = normalizeCodeStyleSchemeStore({
      schemes: [
        { id: "s1", name: "Java", languageId: "java", values: { tabSize: { value: 6, source: "scheme" }, evilKey: { value: 1 } } },
        { name: "no-id" },
        { id: "s2", name: "" },
      ],
      activeByLanguage: { java: "s1", go: "ghost" },
    });
    expect(store.schemes.map((scheme) => scheme.id)).toEqual([BUILT_IN_SCHEME_ID, "s1"]);
    expect(store.schemes[1].values.evilKey).toBeUndefined();
    expect(store.activeByLanguage).toEqual({ java: "s1" });
  });

  it("round-trips through localStorage and drops the built-in from disk", () => {
    const base = normalizeCodeStyleSchemeStore({
      schemes: [{ id: "s1", name: "Mine" }],
      activeByLanguage: { shared: "s1" },
    });
    writeCodeStyleSchemeStore(base);
    const raw = JSON.parse(window.localStorage.getItem("taomni.codeWorkspace.codeStyle.schemes.v1")!);
    expect(raw.schemes.map((scheme: { id: string }) => scheme.id)).toEqual(["s1"]);
    expect(readCodeStyleSchemeStore()).toEqual(base);
  });

  it("copies with unique names, refuses duplicates, and records basedOn", () => {
    let store = defaultCodeStyleSchemeStore();
    const first = copyCodeStyleScheme(store, BUILT_IN_SCHEME_ID, "My Style");
    if ("error" in first) throw new Error("first copy should succeed");
    store = first.state;
    expect(first.scheme.basedOn).toBe(BUILT_IN_SCHEME_ID);
    expect(store.schemes.some((scheme) => scheme.name === "My Style")).toBe(true);

    expect(copyCodeStyleScheme(store, BUILT_IN_SCHEME_ID, "my style")).toEqual({ error: "duplicate-name" });
    expect(copyCodeStyleScheme(store, BUILT_IN_SCHEME_ID, "   ")).toEqual({ error: "empty-name" });
    expect(copyCodeStyleScheme(store, "ghost", "X")).toEqual({ error: "unknown-scheme" });
  });

  it("renames customs only, deletes with active-reference cleanup, resets to empty delta", () => {
    const copied = copyCodeStyleScheme(defaultCodeStyleSchemeStore(), BUILT_IN_SCHEME_ID, "Temp");
    if ("error" in copied) throw new Error("seed copy should succeed");
    let store = copied.state;
    const id = copied.scheme.id;

    expect(renameCodeStyleScheme(store, BUILT_IN_SCHEME_ID, "X")).toEqual({ error: "built-in-immutable" });
    const renamed = renameCodeStyleScheme(store, id, "Renamed");
    if ("error" in renamed) throw new Error("rename should succeed");
    store = renamed;
    expect(activeSchemeForLanguage(store, null).id).toBe(BUILT_IN_SCHEME_ID);

    // Activate per language, then verify delete clears dangling references.
    store = setActiveCodeStyleScheme(store, "java", id);
    store = setActiveCodeStyleScheme(store, "shared", BUILT_IN_SCHEME_ID);
    expect(store.activeByLanguage).toEqual({ java: id });
    const deleted = deleteCodeStyleScheme(store, id);
    if ("error" in deleted) throw new Error("delete should succeed");
    store = deleted;
    expect(store.activeByLanguage).toEqual({});
    expect(deleteCodeStyleScheme(store, BUILT_IN_SCHEME_ID)).toEqual({ error: "built-in-immutable" });

    // Reset strips every field back to an empty delta.
    const filled = normalizeCodeStyleSchemeStore({
      schemes: [{ id: "s9", name: "F", values: { tabSize: { value: 8 }, insertSpaces: { value: false } } }],
    });
    const reset = resetCodeStyleSchemeValues(filled, "s9");
    if ("error" in reset) throw new Error("reset should succeed");
    expect(reset.schemes[1]?.values).toEqual({});
  });

  it("resolves the active scheme exact → shared → default", () => {
    let store = defaultCodeStyleSchemeStore();
    const copied = copyCodeStyleScheme(store, BUILT_IN_SCHEME_ID, "Java Scheme");
    if ("error" in copied) throw new Error("seed copy should succeed");
    store = copied.state;
    store = setActiveCodeStyleScheme(store, "java", copied.scheme.id);

    expect(activeSchemeForLanguage(store, "java").name).toBe("Java Scheme");
    expect(activeSchemeForLanguage(store, "py").name).toBe("Default");
    const withShared = setActiveCodeStyleScheme(store, "shared", copied.scheme.id);
    expect(activeSchemeForLanguage(withShared, "py").name).toBe("Java Scheme");
  });

  it("extracts typed scheme fields and ignores junk", () => {
    const store = normalizeCodeStyleSchemeStore({
      schemes: [{
        id: "s",
        name: "T",
        values: {
          tabSize: { value: 6 },
          indentSize: { value: 6 },
          insertSpaces: { value: false },
          endOfLine: { value: "crlf" },
          trimTrailingWhitespace: { value: true },
          continuationIndent: { value: -3 },
          insertFinalNewline: { value: "yes" },
        },
      }],
    });
    const fields = schemeStyleFields(store.schemes[1]);
    expect(fields).toEqual({
      tabSize: 6,
      indentSize: 6,
      insertSpaces: false,
      endOfLine: "crlf",
      trimTrailingWhitespace: true,
    });
  });
});
