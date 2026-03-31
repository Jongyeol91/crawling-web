/**
 * alert-dedup.test.ts
 *
 * Tests for the alert deduplication module.
 * Run with: npx tsx src/alert-dedup.test.ts
 */

import fs from "node:fs";
import path from "node:path";
import {
  slotKey,
  filterNewAlerts,
  markAsSent,
  clearState,
  loadState,
  saveState,
  getStateSummary,
  DEFAULT_COOLDOWN_MS,
} from "./alert-dedup.js";
import type { CourtSlot } from "./slot-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_STATE_FILE = path.resolve(process.cwd(), ".alert-dedup-test-state.json");

function cleanup(): void {
  try {
    if (fs.existsSync(TEST_STATE_FILE)) fs.unlinkSync(TEST_STATE_FILE);
  } catch {}
}

function makeSlot(overrides: Partial<CourtSlot> = {}): CourtSlot {
  return {
    courtCode: "s06",
    courtName: "성내천 테니스장",
    date: "2026-04-04",
    time: "18:00~20:00",
    status: "예약가능",
    available: true,
    reservationUrl: "https://spc.esongpa.or.kr/fmcs/125?selected_date=2026-04-04",
    ...overrides,
  };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\n🧪 alert-dedup.test.ts\n");

// -- slotKey --
console.log("📋 slotKey()");
{
  const slot = makeSlot();
  const key = slotKey(slot);
  assert(key === "s06|2026-04-04|18:00~20:00", `key = "${key}"`);

  const slot2 = makeSlot({ courtCode: "s05", date: "2026-04-05", time: "10:00~12:00" });
  const key2 = slotKey(slot2);
  assert(key2 === "s05|2026-04-05|10:00~12:00", `key2 = "${key2}"`);
}

// -- State persistence --
console.log("\n📋 loadState / saveState");
{
  cleanup();
  const empty = loadState(TEST_STATE_FILE);
  assert(Object.keys(empty).length === 0, "loadState returns empty for missing file");

  const state = { "s06|2026-04-04|18:00~20:00": { sentAt: new Date().toISOString(), sentAtMs: Date.now() } };
  saveState(state, TEST_STATE_FILE);
  const loaded = loadState(TEST_STATE_FILE);
  assert(Object.keys(loaded).length === 1, "saveState + loadState round-trips");
  assert(loaded["s06|2026-04-04|18:00~20:00"] !== undefined, "correct key persisted");
  cleanup();
}

// -- Corrupt state file --
console.log("\n📋 Corrupt state file handling");
{
  cleanup();
  fs.writeFileSync(TEST_STATE_FILE, "NOT VALID JSON!!!", "utf-8");
  const state = loadState(TEST_STATE_FILE);
  assert(Object.keys(state).length === 0, "returns empty for corrupt file");
  cleanup();

  fs.writeFileSync(TEST_STATE_FILE, "[1,2,3]", "utf-8");
  const state2 = loadState(TEST_STATE_FILE);
  assert(Object.keys(state2).length === 0, "returns empty for array JSON");
  cleanup();
}

// -- filterNewAlerts: first time all pass --
console.log("\n📋 filterNewAlerts - first call (no prior state)");
{
  cleanup();
  const slots = [
    makeSlot(),
    makeSlot({ courtCode: "s05", courtName: "송파 테니스장", time: "20:00~22:00" }),
  ];
  const result = filterNewAlerts(slots, DEFAULT_COOLDOWN_MS, TEST_STATE_FILE);
  assert(result.length === 2, `all ${result.length} slots pass on first call`);
  cleanup();
}

// -- filterNewAlerts: suppressed within cooldown --
console.log("\n📋 filterNewAlerts - suppression within cooldown");
{
  cleanup();
  const slot = makeSlot();

  // Simulate: first call, mark as sent
  const first = filterNewAlerts([slot], DEFAULT_COOLDOWN_MS, TEST_STATE_FILE);
  assert(first.length === 1, "first call passes");
  markAsSent(first, TEST_STATE_FILE);

  // Second call immediately — should be suppressed
  const second = filterNewAlerts([slot], DEFAULT_COOLDOWN_MS, TEST_STATE_FILE);
  assert(second.length === 0, "second call suppressed (within cooldown)");
  cleanup();
}

// -- filterNewAlerts: re-sent after cooldown expires --
console.log("\n📋 filterNewAlerts - re-send after cooldown expires");
{
  cleanup();
  const slot = makeSlot();

  // Manually write a state entry that's 61 minutes old
  const oldTime = Date.now() - (61 * 60 * 1000);
  const state = {
    [slotKey(slot)]: {
      sentAt: new Date(oldTime).toISOString(),
      sentAtMs: oldTime,
    },
  };
  saveState(state, TEST_STATE_FILE);

  const result = filterNewAlerts([slot], DEFAULT_COOLDOWN_MS, TEST_STATE_FILE);
  assert(result.length === 1, "slot re-sent after cooldown (61 min)");
  cleanup();
}

// -- filterNewAlerts: NOT re-sent at 59 minutes --
console.log("\n📋 filterNewAlerts - still suppressed at 59 minutes");
{
  cleanup();
  const slot = makeSlot();

  const recentTime = Date.now() - (59 * 60 * 1000);
  const state = {
    [slotKey(slot)]: {
      sentAt: new Date(recentTime).toISOString(),
      sentAtMs: recentTime,
    },
  };
  saveState(state, TEST_STATE_FILE);

  const result = filterNewAlerts([slot], DEFAULT_COOLDOWN_MS, TEST_STATE_FILE);
  assert(result.length === 0, "slot still suppressed at 59 min");
  cleanup();
}

// -- Mixed: some new, some suppressed --
console.log("\n📋 filterNewAlerts - mixed new and suppressed");
{
  cleanup();
  const slotA = makeSlot(); // will be recently sent
  const slotB = makeSlot({ courtCode: "s05", courtName: "송파 테니스장" }); // new
  const slotC = makeSlot({ time: "20:00~22:00" }); // cooldown expired

  const now = Date.now();
  const state = {
    [slotKey(slotA)]: { sentAt: new Date(now - 30 * 60_000).toISOString(), sentAtMs: now - 30 * 60_000 },
    [slotKey(slotC)]: { sentAt: new Date(now - 90 * 60_000).toISOString(), sentAtMs: now - 90 * 60_000 },
  };
  saveState(state, TEST_STATE_FILE);

  const result = filterNewAlerts([slotA, slotB, slotC], DEFAULT_COOLDOWN_MS, TEST_STATE_FILE);
  assert(result.length === 2, `2 of 3 slots pass (got ${result.length})`);

  const keys = result.map(slotKey);
  assert(!keys.includes(slotKey(slotA)), "slotA suppressed (30 min ago)");
  assert(keys.includes(slotKey(slotB)), "slotB passes (new)");
  assert(keys.includes(slotKey(slotC)), "slotC passes (90 min ago, cooldown expired)");
  cleanup();
}

// -- Housekeeping: prune entries older than 24 hours --
console.log("\n📋 Housekeeping - prune old entries");
{
  cleanup();
  const slot = makeSlot();
  const oldSlotKey = "s03|2026-03-01|10:00~12:00";

  const now = Date.now();
  const state = {
    [oldSlotKey]: { sentAt: new Date(now - 25 * 60 * 60_000).toISOString(), sentAtMs: now - 25 * 60 * 60_000 },
    [slotKey(slot)]: { sentAt: new Date(now - 30 * 60_000).toISOString(), sentAtMs: now - 30 * 60_000 },
  };
  saveState(state, TEST_STATE_FILE);

  // filterNewAlerts triggers housekeeping
  filterNewAlerts([], DEFAULT_COOLDOWN_MS, TEST_STATE_FILE);

  const afterState = loadState(TEST_STATE_FILE);
  assert(afterState[oldSlotKey] === undefined, "25-hour-old entry pruned");
  assert(afterState[slotKey(slot)] !== undefined, "30-min entry kept");
  cleanup();
}

// -- clearState --
console.log("\n📋 clearState");
{
  cleanup();
  const state = { "test|key": { sentAt: new Date().toISOString(), sentAtMs: Date.now() } };
  saveState(state, TEST_STATE_FILE);
  clearState(TEST_STATE_FILE);
  const cleared = loadState(TEST_STATE_FILE);
  assert(Object.keys(cleared).length === 0, "state cleared");
  cleanup();
}

// -- getStateSummary --
console.log("\n📋 getStateSummary");
{
  cleanup();
  const now = Date.now();
  const state = {
    "active1": { sentAt: new Date(now - 10 * 60_000).toISOString(), sentAtMs: now - 10 * 60_000 },
    "active2": { sentAt: new Date(now - 30 * 60_000).toISOString(), sentAtMs: now - 30 * 60_000 },
    "expired1": { sentAt: new Date(now - 90 * 60_000).toISOString(), sentAtMs: now - 90 * 60_000 },
  };
  saveState(state, TEST_STATE_FILE);

  const summary = getStateSummary(TEST_STATE_FILE);
  assert(summary.totalEntries === 3, `total = ${summary.totalEntries}`);
  assert(summary.activeCooldowns === 2, `active = ${summary.activeCooldowns}`);
  assert(summary.expiredEntries === 1, `expired = ${summary.expiredEntries}`);
  cleanup();
}

// -- Custom cooldown --
console.log("\n📋 Custom cooldown period");
{
  cleanup();
  const slot = makeSlot();
  const CUSTOM_COOLDOWN = 5 * 60_000; // 5 minutes

  // Sent 6 minutes ago
  const state = {
    [slotKey(slot)]: {
      sentAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      sentAtMs: Date.now() - 6 * 60_000,
    },
  };
  saveState(state, TEST_STATE_FILE);

  const result = filterNewAlerts([slot], CUSTOM_COOLDOWN, TEST_STATE_FILE);
  assert(result.length === 1, "re-sent with 5min cooldown after 6min");
  cleanup();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}\n`);

if (failed > 0) {
  process.exit(1);
}
