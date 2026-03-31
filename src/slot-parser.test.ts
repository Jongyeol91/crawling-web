/**
 * slot-parser.test.ts
 *
 * Unit tests for slot status identification logic.
 * Run with: npx tsx src/slot-parser.test.ts
 */

import {
  isSlotAvailable,
  isKnownStatus,
  filterAvailableSlots,
  STATUS_AVAILABLE,
  type CourtSlot,
} from "./slot-parser.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// isSlotAvailable tests
// ---------------------------------------------------------------------------
console.log("\n=== isSlotAvailable ===");

assert(isSlotAvailable("예약가능") === true, '"예약가능" → available');
assert(isSlotAvailable(" 예약가능 ") === true, '" 예약가능 " (whitespace) → available');
assert(isSlotAvailable("예약 가능") === true, '"예약 가능" (space in middle) → available');
assert(isSlotAvailable("\t예약가능\n") === true, 'tabs/newlines → available');

assert(isSlotAvailable("예약마감") === false, '"예약마감" → NOT available');
assert(isSlotAvailable("예약불가") === false, '"예약불가" → NOT available');
assert(isSlotAvailable("대기예약") === false, '"대기예약" → NOT available');
assert(isSlotAvailable("예약대기") === false, '"예약대기" → NOT available');
assert(isSlotAvailable("접수마감") === false, '"접수마감" → NOT available');
assert(isSlotAvailable("마감") === false, '"마감" → NOT available');
assert(isSlotAvailable("신청") === false, '"신청" → NOT available');
assert(isSlotAvailable("") === false, 'empty string → NOT available');
assert(isSlotAvailable("예약가능합니다") === false, '"예약가능합니다" (superset) → NOT available (strict match)');
assert(isSlotAvailable("가능") === false, '"가능" (substring) → NOT available');
assert(isSlotAvailable("예약") === false, '"예약" alone → NOT available');

// ---------------------------------------------------------------------------
// isKnownStatus tests
// ---------------------------------------------------------------------------
console.log("\n=== isKnownStatus ===");

assert(isKnownStatus("예약가능") === true, '"예약가능" is known');
assert(isKnownStatus("예약마감") === true, '"예약마감" is known');
assert(isKnownStatus("예약불가") === true, '"예약불가" is known');
assert(isKnownStatus("대기예약") === true, '"대기예약" is known');
assert(isKnownStatus("예약대기") === true, '"예약대기" is known');
assert(isKnownStatus("접수마감") === true, '"접수마감" is known');
assert(isKnownStatus("접수대기") === true, '"접수대기" is known');
assert(isKnownStatus("신청") === true, '"신청" is known');
assert(isKnownStatus("마감") === true, '"마감" is known');

assert(isKnownStatus("운영종료") === false, '"운영종료" is unknown');
assert(isKnownStatus("unknown") === false, '"unknown" is unknown');
assert(isKnownStatus("") === false, 'empty string is unknown');

// Whitespace handling
assert(isKnownStatus(" 예약가능 ") === true, '" 예약가능 " with whitespace is known');
assert(isKnownStatus("예약 마감") === true, '"예약 마감" with space is known');

// ---------------------------------------------------------------------------
// STATUS_AVAILABLE constant
// ---------------------------------------------------------------------------
console.log("\n=== STATUS_AVAILABLE constant ===");

assert(STATUS_AVAILABLE === "예약가능", "STATUS_AVAILABLE equals 예약가능");

// ---------------------------------------------------------------------------
// filterAvailableSlots tests
// ---------------------------------------------------------------------------
console.log("\n=== filterAvailableSlots ===");

const testSlots: CourtSlot[] = [
  {
    courtCode: "s06",
    courtName: "성내천 테니스장",
    date: "2026-04-05",
    time: "18:00~20:00",
    status: "예약가능",
    available: true,
  },
  {
    courtCode: "s06",
    courtName: "성내천 테니스장",
    date: "2026-04-05",
    time: "06:00~08:00",
    status: "예약마감",
    available: false,
  },
  {
    courtCode: "s05",
    courtName: "송파 테니스장",
    date: "2026-04-06",
    time: "10:00~12:00",
    status: "예약가능",
    available: true,
  },
  {
    courtCode: "s05",
    courtName: "송파 테니스장",
    date: "2026-04-06",
    time: "14:00~16:00",
    status: "예약불가",
    available: false,
  },
  {
    courtCode: "s03",
    courtName: "오금공원 테니스장",
    date: "2026-04-06",
    time: "08:00~10:00",
    status: "대기예약",
    available: false,
  },
];

const availableOnly = filterAvailableSlots(testSlots);
assert(availableOnly.length === 2, `filterAvailableSlots returns 2 of 5 (got ${availableOnly.length})`);
assert(
  availableOnly.every((s) => s.status === "예약가능"),
  "all filtered slots have status 예약가능"
);
assert(
  availableOnly.some((s) => s.courtCode === "s06" && s.time === "18:00~20:00"),
  "includes 성내천 18:00~20:00"
);
assert(
  availableOnly.some((s) => s.courtCode === "s05" && s.time === "10:00~12:00"),
  "includes 송파 10:00~12:00"
);

// Edge case: empty input
const emptyResult = filterAvailableSlots([]);
assert(emptyResult.length === 0, "empty input → empty output");

// Edge case: all available
const allAvail: CourtSlot[] = [
  { courtCode: "s06", courtName: "성내천", date: "2026-04-05", time: "18:00~20:00", status: "예약가능", available: true },
  { courtCode: "s06", courtName: "성내천", date: "2026-04-05", time: "20:00~22:00", status: "예약가능", available: true },
];
assert(filterAvailableSlots(allAvail).length === 2, "all available → all returned");

// Edge case: none available
const noneAvail: CourtSlot[] = [
  { courtCode: "s06", courtName: "성내천", date: "2026-04-05", time: "18:00~20:00", status: "예약마감", available: false },
  { courtCode: "s06", courtName: "성내천", date: "2026-04-05", time: "20:00~22:00", status: "예약불가", available: false },
];
assert(filterAvailableSlots(noneAvail).length === 0, "none available → empty");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.error("\n⚠️  Some tests failed!");
  process.exit(1);
} else {
  console.log("\n🎉 All tests passed!");
}
