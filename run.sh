#!/usr/bin/env bash
#
# run.sh — Entry point for the Songpa tennis court availability scraper.
# Designed to be called by cron every 5 minutes:
#   */5 * * * * /Users/mac-mini/dev/crawling/run.sh >> /Users/mac-mini/dev/crawling/logs/cron.log 2>&1
#

set -euo pipefail

# ── Resolve project directory (works from any cwd) ──────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
LOG_DIR="$PROJECT_DIR/logs"

# ── Ensure log directory exists ──────────────────────────────────────────────
mkdir -p "$LOG_DIR"

# ── Log file (daily rotation by filename) ────────────────────────────────────
LOG_FILE="$LOG_DIR/scraper-$(date +%Y-%m-%d).log"

# ── Rotate cron.log if it exceeds 5MB ───────────────────────────────────────
CRON_LOG="$LOG_DIR/cron.log"
CRON_LOG_MAX_BYTES=5242880  # 5MB
if [ -f "$CRON_LOG" ]; then
  CRON_LOG_SIZE=$(stat -f%z "$CRON_LOG" 2>/dev/null || stat -c%s "$CRON_LOG" 2>/dev/null || echo 0)
  if [ "$CRON_LOG_SIZE" -gt "$CRON_LOG_MAX_BYTES" ]; then
    # Keep last 3 rotated copies
    [ -f "${CRON_LOG}.2" ] && rm -f "${CRON_LOG}.2"
    [ -f "${CRON_LOG}.1" ] && mv "${CRON_LOG}.1" "${CRON_LOG}.2"
    mv "$CRON_LOG" "${CRON_LOG}.1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] cron.log rotated (was ${CRON_LOG_SIZE} bytes)" > "$CRON_LOG"
  fi
fi

# ── Logging helper ───────────────────────────────────────────────────────────
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# ── Lock file to prevent overlapping runs ────────────────────────────────────
LOCK_FILE="$PROJECT_DIR/.scraper.lock"

cleanup() {
  rm -f "$LOCK_FILE"
}

if [ -f "$LOCK_FILE" ]; then
  # Check if the process that created the lock is still running
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "SKIP: Previous run (PID $LOCK_PID) still active. Exiting."
    exit 0
  else
    log "WARN: Stale lock file found (PID $LOCK_PID). Removing."
    rm -f "$LOCK_FILE"
  fi
fi

echo $$ > "$LOCK_FILE"
trap cleanup EXIT INT TERM

# ── Ensure Node.js is available ──────────────────────────────────────────────
# Source common profile files to pick up nvm/fnm/homebrew paths in cron
for rc in "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  [ -f "$rc" ] && source "$rc" 2>/dev/null || true
done

# Also check common Node.js manager locations
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" 2>/dev/null || true

# Homebrew on Apple Silicon
if [ -f "/opt/homebrew/bin/brew" ]; then
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)" || true
fi

if ! command -v node &>/dev/null; then
  log "ERROR: node not found in PATH. Ensure Node.js is installed."
  exit 1
fi

if ! command -v npx &>/dev/null; then
  log "ERROR: npx not found in PATH."
  exit 1
fi

# ── Change to project directory ──────────────────────────────────────────────
cd "$PROJECT_DIR"

# ── Verify dependencies ─────────────────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  log "WARN: node_modules missing. Running npm install..."
  npm install >> "$LOG_FILE" 2>&1
fi

# ── Load .env if present ─────────────────────────────────────────────────────
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

# ── Run the scraper ──────────────────────────────────────────────────────────
log "START: Tennis court scraper running (PID $$)"

if npx tsx src/index.ts >> "$LOG_FILE" 2>&1; then
  log "DONE: Scraper completed successfully."
else
  EXIT_CODE=$?
  log "ERROR: Scraper exited with code $EXIT_CODE."
  exit $EXIT_CODE
fi
