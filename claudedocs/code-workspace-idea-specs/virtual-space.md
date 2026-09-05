# Virtual Space Specification

Shared contracts: [`shared-contracts.md`](./shared-contracts.md). IDEA-aligned virtual space keeps a desired visual column beyond short line ends, respects wrapped display geometry, composes with selection and multiple carets, and never steals IME/AltGr/dead-key input.

## Capability Design

Workspace ActionHost is the sole command owner. CodeMirror keymaps route action ids and do not implement a second movement algorithm. The controller uses CodeMirror display line blocks, viewport geometry, measured line height, tab size, and grapheme-aware columns. Padding is inserted only when an edit requires materializing virtual space and belongs to that edit's single undo transaction.

<a id="ed-vspace-001"></a>
## ED-VSPACE-001 Single Virtual-Space Action Owner

- **User outcome:** menu, palette, and keyboard movement behave identically and dispatch once to the focused editor.
- **Audit:** `implemented`. Production ActionHost/keymap routing is wired and focused tests pass, but the repository build gate is red.
- **Contract:** focused owner receives one dispatch; non-owner and composing input receive zero; all entries share one action definition.
- **Acceptance:** `ED-VSPACE-001-A1` menu/palette/keymap resolve one definition; `A2` one keystroke dispatches once; `A3` non-owner focus dispatches zero.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-vspace-002"></a>
## ED-VSPACE-002 Display-Geometry Page Movement

- **User outcome:** Page Up/Down lands by visible blocks under wrapping, resizing, tabs, and wide graphemes.
- **Audit:** `implemented`. The controller consumes CodeMirror line blocks and viewport geometry; focused tests pass, but the repository build gate is red.
- **Contract:** no fixed line-count fallback. If geometry is not ready, return typed unavailable and let the default editor handler run.
- **Acceptance:** `ED-VSPACE-002-A1` wrapped/resize movement follows visual blocks; `A2` tab size and wide graphemes preserve desired visual column; `A3` top/bottom and virtual bottom are bounded.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-vspace-003"></a>
## ED-VSPACE-003 Multi-Caret, Selection, Composition, And Undo

- **User outcome:** each caret has an independent desired column; Shift extends selection; editing virtual columns inserts padding once; composition remains intact.
- **Audit:** `implemented`. Production/unit paths cover multi-caret and composition guards, but the declared browser behavior case and Linux IME evidence were not delivered.
- **Contract:** selection anchor is stable; padding and typed text are one transaction; composition, AltGr, and dead keys bypass workspace movement dispatch.
- **Acceptance:** `ED-VSPACE-003-A1` mixed short/long multi-carets retain independent columns; `A2` Shift movement extends/reverses correctly; `A3` one undo removes padding and edit; `A4` browser and packaged Linux IME paths show zero accidental dispatch.
- **Required evidence:** `code-audit`, `unit`, `browser`, `native`, `accessibility`, `typecheck`.
- **References:** historical `BB4`, `BB10`; IDEA [Editor basics](https://www.jetbrains.com/help/idea/using-code-editor.html).
