import { describe, it, expect } from "vitest";
import { isEditableTarget, isTerminalFocused } from "./keyboardGuards";

describe("keyboardGuards", () => {
  describe("isEditableTarget", () => {
    it("returns false for null / non-element targets", () => {
      expect(isEditableTarget(null, null)).toBe(false);
      expect(isEditableTarget(undefined as unknown as EventTarget, null)).toBe(false);
    });

    it("returns true for HTMLInputElement", () => {
      const input = document.createElement("input");
      expect(isEditableTarget(input, null)).toBe(true);
      expect(isEditableTarget(null, input)).toBe(true);
    });

    it("returns true for HTMLTextAreaElement (standard)", () => {
      const textarea = document.createElement("textarea");
      expect(isEditableTarget(textarea, null)).toBe(true);
      expect(isEditableTarget(null, textarea)).toBe(true);
    });

    it("returns false for xterm helper textarea", () => {
      const xtermTextarea = document.createElement("textarea");
      xtermTextarea.className = "xterm-helper-textarea";
      expect(isEditableTarget(xtermTextarea, null)).toBe(false);
      expect(isEditableTarget(null, xtermTextarea)).toBe(false);
    });

    it("returns true for contenteditable elements", () => {
      const div = document.createElement("div");
      div.setAttribute("contenteditable", "true");
      expect(isEditableTarget(div, null)).toBe(true);
    });

    it("returns false for contenteditable=false elements", () => {
      const div = document.createElement("div");
      div.setAttribute("contenteditable", "false");
      expect(isEditableTarget(div, null)).toBe(false);
    });

    it("returns true for child of an input or contenteditable", () => {
      const parent = document.createElement("div");
      parent.setAttribute("contenteditable", "true");
      const span = document.createElement("span");
      parent.appendChild(span);
      expect(isEditableTarget(span, null)).toBe(true);
    });

    it("returns false for plain div / button / body", () => {
      const div = document.createElement("div");
      const button = document.createElement("button");
      expect(isEditableTarget(div, null)).toBe(false);
      expect(isEditableTarget(button, null)).toBe(false);
      expect(isEditableTarget(document.body, null)).toBe(false);
    });
  });

  describe("isTerminalFocused", () => {
    it("returns true for ambient focus (body / documentElement / root / null)", () => {
      const panel = document.createElement("div");
      expect(isTerminalFocused(panel, null)).toBe(true);
      expect(isTerminalFocused(panel, document.body)).toBe(true);
      expect(isTerminalFocused(panel, document.documentElement)).toBe(true);

      const root = document.createElement("div");
      root.id = "root";
      expect(isTerminalFocused(panel, root)).toBe(true);
    });

    it("returns true when activeElement is inside panelEl", () => {
      const panel = document.createElement("div");
      const child = document.createElement("div");
      panel.appendChild(child);
      expect(isTerminalFocused(panel, child)).toBe(true);
      expect(isTerminalFocused(panel, panel)).toBe(true);
    });

    it("returns false when activeElement is outside panelEl (e.g. in SFTP sidebar)", () => {
      const panel = document.createElement("div");
      const sftpSidebar = document.createElement("div");
      const sftpButton = document.createElement("button");
      sftpSidebar.appendChild(sftpButton);

      expect(isTerminalFocused(panel, sftpSidebar)).toBe(false);
      expect(isTerminalFocused(panel, sftpButton)).toBe(false);
    });
  });
});
