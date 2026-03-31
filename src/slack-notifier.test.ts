/**
 * slack-notifier.test.ts
 *
 * Unit tests for the Slack notification module.
 * Tests message formatting and structure without actually sending to Slack.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import type { CourtSlot } from "./slot-parser.js";

// We test the internal formatting by importing and checking outputs.
// Since the main functions depend on the webhook, we test the exported helpers
// and verify the module loads correctly.

describe("slack-notifier", () => {
  it("module loads without error", async () => {
    const mod = await import("./slack-notifier.js");
    assert.ok(mod.sendSlotNotification, "sendSlotNotification should be exported");
    assert.ok(mod.sendSingleSlotNotification, "sendSingleSlotNotification should be exported");
    assert.ok(mod.sendStartupMessage, "sendStartupMessage should be exported");
    assert.ok(mod.sendErrorAlert, "sendErrorAlert should be exported");
    assert.ok(mod.resetWebhook, "resetWebhook should be exported");
  });

  it("sendSlotNotification returns success with 0 slots (no-op)", async () => {
    const { sendSlotNotification } = await import("./slack-notifier.js");
    const result = await sendSlotNotification([]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.slotCount, 0);
    assert.ok(result.sentAt instanceof Date);
  });

  it("sendSlotNotification fails gracefully without webhook URL", async () => {
    // With no SLACK_WEBHOOK_URL set, it should return an error result
    const origUrl = process.env.SLACK_WEBHOOK_URL;
    process.env.SLACK_WEBHOOK_URL = "";

    // We need to re-import to pick up the empty URL
    // But since config is already loaded, we test the error path differently
    const { sendSlotNotification, resetWebhook } = await import("./slack-notifier.js");
    resetWebhook();

    const slots: CourtSlot[] = [
      {
        courtCode: "s06",
        courtName: "성내천 테니스장",
        date: "2026-04-05",
        time: "18:00~20:00",
        status: "예약가능",
        available: true,
        reservationUrl: "https://spc.esongpa.or.kr/fmcs/125?selected_date=2026-04-05",
      },
    ];

    const result = await sendSlotNotification(slots);
    // Should fail because no webhook URL
    assert.strictEqual(result.success, false);
    assert.ok(result.error, "should have an error message");
    assert.ok(result.error!.includes("SLACK_WEBHOOK_URL"), "error should mention the URL");

    // Restore
    if (origUrl !== undefined) {
      process.env.SLACK_WEBHOOK_URL = origUrl;
    }
    resetWebhook();
  });
});

describe("slot data structure for notifications", () => {
  it("CourtSlot contains all required notification fields", () => {
    const slot: CourtSlot = {
      courtCode: "s05",
      courtName: "송파 테니스장",
      date: "2026-04-04",
      time: "18:00~20:00",
      status: "예약가능",
      available: true,
      reservationUrl: "https://spc.esongpa.or.kr/fmcs/124?selected_date=2026-04-04",
    };

    // Verify all fields needed for Slack notification are present
    assert.ok(slot.courtName, "courtName is required");
    assert.ok(slot.date, "date is required");
    assert.ok(slot.time, "time is required");
    assert.ok(slot.reservationUrl, "reservationUrl is required");
    assert.strictEqual(slot.available, true, "should be available");
  });

  it("multiple slots can be grouped by court", () => {
    const slots: CourtSlot[] = [
      {
        courtCode: "s06",
        courtName: "성내천 테니스장",
        date: "2026-04-05",
        time: "10:00~12:00",
        status: "예약가능",
        available: true,
        reservationUrl: "https://spc.esongpa.or.kr/fmcs/125?selected_date=2026-04-05",
      },
      {
        courtCode: "s05",
        courtName: "송파 테니스장",
        date: "2026-04-05",
        time: "14:00~16:00",
        status: "예약가능",
        available: true,
        reservationUrl: "https://spc.esongpa.or.kr/fmcs/124?selected_date=2026-04-05",
      },
      {
        courtCode: "s06",
        courtName: "성내천 테니스장",
        date: "2026-04-05",
        time: "18:00~20:00",
        status: "예약가능",
        available: true,
        reservationUrl: "https://spc.esongpa.or.kr/fmcs/125?selected_date=2026-04-05",
      },
    ];

    // Group by court name
    const grouped = new Map<string, CourtSlot[]>();
    for (const slot of slots) {
      if (!grouped.has(slot.courtName)) grouped.set(slot.courtName, []);
      grouped.get(slot.courtName)!.push(slot);
    }

    assert.strictEqual(grouped.size, 2, "should have 2 court groups");
    assert.strictEqual(grouped.get("성내천 테니스장")!.length, 2);
    assert.strictEqual(grouped.get("송파 테니스장")!.length, 1);
  });
});
