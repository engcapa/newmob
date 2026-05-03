#!/usr/bin/env bash
set -u
BIN="src-tauri/target/debug/newmob"

if [ ! -x "$BIN" ]; then
  echo "ERROR: $BIN not found. Build first with: pnpm tauri build --debug --no-bundle" >&2
  exit 1
fi

# Prefer Replit's pre-existing X server (display :1, socket /tmp/.X11-unix/X1)
if [ -S /tmp/.X11-unix/X1 ]; then
  export DISPLAY=:1
elif [ -S /tmp/.X11-unix/X0 ]; then
  export DISPLAY=:0
else
  echo "ERROR: no X11 socket found in /tmp/.X11-unix/" >&2
  exit 1
fi

echo "Using DISPLAY=$DISPLAY"
echo "Launching $BIN"
exec "$BIN"
