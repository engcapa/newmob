#!/bin/bash
set -e

# Install JS deps in case the merged task added/changed packages.
pnpm install --prefer-offline

# Type-check so a merge that breaks types fails fast.
pnpm exec tsc -b --noEmit
