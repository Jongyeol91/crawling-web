/**
 * slot-filter.test.ts
 *
 * Unit tests for the time slot filter logic.
 * Run with: npx tsx src/slot-filter.test.ts
 *
 * Tests verify that:
 *   - Weekend slots (Sat/Sun) are always included regardless of time
 *   - Weekday slots (Mon–Fri) are only included if starting at 18:00+
 *   - Helper functions (extractStartHour, getDayOfWeek, isWeekend, isWeekday) work correctly
 *   - Both TimeSlot and CourtSlot filtering work
 */

import {
  isWeekend,
  isWeekday,
  extractStartHour,
  getDayOfWeek,
  isTargetSlot,
  filterTimeSlots,
  filterCourtSlots,
  filterAvailableTargetSlots,
} from "./slot-filter.js";
import type { TimeSlot } from "./calendar-scraper.js";
import type { CourtSlot } from "./slot-parser.js";

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
// isWeekend / isWeekday
// ---------------------------------------------------------------------------
console.log("\n=== isWeekend / isWeekday ===");

assert(isWeekend(0) === true, "Sunday (0) is weekend");
assert(isWeekend(6) === true, "Saturday (6) is weekend");
assert(isWeekend(1) === false, "Monday (1) is NOT weekend");
assert(isWeekend(5) === false, "Friday (5) is NOT weekend");
assert(isWeekend(3) === false, "Wednesday (3) is NOT weekend");

assert(isWeekday(1) === true, "Monday (1) is weekday");
assert(isWeekday(2) === true, "Tuesday (2) is weekday");
assert(isWeekday(3) === true, "Wednesday (3) is weekday");
assert(isWeekday(4) === true, "Thursday (4) is weekday");
assert(isWeekday(5) === true, "Friday (5) is weekday");
assert(isWeekday(0) === false, "Sunday (0) is NOT weekday");
assert(isWeekday(6) === false, "Saturday (6) is NOT weekday");
assert(isWeekday(-1) === false, "Invalid (-1) is NOT weekday");
assert(isWeekday(7) === false, "Invalid (7) is NOT weekday");

// ---------------------------------------------------------------------------
// extractStartHour
// ---------------------------------------------------------------------------
console.log("\n=== extractStartHour ===");

assert(extractStartHour("18:00~20:00") === 18, '"18:00~20:00" → 18');
assert(extractStartHour("06:00~08:00") === 6, '"06:00~08:00" → 6');
assert(extractStartHour("6:00~8:00") === 6, '"6:00~8:00" → 6');
assert(extractStartHour("20:00~22:00") === 20, '"20:00~22:00" → 20');
assert(extractStartHour("08:00-10:00") === 8, '"08:00-10:00" → 8');
assert(extractStartHour("18:00") === 18, '"18:00" → 18');
assert(extractStartHour("00:00~02:00") === 0, '"00:00~02:00" → 0');
assert(extractStartHour("") === -1, 'empty string → -1');
assert(extractStartHour("invalid") === -1, '"invalid" → -1');
assert(extractStartHour("no time here") === -1, '"no time here" → -1');

// ---------------------------------------------------------------------------
// getDayOfWeek
// ---------------------------------------------------------------------------
console.log("\n=== getDayOfWeek ===");

// 2026-03-31 is a Tuesday
assert(getDayOfWeek("2026-03-31") === 2, "2026-03-31 (Tue) → 2");
// 2026-04-04 is a Saturday
assert(getDayOfWeek("2026-04-04") === 6, "2026-04-04 (Sat) → 6");
// 2026-04-05 is a Sunday
assert(getDayOfWeek("2026-04-05") === 0, "2026-04-05 (Sun) → 0");
// 2026-04-06 is a Monday
assert(getDayOfWeek("2026-04-06") === 1, "2026-04-06 (Mon) → 1");
// 2026-04-10 is a Friday
assert(getDayOfWeek("2026-04-10") === 5, "2026-04-10 (Fri) → 5");
// Invalid dates
assert(getDayOfWeek("") === -1, "empty string → -1");
assert(getDayOfWeek("not-a-date") === -1, "invalid format → -1");
assert(getDayOfWeek("2026-02-30") === -1, "Feb 30 (invalid) → -1");
assert(getDayOfWeek("2026-13-01") === -1, "Month 13 (invalid) → -1");

