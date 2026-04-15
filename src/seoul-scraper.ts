/**
 * seoul-scraper.ts
 *
 * 서울특별시 공공서비스예약 사이트(yeyak.seoul.go.kr) 스크래퍼.
 *
 * 송파 시스템과의 차이점:
 *   - 로그인 불필요 (공공 페이지)
 *   - 시간대 슬롯이 아닌 날짜 단위 신청제 (선착순/추첨)
 *   - 카테고리: 테니스장(T108), 피클볼장(T118)
 *
 * 흐름:
 *   1. fetchCourtList(category) — 검색 페이지를 페이지네이션으로 순회하며 모든 코트(rsv_svc_id) 수집
 *   2. fetchCourtCalendar(id) — 특정 코트의 월간 캘린더에서 날짜별 (신청수/모집수, 상태) 추출
 */

import { chromium, type Browser, type Page } from "playwright";
import { logger } from "./logger.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_URL = "https://yeyak.seoul.go.kr";
const LIST_PATH = "/web/search/selectPageListDetailSearchImg.do";
const DETAIL_PATH = "/web/reservation/selectReservView.do";

/** 시설 카테고리 dCode */
export const SEOUL_CATEGORIES = {
  TENNIS: "T108",
  PICKLEBALL: "T118",
} as const;

export type SeoulCategory = (typeof SEOUL_CATEGORIES)[keyof typeof SEOUL_CATEGORIES];

const CATEGORY_NAMES: Record<SeoulCategory, string> = {
  [SEOUL_CATEGORIES.TENNIS]: "테니스장",
  [SEOUL_CATEGORIES.PICKLEBALL]: "피클볼장",
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SeoulCourt {
  /** rsv_svc_id, e.g. "S260413140907888726" */
  id: string;
  /** 코트명, e.g. "한남테니스장 1번코트 새벽,주간" */
  title: string;
  /** 장소명, e.g. "한남테니스장(용산구)" */
  location: string;
  /** 카테고리 (테니스장/피클볼장) */
  category: string;
  /** 접수기간 */
  receptionPeriod?: string;
  /** 이용기간 */
  usagePeriod?: string;
  /** 상태 (접수중/마감 등) */
  status?: string;
}

export interface SeoulSlot {
  /** YYYY-MM-DD */
  date: string;
  /** 1~31 */
  day: number;
  /** 신청수 */
  applied: number;
  /** 총 모집수 */
  capacity: number;
  /** 잔여 인원 */
  remaining: number;
  /** 상태 (예약가능/예약불가/예약마감) */
  status: string;
  /** 0=일 ~ 6=토 */
  dayOfWeek: number;
}

export interface SeoulCourtCalendar {
  court: SeoulCourt;
  /** YYYY-MM */
  yearMonth: string;
  slots: SeoulSlot[];
  error?: string;
}

// ─── Browser helpers ─────────────────────────────────────────────────────────

let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser) return sharedBrowser;
  // headful=true로 봇 차단 우회 (서울시 사이트가 headless 감지)
  const headful = process.env.SEOUL_HEADFUL !== "false";
  sharedBrowser = await chromium.launch({
    headless: !headful,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-site-isolation-trials",
    ],
  });
  return sharedBrowser;
}

export async function closeSeoulBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}

async function newPage(): Promise<Page> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    extraHTTPHeaders: {
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "Sec-Ch-Ua": '"Chromium";v="146", "Not?A_Brand";v="8"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"macOS"',
    },
  });

  // Stealth init script — webdriver/플러그인 마스킹
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["ko-KR", "ko", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", {
      get: () => [
        { name: "PDF Viewer", filename: "internal-pdf-viewer" },
        { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer" },
      ],
    });
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    // chrome 객체
    // @ts-ignore
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  });

  return ctx.newPage();
}

// ─── Court list (paginated) ──────────────────────────────────────────────────

/**
 * 첫 페이지 GET으로 세션 쿠키를 받아온다 (필수 — 없으면 다른 결과가 옴).
 */
