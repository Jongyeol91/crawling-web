/**
 * slack-notifier.ts
 *
 * Sends Slack notifications for available tennis court slots.
 * Each message contains: court name, date, time slot, and direct reservation link.
 *
 * Uses @slack/webhook (IncomingWebhook) to post rich Block Kit messages
 * to a configured Slack channel.
 */

import { IncomingWebhook, type IncomingWebhookResult } from "@slack/webhook";
import { SLACK_WEBHOOK_URL, BASE_URL } from "./config.js";
import type { CourtSlot } from "./slot-parser.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Notification result for a batch of slots */
export interface NotificationResult {
  /** Whether the notification was sent successfully */
  success: boolean;
  /** Number of slots included in the notification */
  slotCount: number;
  /** Error message if sending failed */
  error?: string;
  /** Timestamp when notification was sent */
  sentAt: Date;
}

// ---------------------------------------------------------------------------
// Webhook singleton
// ---------------------------------------------------------------------------

let webhookInstance: IncomingWebhook | null = null;

/**
 * Get or create the IncomingWebhook instance.
 * Lazily initialised so the URL can be set via env before first use.
 */
function getWebhook(): IncomingWebhook {
  const url = SLACK_WEBHOOK_URL;
  if (!url) {
    throw new Error(
      "[SlackNotifier] SLACK_WEBHOOK_URL is not set. " +
        "Please set the SLACK_WEBHOOK_URL environment variable."
    );
  }
  if (!webhookInstance) {
    webhookInstance = new IncomingWebhook(url);
  }
  return webhookInstance;
}

/**
 * Reset the webhook instance (useful for testing or URL changes).
 */
export function resetWebhook(): void {
  webhookInstance = null;
}

// ---------------------------------------------------------------------------
// Day-of-week helpers
// ---------------------------------------------------------------------------

const DAY_NAMES_KR = ["일", "월", "화", "수", "목", "금", "토"] as const;

function getDayNameKr(dateStr: string): string {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(
    parseInt(match[1], 10),
    parseInt(match[2], 10) - 1,
    parseInt(match[3], 10)
  );
  return DAY_NAMES_KR[date.getDay()] ?? "";
}

