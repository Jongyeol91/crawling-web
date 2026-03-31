/**
 * Court definitions for the 3 target tennis courts at spc.esongpa.or.kr.
 *
 * Excludes 오륜 (under construction).
 *
 * URL patterns from the actual site:
 *   - 성내천 테니스장: /page/rent/s06.od.list.php
 *   - 송파 테니스장:   /page/rent/s05.od.list.php
 *   - 오금공원 테니스장: /page/rent/s03.od.list.php
 */

import type { CourtName } from "./config.js";

export interface CourtInfo {
  /** Court code used in URL parameters (e.g., "s06") */
  code: string;
  /** Korean display name (matches config.TARGET_COURTS) */
  name: CourtName;
  /** Calendar page path, e.g. "/page/rent/s06.od.list.php" */
  calendarPath: string;
}

/**
 * The 3 monitored tennis courts.
 */
export const COURTS: readonly CourtInfo[] = [
  {
    code: "s06",
    name: "성내천",
    calendarPath: "/page/rent/s06.od.list.php",
  },
  {
    code: "s05",
    name: "송파",
    calendarPath: "/page/rent/s05.od.list.php",
  },
  {
    code: "s03",
    name: "오금공원",
    calendarPath: "/page/rent/s03.od.list.php",
  },
] as const;

/**
 * Get a CourtInfo by court code.
 */
export function getCourtByCode(code: string): CourtInfo | undefined {
  return COURTS.find((c) => c.code === code);
}

/**
 * Get a CourtInfo by Korean name.
 */
export function getCourtByName(name: string): CourtInfo | undefined {
  return COURTS.find((c) => c.name === name);
}
