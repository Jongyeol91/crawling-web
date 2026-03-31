import "dotenv/config";
import path from "node:path";

/** Target tennis courts (excludes 오륜 - under construction) */
export const TARGET_COURTS = ["성내천", "송파", "오금공원"] as const;
export type CourtName = (typeof TARGET_COURTS)[number];

/** Base URL for the Songpa sports portal */
export const BASE_URL = "https://spc.esongpa.or.kr";

/** Paths used in the scraper */
export const PATHS = {
  login: "/bbs/login.php",
  /** Any court calendar page — used for session validation */
  sessionCheck: "/page/rent/s05.od.list.php",
} as const;

/** Browser storage state file for session persistence */
export const STORAGE_STATE_PATH = path.resolve(
  process.cwd(),
  "storage-state.json"
);

/** Polling interval in milliseconds (5 minutes) */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Minimum evening hour for weekday filtering (18:00+) */
export const WEEKDAY_MIN_HOUR = 18;

/** Credentials from environment */
export const CREDENTIALS = {
  userId: process.env.SPC_USER_ID ?? "",
  password: process.env.SPC_PASSWORD ?? "",
};

/** Slack webhook URL from environment */
export const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? "";

/** Browser launch options for stealth */
export const BROWSER_OPTIONS = {
  headless: true,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
  ],
} as const;

/** Navigation timeouts */
export const TIMEOUTS = {
  navigation: 30_000,
  element: 10_000,
  action: 5_000,
} as const;

/** Log configuration */
export const LOG_CONFIG = {
  /** Directory for log files */
  logDir: path.resolve(process.cwd(), "logs"),
  /** Number of days to retain log files */
  retentionDays: 7,
  /** Maximum log file size in bytes (10MB) */
  maxFileSize: 10 * 1024 * 1024,
} as const;
