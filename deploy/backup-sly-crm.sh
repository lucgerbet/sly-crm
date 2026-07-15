#!/bin/bash
# Daily consistent backup of the SLY CRM SQLite DB (Hostinger VPS).
# Installed at /root/backup-sly-crm.sh, run by cron daily.
set -e
DB="/var/lib/docker/volumes/sly-crm_sly_crm_data/_data/sly_crm.db"
DEST="/root/backups"
mkdir -p "$DEST"
TS=$(date +%F_%H%M)
sqlite3 "$DB" ".backup '$DEST/sly-crm-$TS.db'"
gzip -f "$DEST/sly-crm-$TS.db"
find "$DEST" -name 'sly-crm-*.db.gz' -mtime +30 -delete
echo "$(date) backup OK -> sly-crm-$TS.db.gz"
