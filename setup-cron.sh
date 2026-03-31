#!/usr/bin/env bash
#
# setup-cron.sh — Install/update the cron job for the tennis court scraper.
# Safely merges with existing crontab entries (won't duplicate).
#
# Usage:
#   ./setup-cron.sh          # Install the cron job
#   ./setup-cron.sh --remove # Remove the cron job
#

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT="$PROJECT_DIR/run.sh"
LOG_DIR="$PROJECT_DIR/logs"
CRON_MARKER="# songpa-tennis-scraper"
CRON_ENTRY="*/5 * * * * $RUN_SCRIPT >> $LOG_DIR/cron.log 2>&1 $CRON_MARKER"
CLEANUP_ENTRY="0 3 * * * find $LOG_DIR -name \"*.log\" -mtime +7 -delete 2>/dev/null $CRON_MARKER-cleanup"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

remove_existing() {
  crontab -l 2>/dev/null | grep -v "$CRON_MARKER" || true
}

if [ "${1:-}" = "--remove" ]; then
  log "Removing tennis scraper cron jobs..."
  remove_existing | crontab -
  log "Done. Current crontab:"
  crontab -l 2>/dev/null || echo "(empty)"
  exit 0
fi

# ── Pre-flight checks ──────────────────────────────────────────
log "Running pre-flight checks..."

# Check run.sh exists and is executable
if [ ! -x "$RUN_SCRIPT" ]; then
  log "Making run.sh executable..."
  chmod +x "$RUN_SCRIPT"
fi

# Ensure logs directory exists
mkdir -p "$LOG_DIR"

# Check node is available
if ! command -v node &>/dev/null; then
  log "WARNING: node not found in current shell. run.sh will try to source nvm/homebrew."
fi

# Check .env exists
if [ ! -f "$PROJECT_DIR/.env" ]; then
  log "ERROR: .env file not found. Copy .env.example and fill in your credentials:"
  log "  cp $PROJECT_DIR/.env.example $PROJECT_DIR/.env"
  exit 1
fi

# Check node_modules
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  log "Installing npm dependencies..."
  cd "$PROJECT_DIR" && npm install
fi

# Check Playwright browsers
if ! npx playwright install --dry-run chromium &>/dev/null 2>&1; then
  log "Installing Playwright Chromium browser..."
  npx playwright install chromium
fi

# ── macOS: Grant cron Full Disk Access reminder ────────────────
if [[ "$(uname)" == "Darwin" ]]; then
  echo ""
  echo "=========================================================="
  echo "  macOS IMPORTANT: cron needs permissions to run properly."
  echo ""
  echo "  If the scraper fails from cron but works manually, grant"
  echo "  Full Disk Access to /usr/sbin/cron:"
  echo ""
  echo "  System Settings > Privacy & Security > Full Disk Access"
  echo "  > Click '+' > /usr/sbin/cron"
  echo "=========================================================="
  echo ""
fi

# ── Install cron job ───────────────────────────────────────────
log "Installing cron job (every 5 minutes)..."

# Remove old entries, then append new ones
{
  remove_existing
  echo "$CRON_ENTRY"
  echo "$CLEANUP_ENTRY"
} | crontab -

log "Cron job installed successfully."
log ""
log "Current crontab:"
crontab -l
log ""
log "Useful commands:"
log "  View logs:      tail -f $LOG_DIR/cron.log"
log "  View daily log: tail -f $LOG_DIR/scraper-\$(date +%Y-%m-%d).log"
log "  Test manually:  $RUN_SCRIPT"
log "  Remove cron:    $0 --remove"
log "  Check crontab:  crontab -l"
