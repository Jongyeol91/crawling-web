/**
 * slack-bot.ts
 *
 * Long-running Slack Bot using @slack/bolt in Socket Mode.
 *
 * Features:
 *   - App mention (@봇이름) → on-demand scraping + thread report
 *   - Keyword "테니스" in channel → on-demand scraping + thread report
 *   - Daily 9:00 KST cron → scheduled report to configured channel
 *
 * Run: npx tsx src/slack-bot.ts
 */

import { App, type SayFn } from "@slack/bolt";
import cron from "node-cron";
import {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  SLACK_CHANNEL_IDS,
} from "./config.js";
import { createSessionManager, type SessionManager } from "./session-manager.js";
import { scrapeAllCourts, getAvailableSlots } from "./calendar-scraper.js";
import type { CourtCalendarResult, TimeSlot } from "./calendar-scraper.js";
import { isWeekend } from "./slot-filter.js";
import {
  buildSummaryBlocks,
  buildSummaryText,
  buildCourtDetailBlocks,
} from "./slack-reporter.js";
import { analyzeWithLLM, chatWithLLM, needsCourtData } from "./llm-analyzer.js";
import { filterNewAlerts, markAsSent } from "./alert-dedup.js";
import { filterAvailableTargetSlots } from "./slot-filter.js";
import type { CourtSlot } from "./slot-parser.js";
import { logger } from "./logger.js";

// ─── Slack App ───────────────────────────────────────────────────────────────

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// ─── Scraping state ──────────────────────────────────────────────────────────

let scraping = false;
let cancelled = false;
let lastScrapeTime = 0;
const RATE_LIMIT_MS = 30_000;

// Cache last scrape results for preset filter buttons
let cachedResults: CourtCalendarResult[] = [];
let cachedChannel = "";
let cachedThreadTs = ""; // main message ts
let cachedDetailTs: string[] = []; // per-court thread message ts values

function checkCancelled() {
  if (cancelled) throw new Error("__CANCELLED__");
}

// ─── Cancel button action ────────────────────────────────────────────────────

// ─── Preset filter buttons ────────────────────────────────────────────────────

function presetButtons(): Record<string, unknown> {
  return {
    type: "actions",
    elements: [
      { type: "button", text: { type: "plain_text", text: "📋 전체", emoji: true }, action_id: "filter_all" },
      { type: "button", text: { type: "plain_text", text: "🏖️ 주말만", emoji: true }, action_id: "filter_weekend" },
      { type: "button", text: { type: "plain_text", text: "🌆 평일저녁", emoji: true }, action_id: "filter_afternoon" },
    ],
  };
}

function filterResults(results: CourtCalendarResult[], preset: string): CourtCalendarResult[] {
  return results.map((r) => ({
    ...r,
    slots: r.slots.filter((s) => {
      if (!s.available) return false;
      switch (preset) {
        case "golden": return true;
        case "weekend": return isWeekend(s.dayOfWeek);
        case "afternoon": return !isWeekend(s.dayOfWeek) && s.hour >= 18;
        default: return true;
      }
    }),
  }));
}

for (const preset of ["filter_all", "filter_weekend", "filter_afternoon"]) {
  app.action(preset, async ({ ack, body, client }) => {
    await ack();
    if (cachedResults.length === 0 || cachedDetailTs.length === 0) return;

    const filterName = preset.replace("filter_", "");
    const filtered = filterResults(cachedResults, filterName);
    const ch = (body as any).channel?.id ?? cachedChannel;
    if (!ch) return;

    const labels: Record<string, string> = {
      all: "📋 전체", weekend: "🏖️ 주말", afternoon: "🌆 평일저녁(18시+)",
    };

    // Update main summary message
    const mainTs = (body as any).message?.ts;
    if (mainTs) {
      const summaryBlocks = buildSummaryBlocks(filtered, "command");
      summaryBlocks.push(presetButtons());
      await client.chat.update({
        channel: ch,
        ts: mainTs,
        text: buildSummaryText(filtered),
        blocks: summaryBlocks,
      } as any);
    }

    // Update existing thread messages in-place
    for (let i = 0; i < filtered.length && i < cachedDetailTs.length; i++) {
      const detailBlocks = buildCourtDetailBlocks(filtered[i]);
      detailBlocks.unshift({
        type: "context",
        elements: [{ type: "mrkdwn", text: `${labels[filterName]} 필터 적용` }],
      });
      await client.chat.update({
        channel: ch,
        ts: cachedDetailTs[i],
        text: `${labels[filterName]} ${filtered[i].court.name}`,
        blocks: detailBlocks,
      } as any);
    }

    logger.info(`[Bot] Preset filter applied: ${filterName}`);
  });
}

