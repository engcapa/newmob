"""jdtls_required: probe for the versioned jdtls fixture used by the
§8.19.10 provider-mode editor cases (TC-IDE-C2-01 / TC-IDE-C6-02).

The probe checks that a JDK launcher is resolvable on PATH. The full
fixture matrix (maven-single / maven-multi-module / gradle-single /
gradle-multi-module under src/components/editor/workspace/__fixtures__/jdtls)
is provisioned by the R3 native runner; this browser/native gate only needs
to know whether ANY Java provider run is possible. Missing JDK raises
FixtureSkip so the case reports environment-blocked — never a stub pass.
"""

from __future__ import annotations

import shutil
from typing import Any


def setup(ctx: Any) -> None:
    missing = [name for name in ("java",) if shutil.which(name) is None]
    if missing:
        from . import FixtureSkip

        raise FixtureSkip(
            f"jdtls fixture prerequisites missing on PATH: {', '.join(missing)}. "
            "Provision a JDK 21 (and the __fixtures__/jdtls projects for the "
            "native runner) — qa-ui-auto does not auto-fallback to stubs."
        )
