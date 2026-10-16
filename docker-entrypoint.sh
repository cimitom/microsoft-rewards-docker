#!/usr/bin/env bash
set -euo pipefail

if [ "${EPIC_VISIBLE:-0}" = "1" ]; then
  export DISPLAY="${DISPLAY:-:1}"
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true
  Xvfb "$DISPLAY" -ac -screen 0 "${VNC_WIDTH:-1366}x${VNC_HEIGHT:-768}x24" &
  sleep 1

  if [ -n "${NOVNC_PASSWORD:-}" ]; then
    x11vnc -display "$DISPLAY" -forever -shared -rfbport "${VNC_PORT:-5900}" -bg -passwd "$NOVNC_PASSWORD"
  else
    x11vnc -display "$DISPLAY" -forever -shared -rfbport "${VNC_PORT:-5900}" -bg -nopw
  fi

  websockify -D --web=/usr/share/novnc/ "${NOVNC_PORT:-6080}" "localhost:${VNC_PORT:-5900}"
  echo "Epic visible browser: http://<host>:${NOVNC_PORT:-6080}/vnc.html"
fi

exec "$@"