app.action("cancel_scrape", async ({ ack, body, client }) => {
  await ack();
  cancelled = true;
  logger.info("[Bot] Cancel requested by user");

  // Update the message to show cancelled state
  if ("message" in body && body.message && "channel" in body) {
    const ch = (body as any).channel?.id ?? (body as any).channel;
    const ts = (body as any).message?.ts;
    if (ch && ts) {
      await client.chat.update({
        channel: ch,
        ts,
        text: "🚫 조회가 취소되었습니다.",
        blocks: [],
      } as any);
    }
  }
});

// ─── Status message helper ───────────────────────────────────────────────────

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks;
}

function statusBlocks(text: string): Array<Record<string, unknown>> {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🚫 취소", emoji: true },
          action_id: "cancel_scrape",
          style: "danger",
        },
      ],
    },
  ];
}

async function runScrapeAndReport(
  postMessage: (opts: Record<string, unknown>) => Promise<{ ts?: string }>,
  channel: string,
  trigger: "command" | "daily"
): Promise<void> {
  if (scraping) {
    await postMessage({ channel, text: "⏳ 이미 조회 중입니다. 잠시 후 다시 시도해주세요." });
    return;
  }
  const cooldown = RATE_LIMIT_MS - (Date.now() - lastScrapeTime);
  if (cooldown > 0 && trigger !== "daily") {
    await postMessage({ channel, text: `⏳ ${Math.ceil(cooldown / 1000)}초 후에 다시 시도해주세요.` });
    return;
  }

  scraping = true;
  cancelled = false;
  lastScrapeTime = Date.now();
  let sm: SessionManager | undefined;

  try {
    // 0. Immediately show "searching" indicator with cancel button
    const searchText = "🔍 테니스장 예약 현황 조회 중...";
    const searchMsg = await postMessage({ channel, text: searchText, blocks: statusBlocks(searchText) });
    const searchMsgTs = searchMsg.ts;

    // 1. Scrape
    logger.info(`[Bot] Scrape triggered (${trigger})`);
    checkCancelled();
    sm = await createSessionManager();

    const today = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
    );
    const daysInMonth = new Date(
      today.getFullYear(),
      today.getMonth() + 1,
      0
    ).getDate();
    const includeNextMonth = daysInMonth - today.getDate() <= 7;

    checkCancelled();
    let results = await scrapeAllCourts(sm.page, { includeNextMonth });
    await sm.persistSession();
    checkCancelled();

    // Cache results for preset filter buttons
    cachedResults = results;
    cachedChannel = channel;

    // 2. Post summary (main message) with preset buttons
    const summaryBlocks = buildSummaryBlocks(results, trigger);
    summaryBlocks.push(presetButtons());
    const summaryText = buildSummaryText(results);

    const mainMsg = await postMessage({
      channel,
      text: summaryText,
      blocks: summaryBlocks,
    });

    const threadTs = mainMsg.ts;
    if (!threadTs) {
      logger.error("[Bot] Failed to get message ts for thread");
      return;
    }

    // 3. Post per-court details in thread (cache ts for later updates)
    cachedThreadTs = threadTs;
    cachedDetailTs = [];
    for (const result of results) {
      const detailBlocks = buildCourtDetailBlocks(result);
      const detailMsg = await postMessage({
        channel,
        thread_ts: threadTs,
        text: `📍 ${result.court.name} 테니스장 상세`,
        blocks: detailBlocks,
      });
      if (detailMsg.ts) cachedDetailTs.push(detailMsg.ts);
    }

    // Delete "searching" message
    if (searchMsgTs) {
      try { await app.client.chat.delete({ channel, ts: searchMsgTs } as any); } catch { /* ignore */ }
    }

    const totalAvailable = getAvailableSlots(results).length;
    logger.info(`[Bot] Report posted: ${totalAvailable} available slots`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg === "__CANCELLED__") {
      logger.info("[Bot] Scrape cancelled by user");
    } else {
      logger.error(`[Bot] Scrape error: ${errMsg}`);
      await postMessage({ channel, text: `⚠️ 스크래핑 오류: ${errMsg}` });
    }
  } finally {
    scraping = false;
    cancelled = false;
    if (sm) await sm.close();
  }
}

