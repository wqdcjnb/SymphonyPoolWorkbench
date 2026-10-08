#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
export DISPLAY=:99
export XAUTHORITY="$APP_ROOT/data/desktop.Xauthority"
export WORKBENCH_DESKTOP_ROOT="$APP_ROOT/data/login-desktops"
export PYTHONPATH="$APP_ROOT/../tools${PYTHONPATH:+:$PYTHONPATH}"
export PATH="$APP_ROOT/.runtime/node/bin:$PATH"
umask 077
for required in "$XAUTHORITY"; do
  if [[ ! -s "$required" ]]; then
    echo 'Desktop credentials missing. Run deploy/ubuntu/install.sh before starting.' >&2
    exit 1
  fi
done
if [[ ! -x "$APP_ROOT/.venv/bin/python" || ! -x "$APP_ROOT/.runtime/node/bin/node" ]]; then
  echo 'Run deploy/ubuntu/install.sh first.' >&2
  exit 1
fi

children=()
cleanup() {
  trap - EXIT TERM INT
  if [[ ${#children[@]} -gt 0 ]]; then
    kill -TERM "${children[@]}" 2>/dev/null || true
    wait 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT

# Bind the display cookie to the current hostname, including after a machine rename.
if xdpyinfo >/dev/null 2>&1; then echo 'Display :99 is already running.' >&2; exit 1; fi
xauth -f "$XAUTHORITY" add "$DISPLAY" . "$(mcookie)"
Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp -noreset -auth "$XAUTHORITY" &
children+=("$!")
ready=false
for _ in {1..100}; do
  if ! kill -0 "${children[0]}" 2>/dev/null; then echo 'Xvfb failed to start; display :99 may be occupied.' >&2; exit 1; fi
  if xdpyinfo >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then echo 'Xvfb startup timed out.' >&2; exit 1; fi
openbox &
children+=("$!")
# Xpra sessions are reachable only through a validated account bearer and SSH tunnel.
"$APP_ROOT/.venv/bin/python" "$APP_ROOT/../tools/xpra_gateway.py" --root "$WORKBENCH_DESKTOP_ROOT" --port 6080 &
children+=("$!")
cd "$APP_ROOT"
"$APP_ROOT/.runtime/node/bin/node" --disable-warning=ExperimentalWarning server.mjs &
children+=("$!")

# A failed component restarts the whole display and application together under systemd.
wait -n "${children[@]}" || true
echo 'A desktop or workbench process exited; stopping the remaining processes.' >&2
exit 1
