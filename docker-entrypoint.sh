#!/usr/bin/env bash
set -euo pipefail

if [ "${VNC_ENABLED:-1}" = "1" ] || [ "${EPIC_VISIBLE:-0}" = "1" ]; then
  export DISPLAY="${DISPLAY:-:1}"
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true
  Xvfb "$DISPLAY" -ac -screen 0 "${VNC_WIDTH:-1366}x${VNC_HEIGHT:-768}x24" &
  sleep 1

  x11vnc -display "$DISPLAY" -forever -shared -rfbport "${VNC_PORT:-5900}" -nopw &

  websockify -D --web=/usr/share/novnc/ "${NOVNC_PORT:-6080}" "localhost:${VNC_PORT:-5900}"
  echo "Visible browser VNC (WebUI embedded): http://<host>:${PORT:-5308}/novnc/vnc.html"
fi

FONT_DIR="${WINDOWS_FONT_DIR:-/usr/share/fonts/truetype/windows}"
if find "$FONT_DIR" -maxdepth 1 -type f \( -iname '*.ttf' -o -iname '*.ttc' -o -iname '*.otf' \) 2>/dev/null | grep -q .; then
  fc-cache -f >/dev/null 2>&1 || true
  echo "Windows fonts detected in $FONT_DIR"
else
  echo "Windows fonts not found in $FONT_DIR; using bundled fallback fonts"
fi

exec "$@"