// ─── LLM-powered query ───────────────────────────────────────────────────────

async function runScrapeWithLLM(
  postMessage: (opts: Record<string, unknown>) => Promise<{ ts?: string }>,
  channel: string,
  question: string
): Promise<void> {
  if (scraping) {
    await postMessage({ channel, text: "⏳ 이미 조회 중입니다. 잠시 후 다시 시도해주세요." });
    return;
  }
  const cooldown = RATE_LIMIT_MS - (Date.now() - lastScrapeTime);
  if (cooldown > 0) {
    await postMessage({ channel, text: `⏳ ${Math.ceil(cooldown / 1000)}초 후에 다시 시도해주세요.` });
    return;
  }

  scraping = true;
  cancelled = false;
  lastScrapeTime = Date.now();
  let sm: SessionManager | undefined;

  // Helper to update progress message
  const initText = `🔍 "${question}" — 준비 중...`;
  const statusMsg = await postMessage({ channel, text: initText, blocks: statusBlocks(initText) });
  const statusTs = statusMsg.ts;
  const updateStatus = async (text: string) => {
    if (!statusTs) return;
    try {
      await app.client.chat.update({ channel, ts: statusTs, text } as any);
    } catch { /* ignore update errors */ }
  };

  try {
    logger.info(`[Bot] LLM query triggered: "${question}"`);

    checkCancelled();
    await updateStatus(`🔍 "${question}" — 로그인 확인 중...`);
    sm = await createSessionManager();
    checkCancelled();

    const today = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
    );
    const daysInMonth = new Date(
      today.getFullYear(),
      today.getMonth() + 1,
      0
    ).getDate();
    const includeNextMonth = daysInMonth - today.getDate() <= 7;

    await updateStatus(`🔍 "${question}" — 3개 코트 스크래핑 중...`);
    const results = await scrapeAllCourts(sm.page, { includeNextMonth });
    await sm.persistSession();
    checkCancelled();

    const totalAvailable = getAvailableSlots(results).length;
    await updateStatus(`🔍 "${question}" — ${totalAvailable}건 수집 완료, 분석 중...`);

    // LLM analysis
    checkCancelled();
    const answer = await analyzeWithLLM(question, results);

    // Update status to complete
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    await updateStatus(`✅ "${question}" — 분석 완료 (${now})`);

    // Post answer in thread (split if >2900 chars)
    if (statusTs) {
      const chunks = splitText(answer, 2900);
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const blocks: Array<Record<string, unknown>> = [
          { type: "section", text: { type: "mrkdwn", text: chunks[i] } },
        ];
        await postMessage({
          channel,
          thread_ts: statusTs,
          blocks,
          text: chunks[i],
        });
      }
    }

    logger.info("[Bot] LLM report posted");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg === "__CANCELLED__") {
      logger.info("[Bot] LLM scrape cancelled by user");
    } else {
      logger.error(`[Bot] LLM scrape error: ${errMsg}`);
      await postMessage({ channel, text: `⚠️ 오류: ${errMsg}` });
    }
  } finally {
    scraping = false;
    cancelled = false;
    if (sm) await sm.close();
  }
}

// ─── Event: App mention ──────────────────────────────────────────────────────

app.event("app_mention", async ({ event, client }) => {
  const text = (event.text ?? "").replace(/<@[^>]+>/g, "").trim();
  const threadTs = (event as any).thread_ts ?? undefined;
  logger.info(`[Bot] App mention from <@${event.user}> in ${event.channel}, text: "${text}", thread: ${threadTs ?? "none"}`);

  // Reply in same thread if mentioned from a thread
  const post = (opts: Record<string, unknown>) =>
    client.chat.postMessage({ ...opts, ...(threadTs ? { thread_ts: threadTs } : {}) } as any) as any;

  if (text === "폴링") {
    // 수동 폴링 실행
    await post({ channel: event.channel, text: "🔍 폴링 실행 중..." });
    await runPolling();
    await post({ channel: event.channel, text: "폴링 완료." });
  } else if (!text || ["테니스", "조회", "현황"].includes(text)) {
    await runScrapeAndReport(post, event.channel, "command");
  } else {
    await runScrapeWithLLM(post, event.channel, text);
  }
});

// ─── Polling: 10분 간격 빈자리 알림 ──────────────────────────────────────────

const pollingThreadTs: Record<string, string> = {};
let pollingThreadDate = "";
let pollingInProgress = false;