// ---------------------------------------------------------------------------
// isTargetSlot — core predicate
// ---------------------------------------------------------------------------
console.log("\n=== isTargetSlot ===");

// Weekend — all times should pass
assert(isTargetSlot(0, 6) === true, "Sunday 06:00 → included (weekend)");
assert(isTargetSlot(0, 8) === true, "Sunday 08:00 → included (weekend)");
assert(isTargetSlot(0, 10) === true, "Sunday 10:00 → included (weekend)");
assert(isTargetSlot(0, 14) === true, "Sunday 14:00 → included (weekend)");
assert(isTargetSlot(0, 18) === true, "Sunday 18:00 → included (weekend)");
assert(isTargetSlot(0, 20) === true, "Sunday 20:00 → included (weekend)");
assert(isTargetSlot(6, 6) === true, "Saturday 06:00 → included (weekend)");
assert(isTargetSlot(6, 10) === true, "Saturday 10:00 → included (weekend)");
assert(isTargetSlot(6, 18) === true, "Saturday 18:00 → included (weekend)");
assert(isTargetSlot(6, 22) === true, "Saturday 22:00 → included (weekend)");

// Weekday — only 18:00+ should pass
assert(isTargetSlot(1, 18) === true, "Monday 18:00 → included");
assert(isTargetSlot(1, 20) === true, "Monday 20:00 → included");
assert(isTargetSlot(1, 22) === true, "Monday 22:00 → included");
assert(isTargetSlot(2, 19) === true, "Tuesday 19:00 → included");
assert(isTargetSlot(3, 18) === true, "Wednesday 18:00 → included");
assert(isTargetSlot(4, 20) === true, "Thursday 20:00 → included");
assert(isTargetSlot(5, 18) === true, "Friday 18:00 → included");

// Weekday — before 18:00 should be excluded
assert(isTargetSlot(1, 6) === false, "Monday 06:00 → excluded");
assert(isTargetSlot(1, 8) === false, "Monday 08:00 → excluded");
assert(isTargetSlot(1, 10) === false, "Monday 10:00 → excluded");
assert(isTargetSlot(1, 12) === false, "Monday 12:00 → excluded");
assert(isTargetSlot(1, 14) === false, "Monday 14:00 → excluded");
assert(isTargetSlot(1, 16) === false, "Monday 16:00 → excluded");
assert(isTargetSlot(2, 17) === false, "Tuesday 17:00 → excluded");
assert(isTargetSlot(3, 8) === false, "Wednesday 08:00 → excluded");
assert(isTargetSlot(4, 15) === false, "Thursday 15:00 → excluded");
assert(isTargetSlot(5, 6) === false, "Friday 06:00 → excluded");

// Edge: exactly 17:59 would still be hour 17 → excluded
assert(isTargetSlot(1, 17) === false, "Monday 17:xx → excluded (< 18)");

// Invalid dayOfWeek
assert(isTargetSlot(-1, 18) === false, "Invalid day -1 → excluded");
assert(isTargetSlot(7, 18) === false, "Invalid day 7 → excluded");

// ---------------------------------------------------------------------------
// filterTimeSlots — TimeSlot[] filtering
// ---------------------------------------------------------------------------
console.log("\n=== filterTimeSlots ===");

