#!/usr/bin/env bash
# BackupDatabase (LLD §9): pg_dump every night, keep 30 days.
#
# Runs from the host's cron, NOT from the worker: pg_dump has to read every company's rows, which the
# app's RLS-bound role cannot do (and the worker should never hold credentials that can). Example
# crontab of the deploy user (server clock in WIB; use 0 18 * * * on a UTC clock):
#
#   0 1 * * *  BACKUP_DATABASE_URL=postgres://jiat_backup@127.0.0.1/jiat BACKUP_DIR=/var/backups/jiat /opt/jiat/scripts/backup-db.sh
#
# BACKUP_DATABASE_URL: a role with BYPASSRLS that can read every table (README "Backup": jiat_backup,
#   BYPASSRLS + pg_read_all_data). Not the table owner: every tenant table has FORCE ROW LEVEL
#   SECURITY, so even the owner sees no rows — checked before dumping. Its password goes in
#   ~/.pgpass (chmod 600), never in the URL: a password in the URL would be visible in the process
#   list and the crontab, so any form of it is refused.
# BACKUP_DIR: local folder for the dumps (created 0700).
# BACKUP_RETENTION_DAYS: default 30.
# BACKUP_RCLONE_REMOTE (optional): off-site copy with rclone, e.g. "s3:jiat-backup/db"; the same
#   retention is applied there. The dump holds every company's bank accounts, NPWP and password
#   hashes, so it only leaves the server encrypted:
#     BACKUP_GPG_RECIPIENT  key id / e-mail of a gpg PUBLIC key on this host (its private key kept
#                           offline); the copy is <dump>.gpg, or
#     BACKUP_REMOTE_ENCRYPTED=1  the remote is an rclone "crypt" remote that encrypts by itself.
#   Neither set → refused before dumping.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL harus diisi}"
: "${BACKUP_DIR:?BACKUP_DIR harus diisi}"
retention="${BACKUP_RETENTION_DAYS:-30}"
case "$retention" in ''|*[!0-9]*) echo "BACKUP_RETENTION_DAYS harus angka" >&2; exit 2 ;; esac
# user:pass@host, ?password=… or keyword form "password=…": all put the secret in argv and the crontab
if [[ "$BACKUP_DATABASE_URL" =~ ://[^/@]*:[^/@]*@ ]] || [[ "${BACKUP_DATABASE_URL,,}" == *password* ]]; then
  echo "BACKUP_DATABASE_URL berisi password; pindahkan ke ~/.pgpass" >&2
  exit 2
fi
remote="${BACKUP_RCLONE_REMOTE:-}"
recipient="${BACKUP_GPG_RECIPIENT:-}"
if [[ -n "$remote" && -z "$recipient" && "${BACKUP_REMOTE_ENCRYPTED:-0}" != "1" ]]; then
  echo "BACKUP_RCLONE_REMOTE tanpa enkripsi: isi BACKUP_GPG_RECIPIENT (kunci publik gpg) atau BACKUP_REMOTE_ENCRYPTED=1 (remote rclone crypt)" >&2
  exit 2
fi
if [[ -n "$recipient" ]] && ! gpg --batch --list-keys -- "$recipient" >/dev/null 2>&1; then
  echo "BACKUP_GPG_RECIPIENT: kunci publik \"$recipient\" tidak ada di keyring gpg" >&2
  exit 2
fi

# the role must see every row: under FORCE RLS a role without BYPASSRLS dumps nothing (or fails)
can_read_all="$(psql --no-psqlrc --dbname="$BACKUP_DATABASE_URL" -tAc "SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user")"
if [[ "$can_read_all" != "t" ]]; then
  echo "peran BACKUP_DATABASE_URL tidak punya BYPASSRLS: dump akan gagal atau kosong (lihat README \"Backup\")" >&2
  exit 2
fi

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$BACKUP_DIR/jiat-$stamp.dump"
partial="$BACKUP_DIR/.jiat-$stamp.dump.partial"
sealed="$final.gpg"
trap 'rm -f "$partial" "$sealed"' EXIT

# sessions, sign-in verifications and Telegram link codes are short-lived secrets nobody restores
pg_dump --format=custom --no-owner --no-privileges \
  --exclude-table-data=sessions --exclude-table-data=verifications --exclude-table-data=telegram_link_codes \
  --dbname="$BACKUP_DATABASE_URL" --file="$partial"
pg_restore --list "$partial" >/dev/null # the archive is complete and readable
mv "$partial" "$final"
echo "backup: $final ($(du -h "$final" | cut -f1))"

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'jiat-*.dump' -mtime +"$retention" -print -delete

if [[ -n "$remote" ]]; then
  if [[ -n "$recipient" ]]; then
    gpg --batch --yes --trust-model always --recipient "$recipient" --output "$sealed" --encrypt "$final"
    rclone copy "$sealed" "$remote"
  else
    rclone copy "$final" "$remote"
  fi
  rclone delete --min-age "${retention}d" --include 'jiat-*.dump' --include 'jiat-*.dump.gpg' "$remote"
fi
