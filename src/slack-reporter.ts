/**
 * slack-reporter.ts
 *
 * Formats scraping results into Slack Block Kit messages for thread-based reporting.
 * Used by both on-demand queries and daily scheduled reports.
 *
 * Message structure:
 *   - Main message: Summary with per-court counts
 *   - Thread replies: One per court with detailed slot tables
 */

import type { CourtCalendarResult, TimeSlot } from "./calendar-scraper.js";
import { BASE_URL } from "./config.js";

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
  const day = getDayNameKr(dateStr);
  return day === "토" || day === "일";
}


// ─── Summary (main message) ──────────────────────────────────────────────────

export function buildSummaryBlocks(
  results: CourtCalendarResult[],
  trigger: "command" | "daily"
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const title =
    trigger === "daily" ? "📋 일일 테니스장 예약 현황" : "🎾 테니스장 예약 조회 결과";

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: title, emoji: true },
  });

  // Per-court summary lines
  const lines: string[] = [];
  let totalAvailable = 0;
  for (const r of results) {
    const available = r.slots.filter((s) => s.available);
    totalAvailable += available.length;
    const icon = r.error ? "⚠️" : "📍";
    const status = r.error
      ? `오류: ${r.error}`
      : `${available.length}건 가능`;
    lines.push(`${icon} *${r.court.name} 테니스장*  —  ${status}`);
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: lines.join("\n") },
  });

  blocks.push({ type: "divider" });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `💬 더 자세한 조건은 @멘션으로 질문해보세요`,
      },
    ],
  });

  return blocks;
}

export function buildSummaryText(results: CourtCalendarResult[]): string {
  let total = 0;
  const lines = results.map((r) => {
    const count = r.slots.filter((s) => s.available).length;
    total += count;
    return `${r.court.name}: ${count}건`;
  });
  return `🎾 테니스장 현황 — ${lines.join(", ")} (총 ${total}건)`;
}

// ─── Thread detail (per court) ───────────────────────────────────────────────

export function buildCourtDetailBlocks(
  result: CourtCalendarResult
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const available = result.slots.filter((s) => s.available);
  const calendarUrl = `${BASE_URL}${result.court.calendarPath}`;

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*📍 ${result.court.name} 테니스장* — <${calendarUrl}|캘린더 열기>\n예약 가능: *${available.length}건* / 총 ${result.slots.length}건`,
    },
  });

  if (available.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_예약 가능한 슬롯이 없습니다._" },
    });
    return blocks;
  }

  // Group by date
  const byDate = new Map<string, TimeSlot[]>();
  for (const slot of available) {
    if (!byDate.has(slot.date)) byDate.set(slot.date, []);
    byDate.get(slot.date)!.push(slot);
  }

  const dateLines: string[] = [];
  for (const [date, slots] of Array.from(byDate.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const dayName = getDayNameKr(date);
    const weekendTag = isWeekendDate(date) ? "🔴" : "";
    const [, m, d] = date.split("-");
    const shortDate = `${parseInt(m!, 10)}/${parseInt(d!, 10)}`;

    const slotTexts = slots
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((s) => {
        const shortTime = s.time.replace(/:00/g, "");
        return `\`${shortTime}\``;
      });

    dateLines.push(`*${shortDate}(${dayName})*${weekendTag}  ${slotTexts.join("  ")}`);
  }

  // Slack blocks have a 3000 char limit per text field, split if needed
  const chunks = chunkLines(dateLines, 2800);
  for (const chunk of chunks) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: chunk },
    });
  }

  return blocks;
}

function chunkLines(lines: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    if (current.length + line.length + 1 > maxChars && current) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);
  return chunks;
}