const timeSlots: TimeSlot[] = [
  // Saturday slots — all should pass
  {
    courtCode: "s06", courtName: "성내천", date: "2026-04-04", dayOfWeek: 6,
    time: "06:00~08:00", hour: 6, status: "예약가능", available: true, reservationUrl: "", availableCourts: "", slotId: "",
  },
  {
    courtCode: "s06", courtName: "성내천", date: "2026-04-04", dayOfWeek: 6,
    time: "10:00~12:00", hour: 10, status: "예약가능", available: true, reservationUrl: "", availableCourts: "", slotId: "",
  },
  // Sunday slot — should pass
  {
    courtCode: "s05", courtName: "송파", date: "2026-04-05", dayOfWeek: 0,
    time: "14:00~16:00", hour: 14, status: "예약마감", available: false, reservationUrl: "", availableCourts: "", slotId: "",
  },
  // Monday slots — only 18:00+ should pass
  {
    courtCode: "s06", courtName: "성내천", date: "2026-04-06", dayOfWeek: 1,
    time: "06:00~08:00", hour: 6, status: "예약가능", available: true, reservationUrl: "", availableCourts: "", slotId: "",
  },
  {
    courtCode: "s06", courtName: "성내천", date: "2026-04-06", dayOfWeek: 1,
    time: "10:00~12:00", hour: 10, status: "예약가능", available: true, reservationUrl: "", availableCourts: "", slotId: "",
  },
  {
    courtCode: "s06", courtName: "성내천", date: "2026-04-06", dayOfWeek: 1,
    time: "18:00~20:00", hour: 18, status: "예약가능", available: true, reservationUrl: "", availableCourts: "", slotId: "",
  },
  {
    courtCode: "s06", courtName: "성내천", date: "2026-04-06", dayOfWeek: 1,
    time: "20:00~22:00", hour: 20, status: "예약마감", available: false, reservationUrl: "", availableCourts: "", slotId: "",
  },
  // Wednesday morning — should be excluded
  {
    courtCode: "s03", courtName: "오금공원", date: "2026-04-08", dayOfWeek: 3,
    time: "08:00~10:00", hour: 8, status: "예약가능", available: true, reservationUrl: "", availableCourts: "", slotId: "",
  },
  // Friday evening — should pass
  {
    courtCode: "s03", courtName: "오금공원", date: "2026-04-10", dayOfWeek: 5,
    time: "18:00~20:00", hour: 18, status: "예약가능", available: true, reservationUrl: "", availableCourts: "", slotId: "",
  },
];

const filtered = filterTimeSlots(timeSlots);
assert(filtered.length === 6, `filterTimeSlots: 6 of 9 slots pass (got ${filtered.length})`);

// Verify specific slots included
assert(
  filtered.some((s) => s.date === "2026-04-04" && s.hour === 6),
  "Saturday 06:00 included"
);
assert(
  filtered.some((s) => s.date === "2026-04-04" && s.hour === 10),
  "Saturday 10:00 included"
);
assert(
  filtered.some((s) => s.date === "2026-04-05" && s.hour === 14),
  "Sunday 14:00 included"
);
assert(
  filtered.some((s) => s.date === "2026-04-06" && s.hour === 18),
  "Monday 18:00 included"
);
assert(
  filtered.some((s) => s.date === "2026-04-06" && s.hour === 20),
  "Monday 20:00 included"
);
assert(
  filtered.some((s) => s.date === "2026-04-10" && s.hour === 18),
  "Friday 18:00 included"
);

// Verify excluded
assert(
  !filtered.some((s) => s.date === "2026-04-06" && s.hour === 6),
  "Monday 06:00 excluded"
);
assert(
  !filtered.some((s) => s.date === "2026-04-06" && s.hour === 10),
  "Monday 10:00 excluded"
);
assert(
  !filtered.some((s) => s.date === "2026-04-08" && s.hour === 8),
  "Wednesday 08:00 excluded"
);

// Edge: empty input
assert(filterTimeSlots([]).length === 0, "filterTimeSlots: empty → empty");

// ---------------------------------------------------------------------------
// filterCourtSlots — CourtSlot[] filtering
// ---------------------------------------------------------------------------
console.log("\n=== filterCourtSlots ===");

const courtSlots: CourtSlot[] = [
  // 2026-04-04 is Saturday → all pass
  {
    courtCode: "s06", courtName: "성내천 테니스장", date: "2026-04-04",
    time: "06:00~08:00", status: "예약가능", available: true,
  },
  {
    courtCode: "s06", courtName: "성내천 테니스장", date: "2026-04-04",
    time: "10:00~12:00", status: "예약가능", available: true,
  },
  // 2026-04-06 is Monday → only 18:00+
  {
    courtCode: "s06", courtName: "성내천 테니스장", date: "2026-04-06",
    time: "08:00~10:00", status: "예약가능", available: true,
  },
  {
    courtCode: "s06", courtName: "성내천 테니스장", date: "2026-04-06",
    time: "18:00~20:00", status: "예약가능", available: true,
  },
  // 2026-04-05 is Sunday → pass
  {
    courtCode: "s05", courtName: "송파 테니스장", date: "2026-04-05",
    time: "14:00~16:00", status: "예약마감", available: false,
  },
  // 2026-04-07 is Tuesday → 16:00 excluded
  {
    courtCode: "s03", courtName: "오금공원 테니스장", date: "2026-04-07",
    time: "16:00~18:00", status: "예약가능", available: true,
  },
];

