/**
 * index.ts — Main entry point for the Songpa tennis court scraper.
 *
 * Called by run.sh via cron every 5 minutes.
 * Flow:
 *   1. Ensure authenticated session (auto re-login if needed)
 *   2. Scrape all 3 court calendars for available slots
 *   3. Filter to target schedule (weekday 18:00+, all weekend)
 *   4. Deduplicate (suppress same slot for 1 hour)
 *   5. Send Slack notification for new available slots
 */

import { createSessionManager } from "./session-manager.js";
import { scrapeAllCourts, getAvailableSlots } from "./calendar-scraper.js";
import { filterAvailableTargetSlots } from "./slot-filter.js";
import { filterNewAlerts, markAsSent } from "./alert-dedup.js";
import { sendSlotNotification, sendErrorAlert } from "./slack-notifier.js";
import { logger } from "./logger.js";
import type { CourtSlot } from "./slot-parser.js";

async function main() {
  logger.info("=== Songpa Tennis Scraper — Start ===");

  let sm;

  try {
    // 1. Ensure authenticated session
    sm = await createSessionManager();

    // 2. Scrape all courts (current month + next month near month-end)
    const today = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
    );
    const dayOfMonth = today.getDate();
    const daysInMonth = new Date(
      today.getFullYear(),
      today.getMonth() + 1,
      0
    ).getDate();
    const includeNextMonth = daysInMonth - dayOfMonth <= 7;

    const results = await scrapeAllCourts(sm.page, { includeNextMonth });

    // 3. Get available slots
    const allAvailable = getAvailableSlots(results);
    logger.info(`[Main] Total available slots across all courts: ${allAvailable.length}`);

    // 4. Filter to target schedule (weekday 18:00+ and all weekend)
    const targetSlots = filterAvailableTargetSlots(allAvailable);
    logger.info(`[Main] Target slots (weekday 18+, weekend all): ${targetSlots.length}`);

    // 5. Convert TimeSlot to CourtSlot for dedup/notification compatibility
    const courtSlots: CourtSlot[] = targetSlots.map((s) => ({
      courtCode: s.courtCode,
      courtName: `${s.courtName} 테니스장`,
      date: s.date,
      time: s.time,
      status: s.status,
      available: s.available,
      reservationUrl: s.reservationUrl,
    }));

    // 6. Deduplicate — suppress same slot within 1 hour cooldown
    const newSlots = filterNewAlerts(courtSlots);
    logger.info(`[Main] New slots after dedup: ${newSlots.length}`);

    // 7. Send Slack notification
    if (newSlots.length > 0) {
      const notifResult = await sendSlotNotification(newSlots);
      if (notifResult.success) {
        markAsSent(newSlots);
        logger.info(`[Main] Slack notification sent for ${newSlots.length} slot(s)`);
      } else {
        logger.error(`[Main] Failed to send Slack notification: ${notifResult.error}`);
      }
    } else {
      logger.info("[Main] No new slots to notify about.");
    }

    // Save session state after successful run
    await sm.persistSession();

    logger.info("=== Songpa Tennis Scraper — Done ===");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`[Main] Fatal error: ${errMsg}`);

    // Try to send error alert to Slack
    try {
      await sendErrorAlert(errMsg);
    } catch {
      logger.error("[Main] Could not send error alert to Slack");
    }

    process.exitCode = 1;
  } finally {
    if (sm) {
      await sm.close();
    }
  }
}

main();
