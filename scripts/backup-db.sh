#!/usr/bin/env bash
# BackupDatabase (LLD §9): pg_dump every night, keep 30 days.
#
# Runs from the host's cron, NOT from the worker: pg_dump has to read every company's rows, which the
# app's RLS-bound role cannot do (and the worker should never hold credentials that can). Example
# crontab of the deploy user (server clock in WIB; use 0 18 * * * on a UTC clock):
#
#   0 1 * * *  BACKUP_DATABASE_URL=postgres://jiat_backup@127.0.0.1/jiat BACKUP_DIR=/var/backups/jiat /opt/jiat/scripts/backup-db.sh
#
# BACKUP_DATABASE_URL: a role that can read every row (the table owner, or a role with BYPASSRLS and
#   SELECT on the schema). Put its password in ~/.pgpass (chmod 600), not in the URL: a URL with a
#   password would be visible in the process list.
# BACKUP_DIR: local folder for the dumps (created 0700).
# BACKUP_RETENTION_DAYS: default 30.
# BACKUP_RCLONE_REMOTE (optional): off-site copy with rclone, e.g. "s3:jiat-backup/db"; the same
#   retention is applied there.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL harus diisi}"
: "${BACKUP_DIR:?BACKUP_DIR harus diisi}"
retention="${BACKUP_RETENTION_DAYS:-30}"
case "$retention" in ''|*[!0-9]*) echo "BACKUP_RETENTION_DAYS harus angka" >&2; exit 2 ;; esac
if [[ "$BACKUP_DATABASE_URL" =~ ://[^/@]*:[^/@]*@ ]]; then
  echo "BACKUP_DATABASE_URL berisi password; pindahkan ke ~/.pgpass" >&2
  exit 2
fi

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$BACKUP_DIR/jiat-$stamp.dump"
partial="$BACKUP_DIR/.jiat-$stamp.dump.partial"
trap 'rm -f "$partial"' EXIT

pg_dump --format=custom --no-owner --no-privileges --dbname="$BACKUP_DATABASE_URL" --file="$partial"
pg_restore --list "$partial" >/dev/null # the archive is complete and readable
mv "$partial" "$final"
echo "backup: $final ($(du -h "$final" | cut -f1))"

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'jiat-*.dump' -mtime +"$retention" -print -delete

if [[ -n "${BACKUP_RCLONE_REMOTE:-}" ]]; then
  rclone copy "$final" "$BACKUP_RCLONE_REMOTE"
  rclone delete --min-age "${retention}d" --include 'jiat-*.dump' "$BACKUP_RCLONE_REMOTE"
fi
