/**
 * Smoke test for seoul-scraper. Run: npx tsx src/test-seoul.ts
 */
import {
  fetchCourtList,
  closeSeoulBrowser,
  SEOUL_CATEGORIES,
  filterCourtsByKeyword,
} from "./seoul-scraper.js";

async function main() {
  console.log("=== 서울시 스크래퍼 테스트 (테니스장만) ===\n");

  console.log("1) 테니스장 목록 수집 (접수중만)...");
  const tennisCourts = await fetchCourtList(SEOUL_CATEGORIES.TENNIS);
  console.log(`   총 ${tennisCourts.length}개 코트\n`);

  // 위치별 카운트
  const byLoc: Record<string, number> = {};
  tennisCourts.forEach((c) => {
    byLoc[c.location] = (byLoc[c.location] || 0) + 1;
  });
  console.log("2) 위치별 분포 (top 10):");
  Object.entries(byLoc)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([loc, n]) => console.log(`   - ${loc}: ${n}`));

  // 한남 필터
  const hannam = filterCourtsByKeyword(tennisCourts, "한남");
  console.log(`\n3) '한남' 필터링: ${hannam.length}개`);
  hannam.slice(0, 5).forEach((c) => {
    console.log(`   - [${c.id}] ${c.title}`);
  });

  await closeSeoulBrowser();
  console.log("\n완료");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
