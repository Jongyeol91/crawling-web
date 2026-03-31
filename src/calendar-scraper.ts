/**
 * Calendar Scraper Module
 *
 * Parses monthly calendar pages for 3 tennis courts:
 *   - s06 성내천 테니스장 → /page/rent/s06.od.list.php
 *   - s05 송파 테니스장   → /page/rent/s05.od.list.php
 *   - s03 오금공원 테니스장 → /page/rent/s03.od.list.php
 *
 * The site at spc.esongpa.or.kr shows a monthly calendar where each
 * day cell (<td>) contains inline <li> elements with time slots.
 * Each <li> shows: time range + status (e.g., "08:00~10:00예약가능 (1/2)")
 * Available slots have <a> links with javascript:fn_rent_odchk1('slotId', 'date').
 *
 * This module:
 * - Navigates to each court's monthly calendar page
 * - Parses all time slots directly from the calendar cells (no day detail pages)
 * - Returns structured results for all 3 courts
 */

import type { Page } from "playwright";
import { BASE_URL, TIMEOUTS } from "./config.js";
import { COURTS, type CourtInfo } from "./courts.js";
import { logger } from "./logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TimeSlot {
  /** Court code, e.g. "s06" */
  courtCode: string;
  /** Human-readable court name, e.g. "성내천" */
  courtName: string;
  /** Date string YYYY-MM-DD */
  date: string;
  /** Time range string, e.g. "08:00~10:00" */
  time: string;
  /** Raw status text, e.g. "예약가능", "예약완료", "예약불가" */
  status: string;
  /** Whether the slot is available for booking */
  available: boolean;
  /** Available court count info, e.g. "(1/2)" */
  availableCourts: string;
  /** Reservation slot ID from fn_rent_odchk1 call */
  slotId: string;
  /** Direct link to the calendar page for this month */
  reservationUrl: string;
  /** 0=Sun, 1=Mon, ..., 6=Sat */
  dayOfWeek: number;
  /** Start hour extracted from time string */
  hour: number;
}

export interface CourtCalendarResult {
  court: CourtInfo;
  /** YYYY-MM */
  yearMonth: string;
  /** Time slots extracted from the calendar */
  slots: TimeSlot[];
  /** Error message if scraping failed */
  error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getCurrentYearMonth(): string {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
  );
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function buildCalendarUrl(court: CourtInfo, yearMonth: string): string {
  return `${BASE_URL}${court.calendarPath}?sch_sym=${yearMonth}`;
}

async function humanDelay(page: Page, min = 500, max = 1500): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min)) + min;
  await page.waitForTimeout(delay);
}

function extractHour(time: string): number {
  const match = time.match(/(\d{1,2}):\d{2}/);
  return match ? parseInt(match[1], 10) : -1;
}

// ─── Monthly Calendar Parsing ────────────────────────────────────────────────

/**
 * Scrape the monthly calendar page for a single court.
 * All time slots are parsed directly from the monthly calendar's <td> cells.
 */
