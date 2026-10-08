#!/usr/bin/env bash
set -euo pipefail
umask 077
root=/data/symphony/v2/backups
mkdir -p "$root"
backup="$root/postgres-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose --env-file /data/symphony/v2.env -f /data/symphony/current-v2/symphony-pool-workbench/deploy/cloud/compose.v2.yml exec -T postgres pg_dump -U symphony -d symphony -Fc > "$backup.tmp"
test -s "$backup.tmp"
mv "$backup.tmp" "$backup"
docker compose --env-file /data/symphony/v2.env -f /data/symphony/current-v2/symphony-pool-workbench/deploy/cloud/compose.v2.yml exec -T postgres pg_restore --list < "$backup" > /dev/null
# This directory belongs to this backup job; keep 14 days of completed dumps.
find "$root" -maxdepth 1 -type f -name 'postgres-*.dump' -mtime +14 -delete
echo "Database backup verified: $backup"
