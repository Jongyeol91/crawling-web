/**
 * slot-filter.ts
 *
 * Filters tennis court time slots based on the target schedule:
 *   - Weekdays (Mon–Fri): only slots starting at 18:00 or later
 *   - Weekends (Sat–Sun): all slots
 *
 * Works with both TimeSlot (from calendar-scraper) and CourtSlot (from slot-parser)
 * by normalising the inputs to dayOfWeek + startHour.
 */

import { WEEKDAY_MIN_HOUR } from "./config.js";
import type { TimeSlot } from "./calendar-scraper.js";
import type { CourtSlot } from "./slot-parser.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Returns true if the given day-of-week is a weekend (Saturday=6 or Sunday=0).
 */
export function isWeekend(dayOfWeek: number): boolean {
  return dayOfWeek === 0 || dayOfWeek === 6;
}

/**
 * Returns true if the given day-of-week is a weekday (Monday–Friday, 1–5).
 */
export function isWeekday(dayOfWeek: number): boolean {
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

/**
 * Extracts the start hour from a time string.
 *
 * Accepted formats:
 *   "18:00~20:00"  → 18
 *   "18:00-20:00"  → 18
 *   "18:00"        → 18
 *   "6:00~8:00"    → 6
 *
 * Returns -1 if the time string cannot be parsed.
 */
export function extractStartHour(time: string): number {
  const match = time.match(/^(\d{1,2})\s*:\s*\d{2}/);
  if (!match) return -1;
  return parseInt(match[1], 10);
}

/**
 * Determines the day-of-week (0=Sun … 6=Sat) from a YYYY-MM-DD date string.
 * Returns -1 if the date cannot be parsed.
 */
export function getDayOfWeek(dateStr: string): number {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return -1;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1; // JS months are 0-indexed
  const day = parseInt(match[3], 10);

  const date = new Date(year, month, day);
  // Verify the date is valid (e.g. Feb 30 would roll over)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return -1;
  }

  return date.getDay();
}

/**
 * Core predicate: should this slot be included based on day-of-week and start hour?
 *
 * Rules:
 *   - Weekend (Sat/Sun): include ALL slots regardless of time
 *   - Weekday (Mon–Fri): include only if startHour >= WEEKDAY_MIN_HOUR (18)
 */
export function isTargetSlot(dayOfWeek: number, startHour: number): boolean {
  if (isWeekend(dayOfWeek)) {
    return true; // all weekend slots
  }
  if (isWeekday(dayOfWeek)) {
    return startHour >= WEEKDAY_MIN_HOUR; // weekday 18:00+
  }
  return false; // invalid dayOfWeek
}

// ---------------------------------------------------------------------------
// Filter functions for the two slot types
// ---------------------------------------------------------------------------

/**
 * Filters TimeSlot[] (from calendar-scraper) to target schedule.
 * TimeSlot already has dayOfWeek and hour fields.
 */
export function filterTimeSlots(slots: TimeSlot[]): TimeSlot[] {
  return slots.filter((slot) => isTargetSlot(slot.dayOfWeek, slot.hour));
}

/**
 * Filters CourtSlot[] (from slot-parser) to target schedule.
 * CourtSlot has date (YYYY-MM-DD) and time (HH:MM~HH:MM) strings
 * so we derive dayOfWeek and startHour.
 */
export function filterCourtSlots(slots: CourtSlot[]): CourtSlot[] {
  return slots.filter((slot) => {
    const dayOfWeek = getDayOfWeek(slot.date);
    const startHour = extractStartHour(slot.time);
    if (dayOfWeek < 0 || startHour < 0) return false;
    return isTargetSlot(dayOfWeek, startHour);
  });
}

/**
 * Convenience: filter any available TimeSlots to only those matching
 * the target schedule (weekday 18:00+ and all weekend).
 * Combines availability check + time filter in one call.
 */
export function filterAvailableTargetSlots(slots: TimeSlot[]): TimeSlot[] {
  return slots.filter(
    (slot) =>
      slot.status === "예약가능" && isTargetSlot(slot.dayOfWeek, slot.hour)
  );
}

// ---------------------------------------------------------------------------
// Logging / summary
// ---------------------------------------------------------------------------

/**
 * Logs a summary of filtering results for debugging.
 */
export function logFilterSummary(
  allSlots: TimeSlot[],
  filtered: TimeSlot[]
): void {
  const weekendSlots = filtered.filter((s) => isWeekend(s.dayOfWeek));
  const weekdaySlots = filtered.filter((s) => isWeekday(s.dayOfWeek));

  logger.info(`[Filter] Input: ${allSlots.length} slots`);
  logger.info(`[Filter] After target filter: ${filtered.length} slots`);
  logger.info(
    `[Filter]   Weekend (all times): ${weekendSlots.length} slots`
  );
  logger.info(
    `[Filter]   Weekday (${WEEKDAY_MIN_HOUR}:00+): ${weekdaySlots.length} slots`
  );

  if (filtered.length > 0) {
    logger.info("[Filter] Target slots:");
    for (const s of filtered) {
      const dayLabel = isWeekend(s.dayOfWeek) ? "주말" : "평일";
      logger.info(
        `  🎾 ${s.courtName} | ${s.date} (${dayLabel}) | ${s.time} | ${s.status}`
      );
    }
  }
}
