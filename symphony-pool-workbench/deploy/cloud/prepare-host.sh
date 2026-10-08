#!/usr/bin/env bash
set -euo pipefail

# Run only on a new Ubuntu ECS host. Formatting requires both explicit arguments.
if [[ $EUID -ne 0 || $# -ne 3 || $2 != --format-empty-data-disk ]]; then
  echo 'Usage: sudo bash prepare-host.sh /dev/DATA_DISK --format-empty-data-disk EXPECTED_BYTES' >&2
  exit 1
fi
device=$(readlink -f -- "$1")
expected_bytes=$3
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]]
[[ $(dpkg --print-architecture) == amd64 ]]
[[ -b $device && $(lsblk -dn -o TYPE "$device") == disk ]]
[[ $(blockdev --getsize64 "$device") == "$expected_bytes" ]]
[[ $(lsblk -nr -o NAME "$device" | wc -l) == 1 ]]

if mountpoint -q /data; then
  [[ $(readlink -f -- "$(findmnt -n -o SOURCE /data)") == "$device" ]]
else
  [[ -z $(lsblk -dn -o MOUNTPOINTS "$device") ]]
  [[ -z $(wipefs --no-act --noheadings --output TYPE "$device") ]]
  [[ ! -e /data || -z $(ls -A /data) ]]
  mkfs.ext4 -m 1 -L symphony-data "$device"
  install -d -m 0755 /data
  cp -a /etc/fstab "/etc/fstab.before-symphony-$(date -u +%Y%m%dT%H%M%SZ)"
  data_uuid=$(blkid -s UUID -o value "$device")
  printf '\nUUID=%s /data ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2\n' "$data_uuid" >> /etc/fstab
  systemctl daemon-reload
  mount /data
fi
findmnt --verify --verbose
findmnt /data

install -d -m 0755 /data/docker /data/containerd /data/symphony
install -d -o ecs-user -g ecs-user -m 0750 /data/symphony/releases /data/symphony/incoming
install -d -m 0700 /data/symphony/backups
install -d -m 0755 /etc/docker /etc/apt/keyrings
if [[ -e /etc/docker/daemon.json ]]; then
  echo 'Existing Docker configuration found; review it before proceeding.' >&2
  exit 1
fi
cat > /etc/docker/daemon.json <<'JSON'
{
  "data-root": "/data/docker",
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "3" }
}
JSON
install -d -m 0755 /etc/systemd/system/docker.service.d /etc/systemd/system/containerd.service.d
for service in docker containerd; do
  cat > "/etc/systemd/system/$service.service.d/data-mount.conf" <<'UNIT'
[Unit]
RequiresMountsFor=/data
ConditionPathIsMountPoint=/data
UNIT
done

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl unzip
curl --fail --location --retry 3 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<'APT'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
APT
apt-get update
packages=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)
selected=()
for package in "${packages[@]}"; do
  version=$(apt-cache policy "$package" | awk '/Candidate:/ { print $2 }')
  [[ -n $version && $version != '(none)' ]]
  selected+=("$package=$version")
done
printf '%s\n' "${selected[@]}" > /data/symphony/docker-packages.txt
apt-get install -y --no-install-recommends "${selected[@]}"
systemctl stop docker.service docker.socket containerd.service
cp -a /etc/containerd/config.toml /etc/containerd/config.toml.before-symphony
containerd config default > /etc/containerd/config.toml
sed -i 's|^root = .*|root = "/data/containerd"|' /etc/containerd/config.toml
grep -Fx 'root = "/data/containerd"' /etc/containerd/config.toml
systemctl daemon-reload
systemctl enable --now containerd docker
docker info --format 'Docker={{.ServerVersion}} Root={{.DockerRootDir}} Storage={{.Driver}}'
docker compose version
df -hT / /data