export async function scrapeMonthlyCalendar(
  page: Page,
  court: CourtInfo,
  yearMonth?: string
): Promise<CourtCalendarResult> {
  const ym = yearMonth ?? getCurrentYearMonth();
  const calendarUrl = buildCalendarUrl(court, ym);

  const result: CourtCalendarResult = {
    court,
    yearMonth: ym,
    slots: [],
  };

  try {
    logger.info(
      `[Calendar] Navigating to ${court.name} (${court.code}) calendar: ${calendarUrl}`
    );

    await page.goto(calendarUrl, {
      waitUntil: "networkidle",
      timeout: TIMEOUTS.navigation,
    });

    await humanDelay(page);

    // Wait for the calendar table to load
    await page
      .waitForSelector("table", { timeout: TIMEOUTS.element })
      .catch(() => {
        logger.debug(`[Calendar] No table found on page, trying to parse anyway`);
      });

    // Parse all slots from the monthly calendar
    const [yearStr, monthStr] = ym.split("-");
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    const rawSlots = await page.evaluate(
      ({ year, month }) => {
        const results: Array<{
          day: number;
          time: string;
          status: string;
          available: boolean;
          availableCourts: string;
          slotId: string;
        }> = [];

        const tds = Array.from(document.querySelectorAll("td"));

        for (const td of tds) {
          const tdText = td.textContent?.trim() ?? "";
          if (!tdText) continue;

          // Extract day number from heading element (h5, h6) or first number
          const heading = td.querySelector("h6") || td.querySelector("h5") || td.querySelector("h4");
          let dayNum: number | null = null;

          if (heading) {
            const hText = heading.textContent?.trim().replace(/[^\d]/g, "") ?? "";
            if (hText) dayNum = parseInt(hText, 10);
          }

          if (!dayNum) {
            // Fallback: try first text content
            const firstText = td.childNodes[0]?.textContent?.trim() ?? "";
            const numMatch = firstText.match(/^(\d{1,2})/);
            if (numMatch) dayNum = parseInt(numMatch[1], 10);
          }

          if (!dayNum || dayNum < 1 || dayNum > 31) continue;

          // Validate the date
          const testDate = new Date(year, month - 1, dayNum);
          if (testDate.getMonth() !== month - 1) continue;

          // Parse time slots from <li> elements
          const lis = Array.from(td.querySelectorAll("li"));
          for (const li of lis) {
            const liText = li.textContent?.trim() ?? "";

            // Extract time range (e.g., "08:00~10:00")
            const timeMatch = liText.match(
              /(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})/
            );
            if (!timeMatch) continue;

            const time = `${timeMatch[1]}~${timeMatch[2]}`;

            // Determine status
            let status = "예약불가";
            let available = false;
            let availableCourts = "";
            let slotId = "";

            if (liText.includes("예약가능")) {
              status = "예약가능";
              available = true;

              // Extract court count like "(1/2)"
              const countMatch = liText.match(/\((\d+\/\d+)\)/);
              if (countMatch) availableCourts = countMatch[1];

              // Extract slotId from <a> href
              const link = li.querySelector("a");
              if (link) {
                const href = link.getAttribute("href") ?? "";
                const idMatch = href.match(/fn_rent_odchk1\s*\(\s*['"](\d+)['"]/);
                if (idMatch) slotId = idMatch[1];
              }
            } else if (liText.includes("예약완료")) {
              status = "예약완료";
            } else if (liText.includes("예약불가")) {
              status = "예약불가";
            } else if (liText.includes("인조잔디 공사") || liText.includes("휴장")) {
              status = "휴장";
            }

            results.push({
              day: dayNum,
              time,
              status,
              available,
              availableCourts,
              slotId,
            });
          }
        }

        return results;
      },
      { year, month }
    );

    // Convert raw slots to TimeSlot objects
    for (const raw of rawSlots) {
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(raw.day).padStart(2, "0")}`;
      const date = new Date(year, month - 1, raw.day);

      result.slots.push({
        courtCode: court.code,
        courtName: court.name,
        date: dateStr,
        time: raw.time,
        status: raw.status,
        available: raw.available,
        availableCourts: raw.availableCourts,
        slotId: raw.slotId,
        reservationUrl: calendarUrl,
        dayOfWeek: date.getDay(),
        hour: extractHour(raw.time),
      });
    }

    const availableCount = result.slots.filter((s) => s.available).length;
    logger.info(
      `[Calendar] ${court.name}: ${result.slots.length} slots found, ${availableCount} available`
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[Calendar] Error scraping ${court.name} calendar:`, errMsg);
    result.error = errMsg;
  }

  return result;
}

// ─── Main Entry Points ───────────────────────────────────────────────────────

/**
 * Scrape all 3 courts' monthly calendars.
 */
export async function scrapeAllCourts(
  page: Page,
  options?: {
    yearMonth?: string;
    includeNextMonth?: boolean;
  }
): Promise<CourtCalendarResult[]> {
  const ym = options?.yearMonth ?? getCurrentYearMonth();
  const results: CourtCalendarResult[] = [];

  for (const court of COURTS) {
    logger.info(
      `[Scraper] === Scraping ${court.name} (${court.code}) for ${ym} ===`
    );
    const calResult = await scrapeMonthlyCalendar(page, court, ym);
    results.push(calResult);

    // Polite delay between courts
    await humanDelay(page, 1000, 2000);
  }

  // Optionally also scrape the next month
  if (options?.includeNextMonth) {
    const [y, m] = ym.split("-").map(Number);
    const nextMonth = m === 12 ? 1 : m + 1;
    const nextYear = m === 12 ? y + 1 : y;
    const nextYm = `${nextYear}-${String(nextMonth).padStart(2, "0")}`;

    logger.info(`[Scraper] === Also scraping next month: ${nextYm} ===`);
    for (const court of COURTS) {
      const calResult = await scrapeMonthlyCalendar(page, court, nextYm);
      results.push(calResult);
      await humanDelay(page, 1000, 2000);
    }
  }

  // Summary
  const totalSlots = results.reduce((sum, r) => sum + r.slots.length, 0);
  const available = results.reduce(
    (sum, r) => sum + r.slots.filter((s) => s.available).length,
    0
  );
  const errors = results.filter((r) => r.error).length;

  logger.info(
    `[Scraper] === Summary: ${totalSlots} slots total, ${available} available, ${errors} errors ===`
  );

  return results;
}

/**
 * Extract only the available ("예약가능") slots from all court results.
 */
export function getAvailableSlots(results: CourtCalendarResult[]): TimeSlot[] {
  return results.flatMap((r) => r.slots.filter((s) => s.available));
}

export { COURTS } from "./courts.js";
