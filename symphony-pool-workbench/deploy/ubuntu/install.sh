#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# shellcheck source=/dev/null
source /etc/os-release
if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 24.04 ]]; then
  echo 'This installer requires Ubuntu 24.04 LTS.' >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64; BROWSER_CHANNEL=chrome ;;
  aarch64|arm64) NODE_ARCH=arm64; BROWSER_CHANNEL=chromium ;;
  *) echo 'Unsupported CPU architecture. Expected x86_64 or aarch64.' >&2; exit 1 ;;
esac
NODE_VERSION=24.21.0
printf 'Detected Ubuntu %s, CPU %s, browser %s, Node.js %s\n' "$VERSION_ID" "$NODE_ARCH" "$BROWSER_CHANNEL" "$NODE_VERSION"
if [[ "${1:-}" == --check ]]; then exit 0; fi
if [[ $# -gt 0 ]]; then echo 'Usage: bash install.sh [--check]' >&2; exit 1; fi
if [[ $EUID -eq 0 ]]; then
  echo 'Run as a normal user with sudo access, not root. See ../README.md.' >&2
  exit 1
fi
if [[ ! -w "$APP_ROOT" ]]; then echo 'The current user must own the extracted project directory.' >&2; exit 1; fi
case "$APP_ROOT" in *$'\n'*|*'%'*|*'"'*|*'\'*) echo 'Unsupported characters in installation path.' >&2; exit 1 ;; esac
umask 077
sudo -v
sudo apt-get update
sudo apt-get install -y --no-install-recommends curl ca-certificates xz-utils python3 python3-venv \
  xvfb xauth x11-utils openbox xdotool dbus-user-session fonts-noto-cjk
XPRA_VERSION=6.5.4-r0-1
curl --fail --location --retry 3 https://xpra.org/xpra.asc | sudo tee /usr/share/keyrings/xpra.asc >/dev/null
printf 'Types: deb\nURIs: https://xpra.org/\nSuites: noble\nComponents: main\nSigned-By: /usr/share/keyrings/xpra.asc\n' | sudo tee /etc/apt/sources.list.d/xpra.sources >/dev/null
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  "xpra-server=$XPRA_VERSION" "xpra-x11=$XPRA_VERSION" "xpra-codecs=$XPRA_VERSION" \
  python3-gi-cairo python3-dbus dbus-x11 x11-xkb-utils libx264-164
sudo install -d -m 1777 -o root -g root /tmp/.X11-unix

RUNTIME="$APP_ROOT/.runtime"
mkdir -p "$RUNTIME" "$APP_ROOT/data"
NODE_DIRECTORY="$RUNTIME/node-v$NODE_VERSION-linux-$NODE_ARCH"
if [[ ! -x "$NODE_DIRECTORY/bin/node" ]]; then
  DOWNLOAD="$(mktemp -d)"
  trap 'rm -rf -- "$DOWNLOAD"' EXIT
  ARCHIVE="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  curl --fail --location --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/$ARCHIVE" -o "$DOWNLOAD/$ARCHIVE"
  curl --fail --location --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$DOWNLOAD/SHASUMS256.txt"
  (cd "$DOWNLOAD"; grep -F "  $ARCHIVE" SHASUMS256.txt | sha256sum --check --strict -)
  tar -xJf "$DOWNLOAD/$ARCHIVE" -C "$RUNTIME"
fi
if [[ -e "$RUNTIME/node" && ! -L "$RUNTIME/node" ]]; then
  echo '.runtime/node must be a symlink managed by this installer.' >&2
  exit 1
fi
ln -sfn "$NODE_DIRECTORY" "$RUNTIME/node"

python3 -m venv "$APP_ROOT/.venv"
"$APP_ROOT/.venv/bin/python" -m pip install -r "$APP_ROOT/requirements.txt"
sudo "$APP_ROOT/.venv/bin/python" -m playwright install-deps chromium
if [[ "$BROWSER_CHANNEL" == chrome ]]; then
  if ! command -v google-chrome >/dev/null && ! command -v google-chrome-stable >/dev/null; then
    sudo "$APP_ROOT/.venv/bin/python" -m playwright install chrome
  fi
else
  "$APP_ROOT/.venv/bin/python" -m playwright install chromium
fi

if [[ ! -f "$APP_ROOT/.env" ]]; then cp "$APP_ROOT/.env.example" "$APP_ROOT/.env"; fi
python3 - "$APP_ROOT" "$BROWSER_CHANNEL" <<'PY'
from pathlib import Path
import re
import sys
app, channel = Path(sys.argv[1]), sys.argv[2]
env = app / '.env'
text = env.read_text(encoding='utf-8-sig')
pattern = r'(?m)^WORKBENCH_BROWSER_CHANNEL=[ \t]*(?:""|\x27\x27)?[ \t]*$'
if re.search(pattern, text):
    text = re.sub(pattern, 'WORKBENCH_BROWSER_CHANNEL='+channel, text)
elif not re.search(r'(?m)^WORKBENCH_BROWSER_CHANNEL=', text):
    text = text.rstrip()+'\nWORKBENCH_BROWSER_CHANNEL='+channel+'\n'
env.write_text(text, encoding='utf-8', newline='\n')
unit_dir = Path.home() / '.config/systemd/user'
unit_dir.mkdir(parents=True, exist_ok=True)
unit = (app/'deploy/ubuntu/symphony-workbench.service').read_text(encoding='utf-8')
(unit_dir/'symphony-workbench.service').write_text(unit.replace('@@APP_ROOT@@', str(app)), encoding='utf-8', newline='\n')
PY
chmod 600 "$APP_ROOT/.env"
if [[ ! -s "$APP_ROOT/data/desktop.Xauthority" ]]; then
  touch "$APP_ROOT/data/desktop.Xauthority"
  xauth -f "$APP_ROOT/data/desktop.Xauthority" add :99 . "$(mcookie)"
fi
chmod 600 "$APP_ROOT/data/desktop.Xauthority"
printf '\nInstallation prepared. Install the Xpra native client on your Windows computer.\n'
printf '\nThen start the service:\n  systemctl --user daemon-reload\n  systemctl --user enable --now symphony-workbench.service\n  sudo loginctl enable-linger "%s"\n' "$(id -un)"
echo 'See ../README.md for access, API configuration, and acceptance checks.'
