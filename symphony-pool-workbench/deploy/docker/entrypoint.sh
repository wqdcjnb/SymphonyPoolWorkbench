#!/usr/bin/env bash
set -euo pipefail
umask 077
export DISPLAY=:99 XAUTHORITY=/app/symphony-pool-workbench/data/desktop.Xauthority
export WORKBENCH_DESKTOP_ROOT=/app/symphony-pool-workbench/data/login-desktops
export PYTHONPATH="/app/tools${PYTHONPATH:+:$PYTHONPATH}"
export PARTNER_API_KEY="$(cat /run/secrets/api_key)"
export PARTNER_DOWNLOAD_SECRET="$(cat /run/secrets/download_secret)"
export PARTNER_WEBHOOK_SECRET="$(cat /run/secrets/webhook_secret)"
mkdir -p /profiles data /public-docs
touch "$XAUTHORITY"
chmod 600 "$XAUTHORITY"
xauth -f "$XAUTHORITY" add "$DISPLAY" . "$(mcookie)"
node deploy/docker/write-public-docs.mjs

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
Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp -noreset -auth "$XAUTHORITY" &
children+=("$!")
ready=false
for _ in {1..100}; do
  if ! kill -0 "${children[0]}" 2>/dev/null; then echo 'Xvfb failed.' >&2; exit 1; fi
  if xdpyinfo >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then echo 'Display startup timed out.' >&2; exit 1; fi
openbox &
children+=("$!")
# Xpra sessions remain private; only validated account tokens can reach them.
python /app/tools/xpra_gateway.py --root "$WORKBENCH_DESKTOP_ROOT" --port 6080 &
children+=("$!")
node --disable-warning=ExperimentalWarning server.mjs &
children+=("$!")
wait -n "${children[@]}" || true
echo 'A required service exited; restarting the container.' >&2
exit 1
