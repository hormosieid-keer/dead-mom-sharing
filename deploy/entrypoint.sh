#!/usr/bin/env bash
set -eu
umask 077
BOT_VNC_PASSWORD="${BOT_VNC_PASSWORD:-}"
BOT_BRIDGE_TOKEN="${BOT_BRIDGE_TOKEN:-}"
if [ "${#BOT_VNC_PASSWORD}" -lt 8 ]; then
  echo "BOT_VNC_PASSWORD must contain at least eight characters" >&2
  exit 1
fi
if [ "${#BOT_BRIDGE_TOKEN}" -lt 32 ]; then
  echo "BOT_BRIDGE_TOKEN must contain at least 32 random characters" >&2
  exit 1
fi
# Private temporary password file; noVNC is reachable only through a host SSH tunnel.
password_file="$(mktemp /tmp/douyin-vnc.XXXXXX)"
x11vnc -storepasswd "$BOT_VNC_PASSWORD" "$password_file" >/dev/null 2>&1
cleanup() {
  trap - EXIT TERM INT
  for child in ${runner_pid:-} ${web_pid:-} ${vnc_pid:-} ${wm_pid:-} ${x_pid:-}; do
    kill "$child" 2>/dev/null || true
  done
  wait || true
  rm -f "$password_file"
}
trap cleanup EXIT TERM INT
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp &
x_pid=$!
for attempt in $(seq 1 40); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 0.25
done
xdpyinfo -display :99 >/dev/null 2>&1
openbox >/dev/null 2>&1 &
wm_pid=$!
x11vnc -display :99 -localhost -rfbport 5900 -rfbauth "$password_file" -forever -shared -quiet >/dev/null 2>&1 &
vnc_pid=$!
websockify --web=/usr/share/novnc/ 0.0.0.0:6080 127.0.0.1:5900 >/dev/null 2>&1 &
web_pid=$!
python -m runner.server &
runner_pid=$!
# Stop the whole container if Chromium or a remote-access component fails.
set +e
wait -n "$runner_pid" "$web_pid" "$vnc_pid" "$wm_pid" "$x_pid"
status=$?
exit "$status"