function isWeekendDate(dateStr: string): boolean {
  const dayName = getDayNameKr(dateStr);
  return dayName === "토" || dayName === "일";
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

/**
 * Build a single-line summary for one slot.
 */
function formatSlotLine(slot: CourtSlot): string {
  const dayName = getDayNameKr(slot.date);
  const weekendTag = isWeekendDate(slot.date) ? " [주말]" : "";
  return `*${slot.courtName}*  |  ${slot.date} (${dayName})${weekendTag}  |  ${slot.time}`;
}

/**
 * Build the reservation URL for a slot.
 * Uses the slot's own reservationUrl if available, otherwise constructs one.
 */
function getReservationUrl(slot: CourtSlot): string {
  if (slot.reservationUrl) return slot.reservationUrl;
  // Build the court's calendar URL
  return `${BASE_URL}/page/rent/${slot.courtCode}.od.list.php`;
}

/**
 * Build Slack Block Kit blocks for a batch of available slots.
 * Groups slots by court for readability.
 */
function buildSlackBlocks(slots: CourtSlot[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  // Header
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `🎾 테니스장 예약 가능 알림 (${slots.length}건)`,
      emoji: true,
    },
  });

  blocks.push({ type: "divider" });

  // Group slots by court name
  const grouped = new Map<string, CourtSlot[]>();
  for (const slot of slots) {
    const key = slot.courtName;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(slot);
  }

  // Build section for each court
  for (const [courtName, courtSlots] of Array.from(grouped.entries())) {
    // Sort by date then time
    courtSlots.sort((a, b) => {
      const dateCmp = a.date.localeCompare(b.date);
      return dateCmp !== 0 ? dateCmp : a.time.localeCompare(b.time);
    });

    const slotLines = courtSlots.map((slot) => {
      const dayName = getDayNameKr(slot.date);
      const weekendTag = isWeekendDate(slot.date) ? " 🔴주말" : "";
      const url = getReservationUrl(slot);
      return `• ${slot.date} (${dayName})${weekendTag}  *${slot.time}*  → <${url}|예약하기>`;
    });

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📍 ${courtName}*\n${slotLines.join("\n")}`,
      },
    });
  }

  blocks.push({ type: "divider" });

  // Footer with timestamp
  const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `🕐 확인 시각: ${now}  |  <${BASE_URL}|송파구체육시설 예약 페이지>`,
      },
    ],
  });

  return blocks;
}

/**
 * Build a simple fallback text summary (for notifications / non-Block-Kit clients).
 */
function buildFallbackText(slots: CourtSlot[]): string {
  const lines = slots.map((slot) => {
    const dayName = getDayNameKr(slot.date);
    return `${slot.courtName} | ${slot.date}(${dayName}) | ${slot.time}`;
  });
  return `🎾 테니스장 예약 가능 (${slots.length}건)\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a Slack notification for one or more available court slots.
 *
 * Each notification includes:
 *   - Court name (e.g. "성내천 테니스장")
 *   - Date with day-of-week (e.g. "2026-04-05 (토) [주말]")
 *   - Time slot (e.g. "18:00~20:00")
 *   - Direct reservation link
 *
 * Slots are grouped by court for readability.
 *
 * @param slots - Available CourtSlot[] to notify about (should be pre-filtered)
 * @returns NotificationResult indicating success/failure
 */
export async function sendSlotNotification(
  slots: CourtSlot[]
): Promise<NotificationResult> {
  if (slots.length === 0) {
    return {
      success: true,
      slotCount: 0,
      sentAt: new Date(),
    };
  }

  try {
    const webhook = getWebhook();
    const blocks = buildSlackBlocks(slots);
    const text = buildFallbackText(slots);

    await webhook.send({ text, blocks: blocks as any });

    logger.info(
      `[SlackNotifier] Successfully sent notification for ${slots.length} slot(s)`
    );

    return {
      success: true,
      slotCount: slots.length,
      sentAt: new Date(),
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[SlackNotifier] Failed to send notification: ${errorMsg}`);

    return {
      success: false,
      slotCount: slots.length,
      error: errorMsg,
      sentAt: new Date(),
    };
  }
}

/**
 * Send a single-slot notification (convenience wrapper).
 */
export async function sendSingleSlotNotification(
  slot: CourtSlot
): Promise<NotificationResult> {
  return sendSlotNotification([slot]);
}

/**
 * Send a startup/heartbeat message to confirm the notifier is working.
 */
export async function sendStartupMessage(): Promise<NotificationResult> {
  try {
    const webhook = getWebhook();
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

    await webhook.send({
      text: `🎾 송파구 테니스장 모니터링 시작 (${now})`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `✅ *송파구 테니스장 모니터링 시작*\n\n` +
              `모니터링 대상:\n` +
              `• 성내천 테니스장\n` +
              `• 송파 테니스장\n` +
              `• 오금공원 테니스장\n\n` +
              `조건: 평일 18시 이후 + 주말 전체\n` +
              `주기: 5분 간격\n\n` +
              `시작 시각: ${now}`,
          },
        },
      ],
    });

    logger.info("[SlackNotifier] Startup message sent");
    return { success: true, slotCount: 0, sentAt: new Date() };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[SlackNotifier] Failed to send startup message: ${errorMsg}`);
    return { success: false, slotCount: 0, error: errorMsg, sentAt: new Date() };
  }
}

/**
 * Send an error alert to Slack (for critical failures like login issues).
 */
export async function sendErrorAlert(
  errorMessage: string
): Promise<NotificationResult> {
  try {
    const webhook = getWebhook();
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

    await webhook.send({
      text: `⚠️ 테니스장 모니터링 오류: ${errorMessage}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `⚠️ *테니스장 모니터링 오류*\n\n` +
              `\`\`\`${errorMessage}\`\`\`\n\n` +
              `시각: ${now}`,
          },
        },
      ],
    });

    return { success: true, slotCount: 0, sentAt: new Date() };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[SlackNotifier] Failed to send error alert: ${errorMsg}`);
    return { success: false, slotCount: 0, error: errorMsg, sentAt: new Date() };
  }
}
