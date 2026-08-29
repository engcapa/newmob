import { describe, expect, it, vi } from "vitest";
import {
  RenderedDocWidget,
  buildRenderedDocDecorations,
} from "./renderedDocCommentsExtension";
import { extractDocComments } from "./renderedDocCommentsModel";

describe("ED-DOC-001: renderedDocCommentsExtension", () => {
  it("creates RenderedDocWidget and renders safe DOM tree", () => {
    const code = `/**
 * Test function description.
 * @param val The value
 */`;
    const [doc] = extractDocComments(code, "typescript");
    expect(doc).toBeDefined();

    const onToggleRaw = vi.fn();
    const widget = new RenderedDocWidget(doc, onToggleRaw);
    const dom = widget.toDOM();

    expect(dom.className).toBe("cm-rendered-doc-comment");
    expect(dom.querySelector(".cm-rendered-doc-title")?.textContent).toBe("Documentation");
    expect(dom.querySelector(".cm-rendered-doc-body")?.innerHTML).toContain("Test function description.");

    // Toggle button invocation
    const btn = dom.querySelector<HTMLButtonElement>(".cm-rendered-doc-toggle-btn");
    expect(btn).not.toBeNull();
    btn?.click();
    expect(onToggleRaw).toHaveBeenCalledTimes(1);
  });

  it("builds decoration sets when enabled on supported languages", () => {
    const code = `/** Hello doc */\nfunction foo() {}`;
    const enabledDecos = buildRenderedDocDecorations(code, "typescript", true);
    expect(enabledDecos.size).toBe(1);

    const disabledDecos = buildRenderedDocDecorations(code, "typescript", false);
    expect(disabledDecos.size).toBe(0);

    const unsupportedDecos = buildRenderedDocDecorations(code, "plain", true);
    expect(unsupportedDecos.size).toBe(0);
  });
});
