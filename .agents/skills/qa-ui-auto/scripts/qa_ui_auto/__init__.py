"""qa_ui_auto — typed YAML driven E2E runner for NewMob.

The package is invoked from the qa-ui-auto skill:

    python -m qa_ui_auto.runner [--tag smoke] [--filter TC-007] [--mode browser|native]
    python -m qa_ui_auto.lint                   # schema-check all qa-ui-auto-tests/cases/*.testcase.yaml

Design rules:

* Determinism. Steps come from the controlled verb library (`qa_ui_auto.steps`).
  Inline JS is forbidden except via the `eval_readonly` verb whose schema
  rejects assignments and DOM mutations.
* No LLM calls. AI-driven generation/diff happens in the parent Claude Code
  session that authors YAML, not inside the runner.
* Skill-friendly. Each module exports a small public surface usable as a
  subprocess. Output format is stable JSON/Markdown for the agent to parse.
"""

from __future__ import annotations

__version__ = "0.2.0"
