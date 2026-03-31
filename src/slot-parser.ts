/**
 * slot-parser.ts
 *
 * Parses tennis court reservation pages from spc.esongpa.or.kr
 * and identifies slots with status "예약가능" (available for reservation).
 *
 * The site uses a monthly calendar view per facility.  Each day cell
 * links to a daily detail page that lists time‑slots in a table.
 * Statuses observed on the site:
 *   - "예약가능"  → available (this is what we want)
 *   - "예약마감"  → fully booked
 *   - "예약불가"  → not available / blocked
 *   - "대기예약"  → waitlist
 *   - "예약대기"  → waitlist (alternate label)
 *   - "접수마감"  → registration closed
 *
 * This module exports helpers that work with a Playwright Page object.
 */

import type { Page } from "playwright";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Represents a single reservable time‑slot on a court. */
export interface CourtSlot {
  /** Court identifier, e.g. "s06" */
  courtCode: string;
  /** Human‑readable court name, e.g. "성내천 테니스장" */
  courtName: string;
  /** Date string YYYY-MM-DD */
  date: string;
  /** Time range string, e.g. "18:00~20:00" */
  time: string;
  /** Raw status text from the page */
  status: string;
  /** Whether the slot is available for booking */
  available: boolean;
  /** Direct reservation URL (if available) */
  reservationUrl?: string;
}

