/**
 * alert-dedup.ts
 *
 * Deduplication layer for Slack notifications.
 *
 * Prevents the same court slot from triggering repeated alerts within a
 * configurable cooldown window (default: 1 hour).  After the cooldown
 * expires the slot is eligible for re-notification — useful when a slot
 * remains available across multiple polling cycles.
 *
 * The state is persisted to a JSON file so it survives process restarts
 * (important for cron-based execution).
 */

import fs from "node:fs";
import path from "node:path";
import type { CourtSlot } from "./slot-parser.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default cooldown period in milliseconds (1 hour) */
export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/** Path to the dedup state file */
const STATE_FILE = path.resolve(process.cwd(), ".alert-dedup-state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Internal record of a previously sent alert */
interface AlertRecord {
  /** ISO-8601 timestamp of when the alert was last sent */
  sentAt: string;
  /** Unix epoch ms — for fast numeric comparison */
  sentAtMs: number;
}

/**
 * Serialised dedup state (written to / read from disk).
 * Keys are slot fingerprints, values are AlertRecords.
 */
type DedupState = Record<string, AlertRecord>;

// ---------------------------------------------------------------------------
// Slot key generation
// ---------------------------------------------------------------------------

/**
 * Generates a unique, deterministic key for a court slot.
 *
 * Format: `{courtCode}|{date}|{time}`
 *   e.g.  `s06|2026-04-05|18:00~20:00`
 *
 * This uniquely identifies a reservable time-slot on a specific court and date.
 */
export function slotKey(slot: CourtSlot): string {
  return `${slot.courtCode}|${slot.date}|${slot.time}`;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

/**
 * Loads the dedup state from disk.
 * Returns an empty object if the file does not exist or is corrupt.
 */
export function loadState(filePath: string = STATE_FILE): DedupState {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logger.warn("[AlertDedup] State file has unexpected format, resetting");
      return {};
    }
    return parsed as DedupState;
  } catch (err) {
    logger.warn(
      `[AlertDedup] Failed to load state file (${filePath}), starting fresh:`,
      err instanceof Error ? err.message : err
    );
    return {};
  }
}

/**
 * Saves the dedup state to disk.
 */
export function saveState(
  state: DedupState,
  filePath: string = STATE_FILE
): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    logger.error(
      "[AlertDedup] Failed to save state file:",
      err instanceof Error ? err.message : err
    );
  }
}

// ---------------------------------------------------------------------------
// Core dedup logic
// ---------------------------------------------------------------------------

/**
 * Filters a list of available court slots, removing those that were already
 * notified within the cooldown window.
 *
 * Also performs housekeeping — prunes entries older than 24 hours to prevent
 * the state file from growing indefinitely.
 *
 * @param slots         Available CourtSlot[] to consider for notification
 * @param cooldownMs    Suppression window in ms (default: 1 hour)
 * @param stateFilePath Optional override for the state file path (for testing)
 * @returns             Only the slots that should trigger a new notification
 */
export function filterNewAlerts(
  slots: CourtSlot[],
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
  stateFilePath: string = STATE_FILE
): CourtSlot[] {
  const now = Date.now();
  const state = loadState(stateFilePath);

  // Housekeeping: prune entries older than 24 hours
  const PRUNE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
  for (const key of Object.keys(state)) {
    if (now - state[key].sentAtMs > PRUNE_THRESHOLD_MS) {
      delete state[key];
    }
  }

  const newSlots: CourtSlot[] = [];

  for (const slot of slots) {
    const key = slotKey(slot);
    const record = state[key];

    if (!record) {
      // Never alerted — include
      newSlots.push(slot);
    } else {
      const elapsed = now - record.sentAtMs;
      if (elapsed >= cooldownMs) {
        // Cooldown expired — re-send
        newSlots.push(slot);
      } else {
        // Still within cooldown — suppress
        const remainingMin = Math.ceil((cooldownMs - elapsed) / 60_000);
        logger.info(
          `[AlertDedup] Suppressed: ${key} (cooldown: ${remainingMin}m remaining)`
        );
      }
    }
  }

  // Save state (pruned but NOT yet marking new slots — that happens after send)
  saveState(state, stateFilePath);

  return newSlots;
}

/**
 * Marks the given slots as "alerted" in the dedup state.
 * Call this AFTER successfully sending the Slack notification.
 *
 * @param slots         Slots that were just notified
 * @param stateFilePath Optional override for the state file path (for testing)
 */
export function markAsSent(
  slots: CourtSlot[],
  stateFilePath: string = STATE_FILE
): void {
  const now = new Date();
  const state = loadState(stateFilePath);

  for (const slot of slots) {
    const key = slotKey(slot);
    state[key] = {
      sentAt: now.toISOString(),
      sentAtMs: now.getTime(),
    };
  }

  saveState(state, stateFilePath);

  if (slots.length > 0) {
    logger.info(
      `[AlertDedup] Marked ${slots.length} slot(s) as sent at ${now.toISOString()}`
    );
  }
}

/**
 * Clears the entire dedup state. Useful for testing or manual reset.
 */
export function clearState(stateFilePath: string = STATE_FILE): void {
  saveState({}, stateFilePath);
  logger.info("[AlertDedup] State cleared");
}

/**
 * Returns a summary of the current dedup state for debugging.
 */
export function getStateSummary(stateFilePath: string = STATE_FILE): {
  totalEntries: number;
  activeCooldowns: number;
  expiredEntries: number;
} {
  const now = Date.now();
  const state = loadState(stateFilePath);
  const entries = Object.values(state);

  let activeCooldowns = 0;
  let expiredEntries = 0;

  for (const entry of entries) {
    if (now - entry.sentAtMs < DEFAULT_COOLDOWN_MS) {
      activeCooldowns++;
    } else {
      expiredEntries++;
    }
  }

  return {
    totalEntries: entries.length,
    activeCooldowns,
    expiredEntries,
  };
}
