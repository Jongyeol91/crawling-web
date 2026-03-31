/**
 * test-slack.ts
 *
 * Manual test script to verify Slack Webhook/Bot is configured and operational.
 * Run with: npm run test:slack
 *
 * This sends a test message to the configured Slack channel,
 * then sends a sample availability notification with mock data.
 */

import "dotenv/config";
import { IncomingWebhook } from "@slack/webhook";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? "";

async function main() {
  console.log("=== Slack Webhook Test ===\n");

  // Step 1: Validate env
  if (!SLACK_WEBHOOK_URL) {
    console.error(
      "❌ SLACK_WEBHOOK_URL is not set.\n" +
        "   Please set it in .env or as an environment variable.\n" +
        "   See .env.example for setup instructions."
    );
    process.exit(1);
  }

  console.log(
    `✅ SLACK_WEBHOOK_URL is set (${SLACK_WEBHOOK_URL.substring(0, 40)}...)`
  );

  const webhook = new IncomingWebhook(SLACK_WEBHOOK_URL);

  // Step 2: Send a simple text message
  console.log("\n--- Sending simple test message ---");
  try {
    await webhook.send({
      text: "🏓 테니스장 알림봇 테스트 메시지입니다. Webhook이 정상 작동합니다!",
    });
    console.log("✅ Simple message sent successfully");
  } catch (err) {
    console.error("❌ Failed to send simple message:", err);
    process.exit(1);
  }

  // Step 3: Send a rich Block Kit message (mimics real notification)
  console.log("\n--- Sending sample availability notification ---");
  try {
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

    await webhook.send({
      text: "🎾 테니스장 예약 가능 (3건) - 테스트",
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🎾 테니스장 예약 가능 알림 (3건) - 테스트",
            emoji: true,
          },
        },
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "*📍 성내천 테니스장*\n" +
              "• 2026-04-04 (토) 🔴주말  *10:00~12:00*  → <https://spc.esongpa.or.kr/fmcs/125?selected_date=2026-04-04|예약하기>\n" +
              "• 2026-04-04 (토) 🔴주말  *14:00~16:00*  → <https://spc.esongpa.or.kr/fmcs/125?selected_date=2026-04-04|예약하기>",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "*📍 송파 테니스장*\n" +
              "• 2026-04-06 (월)  *18:00~20:00*  → <https://spc.esongpa.or.kr/fmcs/124?selected_date=2026-04-06|예약하기>",
          },
        },
        { type: "divider" },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `🕐 확인 시각: ${now}  |  <https://spc.esongpa.or.kr/fmcs/37|송파구체육시설 예약 페이지>  |  ⚠️ 이것은 테스트 메시지입니다`,
            },
          ],
        },
      ],
    });
    console.log("✅ Rich notification sent successfully");
  } catch (err) {
    console.error("❌ Failed to send rich notification:", err);
    process.exit(1);
  }

  // Step 4: Test startup message from the notifier module
  console.log("\n--- Testing notifier module ---");
  try {
    const { sendStartupMessage, resetWebhook } = await import(
      "./slack-notifier.js"
    );
    resetWebhook(); // ensure fresh instance
    const result = await sendStartupMessage();
    if (result.success) {
      console.log("✅ Startup message sent via slack-notifier module");
    } else {
      console.error("❌ Startup message failed:", result.error);
      process.exit(1);
    }
  } catch (err) {
    console.error("❌ Failed to test notifier module:", err);
    process.exit(1);
  }

  // Step 5: Test error alert
  console.log("\n--- Testing error alert ---");
  try {
    const { sendErrorAlert } = await import("./slack-notifier.js");
    const result = await sendErrorAlert(
      "테스트 오류 알림 - 이것은 테스트입니다. 무시해주세요."
    );
    if (result.success) {
      console.log("✅ Error alert sent via slack-notifier module");
    } else {
      console.error("❌ Error alert failed:", result.error);
      process.exit(1);
    }
  } catch (err) {
    console.error("❌ Failed to test error alert:", err);
    process.exit(1);
  }

  console.log("\n=== All Slack tests passed! ===");
  console.log(
    "Check your Slack channel for the test messages.\n" +
      "If you see them, the Webhook/Bot is configured and operational."
  );
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