/** Court metadata used for scraping */
export interface CourtInfo {
  code: string; // e.g. "s06"
  name: string; // e.g. "성내천 테니스장"
  calendarPath?: string; // URL path, e.g. "/page/rent/s06.od.list.php"
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The exact status string that indicates an available slot */
export const STATUS_AVAILABLE = "예약가능";

/** All status strings we recognise (for validation / logging) */
export const KNOWN_STATUSES = [
  "예약가능",
  "예약마감",
  "예약불가",
  "대기예약",
  "예약대기",
  "접수마감",
  "접수대기",
  "신청",
  "마감",
] as const;

/** Target courts (excludes 오륜 which is under construction) */
export const TARGET_COURTS: CourtInfo[] = [
  { code: "s06", name: "성내천 테니스장", calendarPath: "/page/rent/s06.od.list.php" },
  { code: "s05", name: "송파 테니스장", calendarPath: "/page/rent/s05.od.list.php" },
  { code: "s03", name: "오금공원 테니스장", calendarPath: "/page/rent/s03.od.list.php" },
];

/** Base URL */
export const BASE_URL = "https://spc.esongpa.or.kr";

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether a raw status text indicates the slot is available.
 *
 * The function normalises whitespace and checks for the canonical
 * "예약가능" string.  It is intentionally strict to avoid false positives.
 */
export function isSlotAvailable(rawStatus: string): boolean {
  const normalised = rawStatus.trim().replace(/\s+/g, "");
  return normalised === STATUS_AVAILABLE;
}

/**
 * Checks whether a status string is one we recognise.
 * Useful for logging unexpected values that might indicate a site change.
 */
export function isKnownStatus(rawStatus: string): boolean {
  const normalised = rawStatus.trim().replace(/\s+/g, "");
  return (KNOWN_STATUSES as readonly string[]).includes(normalised);
}

// ---------------------------------------------------------------------------
// Page‑level parsing — Daily detail page
// ---------------------------------------------------------------------------

/**
 * Parses the daily reservation detail page and extracts all time‑slots
 * with their availability status.
 *
 * The daily page URL pattern:
 *   /fmcs/{facilityId}?selected_date=YYYY-MM-DD
 *
 * The page contains a table (or list) of time‑slots.  Each row typically has:
 *   - Time range (e.g. "06:00~08:00")
 *   - Status text or button (e.g. "예약가능", "예약마감")
 *
 * We use multiple selector strategies to be resilient to minor DOM changes.
 */
export async function parseDailySlots(
  page: Page,
  court: CourtInfo,
  date: string
): Promise<CourtSlot[]> {
  const slots: CourtSlot[] = [];

  // Strategy 1: Look for a reservation table with rows
  const tableSlots = await parseFromTable(page, court, date);
  if (tableSlots.length > 0) {
    return tableSlots;
  }

  // Strategy 2: Look for list-based layout (some Korean sports sites use <ul>/<dl>)
  const listSlots = await parseFromList(page, court, date);
  if (listSlots.length > 0) {
    return listSlots;
  }

  // Strategy 3: Generic — find any element containing "예약가능" text
  const genericSlots = await parseGeneric(page, court, date);
  if (genericSlots.length > 0) {
    return genericSlots;
  }

  return slots;
}

/**
 * Strategy 1: Parse from HTML table rows.
 *
 * Typical DOM structure on esongpa.or.kr:
 *   <table class="tb_type_list" or similar>
 *     <tr>
 *       <td>06:00~08:00</td>
 *       <td>테니스</td>
 *       <td><span class="state">예약가능</span></td>  -- or a button/link
 *     </tr>
 */
async function parseFromTable(
  page: Page,
  court: CourtInfo,
  date: string
): Promise<CourtSlot[]> {
  const slots: CourtSlot[] = [];

  // Try multiple table selectors
  const tableSelectors = [
    "table.tb_type_list tbody tr",
    "table.tbl_type tbody tr",
    "table.tbl_list tbody tr",
    "table.table tbody tr",
    ".rent_list table tbody tr",
    ".reservation_list table tbody tr",
    "#contents table tbody tr",
    "table tbody tr",
  ];

  for (const selector of tableSelectors) {
    const rows = await page.$$(selector);
    if (rows.length === 0) continue;

    for (const row of rows) {
      const cells = await row.$$("td");
      if (cells.length < 2) continue;

      // Extract all text from the row
      const rowText = await row.innerText().catch(() => "");

      // Find time pattern (HH:MM~HH:MM or HH:MM-HH:MM or HH:MM ~ HH:MM)
      const timeMatch = rowText.match(
        /(\d{1,2}:\d{2})\s*[~\-]\s*(\d{1,2}:\d{2})/
      );
      if (!timeMatch) continue;

      const time = `${timeMatch[1]}~${timeMatch[2]}`;

      // Find status text — look for known status patterns
      const statusText = await extractStatusFromElement(row);

      if (statusText) {
        slots.push({
          courtCode: court.code,
          courtName: court.name,
          date,
          time,
          status: statusText,
          available: isSlotAvailable(statusText),
          reservationUrl: `${BASE_URL}${court.calendarPath ?? `/page/rent/${court.code}.od.list.php`}`,
        });
      }
    }

    // If we found slots with this selector, don't try others
    if (slots.length > 0) break;
  }

  return slots;
}

/**
 * Strategy 2: Parse from list‑based layouts (<ul>, <dl>, <div> lists).
 */
async function parseFromList(
  page: Page,
  court: CourtInfo,
  date: string
): Promise<CourtSlot[]> {
  const slots: CourtSlot[] = [];

  const listSelectors = [
    ".rent_list li",
    ".reservation_item",
    ".time_list li",
    ".schedule_list li",
    "dl.time_info",
  ];

  for (const selector of listSelectors) {
    const items = await page.$$(selector);
    if (items.length === 0) continue;

    for (const item of items) {
      const text = await item.innerText().catch(() => "");

      const timeMatch = text.match(
        /(\d{1,2}:\d{2})\s*[~\-]\s*(\d{1,2}:\d{2})/
      );
      if (!timeMatch) continue;

      const time = `${timeMatch[1]}~${timeMatch[2]}`;
      const statusText = await extractStatusFromElement(item);

      if (statusText) {
        slots.push({
          courtCode: court.code,
          courtName: court.name,
          date,
          time,
          status: statusText,
          available: isSlotAvailable(statusText),
          reservationUrl: `${BASE_URL}${court.calendarPath ?? `/page/rent/${court.code}.od.list.php`}`,
        });
      }
    }

    if (slots.length > 0) break;
  }

  return slots;
}

/**
 * Strategy 3: Generic text‑based extraction.
 * Scans the whole page for elements matching status keywords near time patterns.
 */
async function parseGeneric(
  page: Page,
  court: CourtInfo,
  date: string
): Promise<CourtSlot[]> {
  const slots: CourtSlot[] = [];

  // Use page.evaluate for a comprehensive DOM scan
  const rawSlots = await page
    .evaluate(() => {
      const results: Array<{ time: string; status: string }> = [];

      // Find all elements that contain known status text
      const statusKeywords = [
        "예약가능",
        "예약마감",
        "예약불가",
        "대기예약",
        "예약대기",
        "접수마감",
        "접수대기",
        "신청",
        "마감",
      ];

      // Walk all elements looking for status keywords
      const allElements = Array.from(document.querySelectorAll("*"));
      for (const el of allElements) {
        // Only consider leaf-ish text nodes (avoid containers that contain other status elements)
        if (el.children.length > 5) continue;

        const text = el.textContent?.trim() ?? "";
        const hasStatus = statusKeywords.some((kw) => text.includes(kw));
        if (!hasStatus) continue;

        // Look for time pattern in the same element or its parent/ancestor row
        let contextEl: Element | null = el;
        let timeText = "";
        // Walk up to find a container with time info (max 5 levels)
        for (let i = 0; i < 5 && contextEl; i++) {
          const ct = contextEl.textContent ?? "";
          const tm = ct.match(
            /(\d{1,2}:\d{2})\s*[~\-]\s*(\d{1,2}:\d{2})/
          );
          if (tm) {
            timeText = `${tm[1]}~${tm[2]}`;
            break;
          }
          contextEl = contextEl.parentElement;
        }

        if (timeText) {
          // Extract just the status keyword
          const matchedStatus = statusKeywords.find((kw) =>
            text.includes(kw)
          );
          if (matchedStatus) {
            // Avoid duplicates
            const exists = results.some(
              (r) => r.time === timeText && r.status === matchedStatus
            );
            if (!exists) {
              results.push({ time: timeText, status: matchedStatus });
            }
          }
        }
      }

      return results;
    })
    .catch(() => [] as Array<{ time: string; status: string }>);

  for (const raw of rawSlots) {
    slots.push({
      courtCode: court.code,
      courtName: court.name,
      date,
      time: raw.time,
      status: raw.status,
      available: isSlotAvailable(raw.status),
      reservationUrl: `${BASE_URL}${court.calendarPath ?? `/page/rent/${court.code}.od.list.php`}`,
    });
  }

  return slots;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the status text from an element by looking at buttons, spans,
 * links, and class‑based indicators.
 */
async function extractStatusFromElement(
  element: import("playwright").ElementHandle
): Promise<string | null> {
  // Priority 1: Look for status in buttons or links (reservation action elements)
  const statusSelectors = [
    "button",
    "a.btn",
    "a.state",
    "span.state",
    "span.status",
    ".state",
    ".status",
    ".btn_state",
    "em",
    "strong",
  ];

  for (const sel of statusSelectors) {
    const statusEl = await element.$(sel);
    if (statusEl) {
      const text = await statusEl.innerText().catch(() => "");
      const trimmed = text.trim().replace(/\s+/g, "");
      if (trimmed && isKnownStatusLike(trimmed)) {
        return trimmed;
      }
    }
  }

  // Priority 2: Check for status via class names on the row/element itself
  const className = await element
    .getAttribute("class")
    .catch(() => "");
  if (className) {
    if (className.includes("possible") || className.includes("available")) {
      return STATUS_AVAILABLE;
    }
    // Don't return for "impossible" etc — let text take priority
  }

  // Priority 3: Scan all text in the row for a status keyword
  const fullText = await element.innerText().catch(() => "");
  const statusMatch = fullText.match(
    /(예약가능|예약마감|예약불가|대기예약|예약대기|접수마감|접수대기|신청|마감)/
  );
  if (statusMatch) {
    return statusMatch[1];
  }

  return null;
}

/**
 * Loose check: does the text look like it could be a status value?
 */
function isKnownStatusLike(text: string): boolean {
  const statusPatterns = [
    "예약가능",
    "예약마감",
    "예약불가",
    "대기예약",
    "예약대기",
    "접수마감",
    "접수대기",
    "신청",
    "마감",
    "가능",
    "불가",
  ];
  return statusPatterns.some((p) => text.includes(p));
}

// ---------------------------------------------------------------------------
// High‑level: filter only available slots
// ---------------------------------------------------------------------------

/**
 * Given a list of parsed CourtSlots, returns only those that are available.
 * This is the main function other modules should call after parsing.
 */
export function filterAvailableSlots(slots: CourtSlot[]): CourtSlot[] {
  return slots.filter((slot) => slot.available);
}

/**
 * Logs a summary of parsed slots for debugging.
 */
export function logSlotSummary(slots: CourtSlot[]): void {
  const available = slots.filter((s) => s.available);
  const unavailable = slots.filter((s) => !s.available);

  logger.info(`[SlotParser] Total slots parsed: ${slots.length}`);
  logger.info(`[SlotParser] Available (예약가능): ${available.length}`);
  logger.info(`[SlotParser] Unavailable: ${unavailable.length}`);

  // Log any unrecognised statuses (might indicate site changes)
  const unknown = slots.filter((s) => !isKnownStatus(s.status));
  if (unknown.length > 0) {
    logger.warn(
      `[SlotParser] WARNING: ${unknown.length} slot(s) with unrecognised status:`
    );
    for (const s of unknown) {
      logger.warn(`  - "${s.status}" at ${s.courtName} ${s.date} ${s.time}`);
    }
  }

  if (available.length > 0) {
    logger.info("[SlotParser] Available slots:");
    for (const s of available) {
      logger.info(`  ✅ ${s.courtName} | ${s.date} | ${s.time}`);
    }
  }
}