async function fetchSessionCookies(category: SeoulCategory): Promise<string> {
  const url = `${BASE_URL}${LIST_PATH}?code=T100&dCode=${category}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
  });
  const setCookies = (resp.headers as any).getSetCookie?.() ?? [];
  return setCookies.map((c: string) => c.split(";")[0]).join("; ");
}

/**
 * 카테고리별 코트 목록을 fetch로 직접 수집 (Playwright 사용 안 함).
 * "접수중" (sch_svc_sttus=R403) 필터로 효율화.
 * 한 페이지당 6개씩, 전체 페이지를 순회.
 */
export async function fetchCourtList(category: SeoulCategory): Promise<SeoulCourt[]> {
  const courts: SeoulCourt[] = [];
  const seen = new Set<string>();
  const categoryName = CATEGORY_NAMES[category];

  const cookieHeader = await fetchSessionCookies(category);
  const baseHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cookie": cookieHeader,
  };

  try {
    logger.info(`[Seoul] Fetching court list for ${categoryName} (status=접수중)`);

    for (let p = 1; p <= 30; p++) {
      const url = `${BASE_URL}${LIST_PATH}?code=T100&dCode=${category}&sch_svc_sttus=R403&currentPage=${p}`;
      const resp = await fetch(url, { headers: baseHeaders });
      if (!resp.ok) {
        logger.warn(`[Seoul] Page ${p} status ${resp.status}, stopping`);
        break;
      }
      const html = await resp.text();

      // 카드 단위 정규식: a tag with onclick=fnDetailPage 부터 닫는 </a>까지
      // (안에 nested <li>가 있어서 </li>가 아닌 </a>로 끝남)
      const cardRegex =
        /<a[^>]*onclick="fnDetailPage\(['"]([^'"]+)['"][^>]*title="([^"]+)"[\s\S]*?<\/a>/g;
      let added = 0;
      let m: RegExpExecArray | null;
      while ((m = cardRegex.exec(html)) !== null) {
        const id = m[1];
        const title = m[2];
        if (seen.has(id)) continue;
        const block = m[0];

        // 장소명: <b class="place">장소명</b> <div ...>한남테니스장(용산구)</div>
        const locMatch = block.match(
          /<b[^>]*class="place"[^>]*>장소명<\/b>\s*<div[^>]*>([^<]+)<\/div>/
        );
        // 접수기간: <b class="date1">접수기간</b> 2026.04.15 ~ 2026.04.30
        const recpMatch = block.match(
          /<b[^>]*class="date1"[^>]*>접수기간<\/b>\s*([\d.]+\s*~\s*[\d.]+)/
        );
        const usageMatch = block.match(
          /<b[^>]*class="date2"[^>]*>이용기간<\/b>\s*([\d.]+\s*~\s*[\d.]+)/
        );

        seen.add(id);
        courts.push({
          id,
          title: title.trim(),
          location: locMatch?.[1]?.trim() || "",
          category: categoryName,
          receptionPeriod: recpMatch?.[1]?.trim() || "",
          usagePeriod: usageMatch?.[1]?.trim() || "",
          status: "접수중",
        });
        added++;
      }

      if (added === 0) {
        // fallback: id만이라도 추출
        const idOnly = Array.from(html.matchAll(/fnDetailPage\(['"]([SK]\d+)/g)).map(
          (mm) => mm[1]
        );
        for (const id of idOnly) {
          if (seen.has(id)) continue;
          seen.add(id);
          courts.push({
            id, title: "", location: "", category: categoryName,
            receptionPeriod: "", usagePeriod: "", status: "접수중",
          });
          added++;
        }
      }

      logger.info(`[Seoul] ${categoryName} page ${p}: +${added} (total ${courts.length})`);
      if (added === 0) break;
      // 부드러운 페이스 (서버 부담 감소)
      await new Promise((r) => setTimeout(r, 500));
    }

    logger.info(`[Seoul] ${categoryName}: collected ${courts.length} courts`);
  } catch (err) {
    logger.error(`[Seoul] fetchCourtList error: ${err instanceof Error ? err.message : err}`);
  }

  return courts;
}

// ─── Court calendar ──────────────────────────────────────────────────────────

/**
 * 특정 코트의 월간 캘린더 파싱.
 */
export async function fetchCourtCalendar(court: SeoulCourt): Promise<SeoulCourtCalendar> {
  const page = await newPage();
  const result: SeoulCourtCalendar = {
    court,
    yearMonth: "",
    slots: [],
  };

  try {
    const url = `${BASE_URL}${DETAIL_PATH}?rsv_svc_id=${court.id}&currentPage=1`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(500);

    const data = await page.evaluate(() => {
      const out: { yearMonth: string; slots: Array<Record<string, unknown>> } = {
        yearMonth: "",
        slots: [],
      };

      // "2026년 04월" 추출
      const headerText = document.body.innerText;
      const ymMatch = headerText.match(/(\d{4})년\s*(\d{1,2})월/);
      if (ymMatch) {
        out.yearMonth = `${ymMatch[1]}-${ymMatch[2].padStart(2, "0")}`;
      }

      const cal = document.querySelector("table.tbl_cal");
      if (!cal) return out;

      const cells = cal.querySelectorAll("td");
      cells.forEach((td) => {
        if (td.classList.contains("empty")) return;
        const link = td.querySelector("a");
        const text = (link || td).textContent?.replace(/\s+/g, " ").trim() ?? "";
        const dayMatch = text.match(/^(\d{1,2})/);
        if (!dayMatch) return;

        const day = parseInt(dayMatch[1], 10);
        const status = link?.title ?? "예약불가";

        // "16 5/6" 형태에서 신청수/모집수 추출
        const fracMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
        const applied = fracMatch ? parseInt(fracMatch[1], 10) : 0;
        const capacity = fracMatch ? parseInt(fracMatch[2], 10) : 0;

        out.slots.push({
          day,
          applied,
          capacity,
          status,
        });
      });

      return out;
    });

    result.yearMonth = data.yearMonth;
    if (result.yearMonth) {
      const [yearStr, monthStr] = result.yearMonth.split("-");
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10);

      for (const raw of data.slots) {
        const day = raw.day as number;
        const date = new Date(year, month - 1, day);
        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const applied = raw.applied as number;
        const capacity = raw.capacity as number;

        result.slots.push({
          date: dateStr,
          day,
          applied,
          capacity,
          remaining: Math.max(0, capacity - applied),
          status: raw.status as string,
          dayOfWeek: date.getDay(),
        });
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[Seoul] fetchCourtCalendar error for ${court.id}: ${errMsg}`);
    result.error = errMsg;
  } finally {
    await page.context().close();
  }

  return result;
}

// ─── High-level: fetch all + filter ──────────────────────────────────────────

/**
 * 테니스 + 피클볼 전체 코트 목록을 한 번에 수집.
 */
export async function fetchAllSeoulCourts(): Promise<SeoulCourt[]> {
  const tennis = await fetchCourtList(SEOUL_CATEGORIES.TENNIS);
  const pickleball = await fetchCourtList(SEOUL_CATEGORIES.PICKLEBALL);
  return [...tennis, ...pickleball];
}

/**
 * 코트 이름으로 필터링 (예: "한남" → 한남테니스장 코트들).
 */
export function filterCourtsByKeyword(courts: SeoulCourt[], keyword: string): SeoulCourt[] {
  const lower = keyword.toLowerCase();
  return courts.filter(
    (c) =>
      c.title.toLowerCase().includes(lower) ||
      c.location.toLowerCase().includes(lower)
  );
}

/**
 * 캘린더에서 예약가능한 슬롯만 추출.
 */
export function getAvailableSeoulSlots(calendar: SeoulCourtCalendar): SeoulSlot[] {
  return calendar.slots.filter((s) => s.status === "예약가능" && s.remaining > 0);
}