async function runPolling(): Promise<void> {
  if (pollingInProgress || scraping) {
    logger.info("[Bot:Poll] Skipped (already running)");
    return;
  }

  pollingInProgress = true;
  let sm: SessionManager | undefined;

  try {
    logger.info("[Bot:Poll] Polling started");

    const todayStr = new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
    if (pollingThreadDate !== todayStr) {
      for (const k of Object.keys(pollingThreadTs)) delete pollingThreadTs[k];
      pollingThreadDate = todayStr;
    }

    sm = await createSessionManager();

    const today = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
    );
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const includeNextMonth = daysInMonth - today.getDate() <= 7;

    const results = await scrapeAllCourts(sm.page, { includeNextMonth });
    await sm.persistSession();

    const allAvailable = getAvailableSlots(results);
    const targetSlots = filterAvailableTargetSlots(allAvailable);

    const courtSlots: CourtSlot[] = targetSlots.map((s) => ({
      courtCode: s.courtCode,
      courtName: `${s.courtName} 테니스장`,
      date: s.date,
      time: s.time,
      status: s.status,
      available: s.available,
      reservationUrl: s.reservationUrl,
    }));

    const newSlots = filterNewAlerts(courtSlots);
    logger.info(`[Bot:Poll] Target: ${targetSlots.length}, New: ${newSlots.length}`);

    if (newSlots.length > 0) {
      const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];
      const lines = newSlots.map((s) => {
        const [, m, d] = s.date.split("-");
        const date = new Date(
          parseInt(s.date.split("-")[0], 10),
          parseInt(m!, 10) - 1,
          parseInt(d!, 10)
        );
        const dayName = DAY_NAMES[date.getDay()] ?? "";
        const shortDate = `${parseInt(m!, 10)}/${parseInt(d!, 10)}`;
        const shortTime = s.time.replace(/:00/g, "");
        const url = s.reservationUrl || `https://spc.esongpa.or.kr/page/rent/${s.courtCode}.od.list.php`;
        return `*${shortDate}(${dayName})* ${s.courtName} \`${shortTime}\` <${url}|예약>`;
      });

      const text = `*새로운 빈 자리 발견!* (${newSlots.length}건)\n${lines.join("\n")}`;

      for (const ch of SLACK_CHANNEL_IDS) {
        const msgOpts: Record<string, unknown> = {
          channel: ch,
          text,
          blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
        };
        if (pollingThreadTs[ch]) msgOpts.thread_ts = pollingThreadTs[ch];

        try {
          const alertMsg = await app.client.chat.postMessage(msgOpts as any) as any;
          if (!pollingThreadTs[ch] && alertMsg.ts) pollingThreadTs[ch] = alertMsg.ts;
        } catch (err) {
          logger.error(`[Bot:Poll] Failed to post to ${ch}: ${(err as any)?.data?.error ?? err}`);
        }
      }

      markAsSent(newSlots);
      logger.info(`[Bot:Poll] Alert sent for ${newSlots.length} slot(s)`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[Bot:Poll] Error: ${errMsg}`);
  } finally {
    pollingInProgress = false;
    if (sm) await sm.close();
  }
}

function startPollingCron(): void {
  if (SLACK_CHANNEL_IDS.length === 0) {
    logger.warn("[Bot] No channels configured, polling disabled");
    return;
  }

  cron.schedule("*/10 * * * *", () => { runPolling(); }, { timezone: "Asia/Seoul" });

  logger.info("[Bot] Polling cron scheduled: every 10 minutes");
}

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
    logger.error(
      "SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required.\n" +
        "Set them in .env file. See .env.example for details."
    );
    process.exit(1);
  }

  await app.start();
  logger.info("⚡ Slack bot started (Socket Mode)");

  // Auto-join configured channels
  for (const ch of SLACK_CHANNEL_IDS) {
    try {
      await app.client.conversations.join({ channel: ch });
      logger.info(`[Bot] Joined channel ${ch}`);
    } catch (err) {
      logger.info(`[Bot] Channel ${ch}: ${(err as any)?.data?.error ?? "already joined"}`);
    }
  }

  startPollingCron();

  logger.info("Listening for:");
  logger.info('  - App mentions (@bot) — 전체 조회 또는 질문');
  if (SLACK_CHANNEL_IDS.length > 0) {
    logger.info(`  - Polling every 10min → 빈자리 알림 (24h 쿨다운) → ${SLACK_CHANNEL_IDS.join(", ")}`);
  }
}

main();