const filteredCourt = filterCourtSlots(courtSlots);
assert(
  filteredCourt.length === 4,
  `filterCourtSlots: 4 of 6 pass (got ${filteredCourt.length})`
);
assert(
  filteredCourt.some((s) => s.date === "2026-04-04" && s.time === "06:00~08:00"),
  "Sat 06:00 included"
);
assert(
  filteredCourt.some((s) => s.date === "2026-04-04" && s.time === "10:00~12:00"),
  "Sat 10:00 included"
);
assert(
  filteredCourt.some((s) => s.date === "2026-04-06" && s.time === "18:00~20:00"),
  "Mon 18:00 included"
);
assert(
  filteredCourt.some((s) => s.date === "2026-04-05" && s.time === "14:00~16:00"),
  "Sun 14:00 included"
);
assert(
  !filteredCourt.some((s) => s.date === "2026-04-06" && s.time === "08:00~10:00"),
  "Mon 08:00 excluded"
);
assert(
  !filteredCourt.some((s) => s.date === "2026-04-07" && s.time === "16:00~18:00"),
  "Tue 16:00 excluded"
);

// Edge: empty
assert(filterCourtSlots([]).length === 0, "filterCourtSlots: empty → empty");

// ---------------------------------------------------------------------------
// filterAvailableTargetSlots — combined availability + time filter
// ---------------------------------------------------------------------------
console.log("\n=== filterAvailableTargetSlots ===");

const combined = filterAvailableTargetSlots(timeSlots);
// From the 9 timeSlots: 6 pass time filter, of those only ones with 예약가능 status:
//   Sat 06:00 예약가능 ✓, Sat 10:00 예약가능 ✓, Sun 14:00 예약마감 ✗
//   Mon 18:00 예약가능 ✓, Mon 20:00 예약마감 ✗, Fri 18:00 예약가능 ✓
assert(
  combined.length === 4,
  `filterAvailableTargetSlots: 4 of 9 (got ${combined.length})`
);
assert(
  combined.every((s) => s.status === "예약가능"),
  "All combined results are 예약가능"
);
assert(
  combined.every((s) => isTargetSlot(s.dayOfWeek, s.hour)),
  "All combined results match target schedule"
);

// Verify the unavailable weekend slot is excluded
assert(
  !combined.some((s) => s.date === "2026-04-05" && s.hour === 14),
  "Sun 14:00 예약마감 excluded from combined"
);
// Verify the unavailable weekday evening slot is excluded
assert(
  !combined.some((s) => s.date === "2026-04-06" && s.hour === 20),
  "Mon 20:00 예약마감 excluded from combined"
);

// ---------------------------------------------------------------------------
// Edge cases: slots with unusual time formats
// ---------------------------------------------------------------------------
console.log("\n=== Edge cases ===");

const edgeCaseSlots: CourtSlot[] = [
  // Single-digit hour format
  {
    courtCode: "s06", courtName: "성내천", date: "2026-04-04",
    time: "6:00~8:00", status: "예약가능", available: true,
  },
  // Time with spaces
  {
    courtCode: "s06", courtName: "성내천", date: "2026-04-06",
    time: "18:00 ~ 20:00", status: "예약가능", available: true,
  },
];

const edgeFiltered = filterCourtSlots(edgeCaseSlots);
assert(edgeFiltered.length === 2, `Edge cases: both pass (got ${edgeFiltered.length})`);

// Invalid date slot should be excluded
const invalidSlots: CourtSlot[] = [
  {
    courtCode: "s06", courtName: "성내천", date: "invalid",
    time: "18:00~20:00", status: "예약가능", available: true,
  },
  {
    courtCode: "s06", courtName: "성내천", date: "2026-04-06",
    time: "badtime", status: "예약가능", available: true,
  },
];
const invalidFiltered = filterCourtSlots(invalidSlots);
assert(invalidFiltered.length === 0, "Invalid date/time slots excluded");

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
