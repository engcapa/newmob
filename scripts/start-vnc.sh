#!/usr/bin/env bash
set -u

BIN="src-tauri/target/debug/newmob"
DISPLAY_NUM=0
RFB_PORT=5901       # raw RFB (Xvnc, localhost only)
WS_PORT=5900        # WebSocket port that Replit's Tools->VNC connects to (wss)
GEOMETRY="${VNC_GEOMETRY:-1280x800}"

if [ ! -x "$BIN" ]; then
  echo "ERROR: $BIN not found. Build first with: pnpm tauri build --debug --no-bundle" >&2
  exit 1
fi

cleanup() {
  echo "Shutting down VNC stack..."
  [ -n "${WS_PID:-}"   ] && kill "$WS_PID"   2>/dev/null || true
  [ -n "${WM_PID:-}"   ] && kill "$WM_PID"   2>/dev/null || true
  [ -n "${APP_PID:-}"  ] && kill "$APP_PID"  2>/dev/null || true
  [ -n "${XVNC_PID:-}" ] && kill "$XVNC_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Clean stale lock/socket for display :0
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true

# Start Xvnc on :0 listening on 5901 (raw RFB), localhost only.
Xvnc ":${DISPLAY_NUM}" \
  -geometry "$GEOMETRY" \
  -depth 24 \
  -SecurityTypes None \
  -rfbport "$RFB_PORT" \
  -localhost=1 \
  -AlwaysShared \
  -AcceptKeyEvents \
  -AcceptPointerEvents &
XVNC_PID=$!

export DISPLAY=":${DISPLAY_NUM}"

# Wait for X server.
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && break
  sleep 0.3
done
if [ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
  echo "ERROR: Xvnc failed to create /tmp/.X11-unix/X${DISPLAY_NUM}" >&2
  exit 1
fi

# websockify bridges wss (5900, what Replit's VNC tool talks) -> raw RFB (5901).
# Workflow PATH is minimal, so resolve websockify via PATH or nix-store fallback.
WEBSOCKIFY="$(command -v websockify 2>/dev/null || true)"
if [ -z "$WEBSOCKIFY" ]; then
  WEBSOCKIFY="$(ls -1 /nix/store/*python*websockify*/bin/websockify 2>/dev/null | head -n1 || true)"
fi
if [ -z "$WEBSOCKIFY" ]; then
  echo "ERROR: websockify not found in PATH or /nix/store" >&2
  exit 1
fi
echo "Using websockify: $WEBSOCKIFY"
"$WEBSOCKIFY" --heartbeat=30 "0.0.0.0:${WS_PORT}" "127.0.0.1:${RFB_PORT}" &
WS_PID=$!

# Lightweight WM so windows can be moved/resized.
if command -v fluxbox >/dev/null 2>&1; then
  fluxbox >/dev/null 2>&1 &
  WM_PID=$!
fi

echo "Xvnc on :${DISPLAY_NUM} RFB=${RFB_PORT} (localhost) | websockify wss=${WS_PORT}"
echo "Launching $BIN"
"$BIN" &
APP_PID=$!

WAIT_PIDS=("$XVNC_PID" "$WS_PID" "$APP_PID")
[ -n "${WM_PID:-}" ] && WAIT_PIDS+=("$WM_PID")
wait -n "${WAIT_PIDS[@]}"
EXIT_CODE=$?
echo "A child exited with code $EXIT_CODE; shutting down."
exit "$EXIT_CODE"
