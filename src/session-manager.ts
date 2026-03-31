/**
 * session-manager.ts
 *
 * Manages browser session lifecycle with automatic re-login on session expiry.
 *
 * Key responsibilities:
 *   - Wraps page navigation to detect session expiry mid-scraping
 *   - Transparently re-authenticates when cookies expire
 *   - Retries failed navigations after successful re-login
 *   - Refreshes storageState after each successful re-login
 *   - Provides a resilient page wrapper for use by the scraper
 *
 * Usage:
 *   const sm = await SessionManager.create();
 *   await sm.navigateTo("/fmcs/125?ym=2026-04");  // auto re-login if needed
 *   // ... use sm.page for scraping ...
 *   await sm.close();
 */

import type { Browser, BrowserContext, Page } from "playwright";
import {
  launchBrowser,
  isSessionValid,
  performLogin,
  saveSession,
  clearStorageState,
  hasValidStorageState,
} from "./login.js";
import { BASE_URL, PATHS, TIMEOUTS } from "./config.js";
import { logger } from "./logger.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum number of re-login attempts before giving up */
const MAX_RELOGIN_ATTEMPTS = 3;

/** Delay between re-login attempts (ms) */
const RELOGIN_RETRY_DELAY_MS = 3_000;

/** Indicators in page content/URL that signal an expired session */
const SESSION_EXPIRED_INDICATORS = {
  urlPatterns: ["/bbs/login.php", "login.php", "member/login"],
  pageTextPatterns: [
    "로그인이 필요합니다",
    "세션이 만료",
    "로그인 후 이용",
    "로그인해 주세요",
    "다시 로그인",
  ],
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NavigateOptions {
  /** Playwright waitUntil option */
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  /** Navigation timeout in ms */
  timeout?: number;
  /** Whether to check for session expiry after navigation (default: true) */
  checkSession?: boolean;
  /** Number of retries on session expiry (default: MAX_RELOGIN_ATTEMPTS) */
  maxRetries?: number;
}

// ─── SessionManager ─────────────────────────────────────────────────────────

export class SessionManager {
  private browser: Browser;
  private context: BrowserContext;
  private _page: Page;
  private reloginCount = 0;
  private lastReloginTime = 0;

  private constructor(browser: Browser, context: BrowserContext, page: Page) {
    this.browser = browser;
    this.context = context;
    this._page = page;
  }

  /** The current Playwright page (may change after re-login) */
  get page(): Page {
    return this._page;
  }

  /**
   * Create and initialize a SessionManager with an authenticated session.
   *
   * Flow:
   *   1. Launch browser (loads storageState if available)
   *   2. Validate session
   *   3. Perform login if session is invalid
   *   4. Return ready-to-use SessionManager
   */
  static async create(): Promise<SessionManager> {
    const { browser, context, page } = await launchBrowser();
    const sm = new SessionManager(browser, context, page);

    // Validate existing session
    if (hasValidStorageState()) {
      const valid = await isSessionValid(page);
      if (valid) {
        await saveSession(context);
        logger.info("[SessionManager] Restored valid session from storage.");
        sm.installDialogHandler();
        return sm;
      }
      logger.info("[SessionManager] Stored session invalid, logging in...");
      clearStorageState();
    } else {
      logger.info("[SessionManager] No stored session, logging in...");
    }

    // Perform initial login
    await sm.doLogin();
    sm.installDialogHandler();
    return sm;
  }

  /**
   * Navigate to a URL with automatic session expiry detection and re-login.
   *
   * If the navigation results in a redirect to the login page or the page
   * shows session-expired content, this method will:
   *   1. Clear the stale storageState
   *   2. Perform a fresh login
   *   3. Retry the original navigation
   *
   * @param urlOrPath - Full URL or path (e.g., "/fmcs/125?ym=2026-04")
   * @param options - Navigation options
   * @returns The page after successful navigation
   */
  async navigateTo(urlOrPath: string, options: NavigateOptions = {}): Promise<Page> {
    const {
      waitUntil = "networkidle",
      timeout = TIMEOUTS.navigation,
      checkSession = true,
      maxRetries = MAX_RELOGIN_ATTEMPTS,
    } = options;

    const fullUrl = urlOrPath.startsWith("http")
      ? urlOrPath
      : `${BASE_URL}${urlOrPath}`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this._page.goto(fullUrl, { waitUntil, timeout });

        // Allow page scripts to run (some sites do JS-based auth redirects)
        await this._page.waitForTimeout(800);

        if (checkSession && this.isSessionExpiredPage()) {
          logger.info(
            `[SessionManager] Session expired detected after navigating to ${urlOrPath} (attempt ${attempt + 1}/${maxRetries + 1})`
          );

          if (attempt < maxRetries) {
            await this.relogin();
            continue; // retry the navigation
          } else {
            throw new Error(
              `Session expired and re-login failed after ${maxRetries + 1} attempts`
            );
          }
        }

        // Navigation successful with valid session
        return this._page;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Check if this is a navigation error that might be session-related
        const isNavError =
          lastError.message.includes("net::ERR_") ||
          lastError.message.includes("Navigation timeout") ||
          lastError.message.includes("Target closed");

        if (isNavError && attempt < maxRetries) {
          logger.warn(
            `[SessionManager] Navigation error (attempt ${attempt + 1}): ${lastError.message}`
          );
          await this.delay(RELOGIN_RETRY_DELAY_MS);

          // If page was closed, we need to recreate it
          if (lastError.message.includes("Target closed")) {
            await this.recreatePage();
          }

          continue;
        }

        // If session expired message in error, try re-login
        if (
          !isNavError &&
          this.isSessionExpiredPage() &&
          attempt < maxRetries
        ) {
          await this.relogin();
          continue;
        }

        throw lastError;
      }
    }

    throw lastError ?? new Error("Navigation failed after all retries");
  }

  /**
   * Check the current page to see if the session has expired.
   * This can be called by external modules after any page interaction
   * to proactively detect session loss.
   */
  async checkAndReloginIfNeeded(): Promise<boolean> {
    if (this.isSessionExpiredPage()) {
      logger.info("[SessionManager] Proactive session check: expired, re-logging in...");
      await this.relogin();
      return true; // session was expired and we re-logged in
    }
    return false; // session is fine
  }

  /**
   * Validate the current session by navigating to a protected page.
   * More thorough than isSessionExpiredPage() but slower.
   */
  async validateSession(): Promise<boolean> {
    return isSessionValid(this._page);
  }

  /**
   * Close the browser and clean up resources.
   */
  async close(): Promise<void> {
    try {
      await this.browser.close();
      logger.info("[SessionManager] Browser closed.");
    } catch (err) {
      logger.warn(
        "[SessionManager] Error closing browser:",
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Save the current session state to disk.
   * Should be called after successful scraping to keep session fresh.
   */
  async persistSession(): Promise<void> {
    await saveSession(this.context);
  }

  /** Number of times re-login has been performed in this session */
  get reloginAttempts(): number {
    return this.reloginCount;
  }

  // ─── Private Methods ────────────────────────────────────────────────────

  /**
   * Detect if the currently loaded page indicates a session expiry.
   * Checks URL and visible page content synchronously using cached state.
   */
  private isSessionExpiredPage(): boolean {
    try {
      const currentUrl = this._page.url();

      // Check URL patterns
      for (const pattern of SESSION_EXPIRED_INDICATORS.urlPatterns) {
        if (currentUrl.includes(pattern)) {
          // The login page path /fmcs/130 should only count if we didn't
          // intentionally navigate there
          if (pattern === "/bbs/login.php" && currentUrl === `${BASE_URL}${PATHS.login}`) {
            return true;
          }
          return true;
        }
      }

      return false;
    } catch {
      // If we can't even check the page, assume session might be bad
      return false;
    }
  }

  /**
   * Perform a full re-login sequence:
   *   1. Clear stale storageState
   *   2. Navigate to login page
   *   3. Submit credentials
   *   4. Save new session state
   */
  private async relogin(): Promise<void> {
    this.reloginCount++;
    const now = Date.now();

    // Rate-limit re-login attempts (minimum 10 seconds between attempts)
    const timeSinceLastRelogin = now - this.lastReloginTime;
    if (timeSinceLastRelogin < 10_000 && this.lastReloginTime > 0) {
      const waitMs = 10_000 - timeSinceLastRelogin;
      logger.info(
        `[SessionManager] Throttling re-login, waiting ${waitMs}ms...`
      );
      await this.delay(waitMs);
    }

    logger.info(
      `[SessionManager] Performing re-login (attempt #${this.reloginCount})...`
    );

    // Clear old session
    clearStorageState();

    // Clear browser cookies/storage to avoid stale state conflicts
    try {
      await this.context.clearCookies();
    } catch {
      // Context might be invalid, proceed anyway
    }

    // Attempt login
    const result = await performLogin(this._page, this.context);

    if (!result.success) {
      logger.error(`[SessionManager] Re-login failed: ${result.message}`);
      throw new Error(`Re-login failed: ${result.message}`);
    }

    this.lastReloginTime = Date.now();
    logger.info("[SessionManager] Re-login successful, session refreshed.");

    // Verify the new session
    const valid = await isSessionValid(this._page);
    if (!valid) {
      logger.warn(
        "[SessionManager] Session validation failed after re-login, but proceeding..."
      );
    }
  }

  /**
   * Perform initial login (used during create()).
   */
  private async doLogin(): Promise<void> {
    const result = await performLogin(this._page, this.context);
    if (!result.success) {
      await this.browser.close();
      throw new Error(`Initial login failed: ${result.message}`);
    }
    logger.info("[SessionManager] Initial login successful.");
  }

  /**
   * Install a dialog handler to auto-dismiss alert() popups.
   * Korean sites often use alert() for session expiry notifications.
   */
  private installDialogHandler(): void {
    this._page.on("dialog", async (dialog) => {
      const message = dialog.message();
      logger.info(`[SessionManager] Dialog detected: "${message}"`);

      // Check if the dialog indicates session expiry
      const isSessionDialog = SESSION_EXPIRED_INDICATORS.pageTextPatterns.some(
        (pattern) => message.includes(pattern)
      );

      if (isSessionDialog) {
        logger.info(
          "[SessionManager] Session expiry dialog detected, will re-login after dismissal."
        );
      }

      // Always dismiss the dialog to prevent blocking
      await dialog.dismiss().catch(() => dialog.accept().catch(() => {}));
    });
  }

  /**
   * Recreate the page within the existing context.
   * Used when the page gets closed unexpectedly.
   */
  private async recreatePage(): Promise<void> {
    try {
      this._page = await this.context.newPage();

      // Re-apply stealth settings
      await this._page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => false,
        });
      });

      this.installDialogHandler();
      logger.info("[SessionManager] Page recreated.");
    } catch (err) {
      logger.error(
        "[SessionManager] Failed to recreate page:",
        err instanceof Error ? err.message : err
      );
      throw err;
    }
  }

  /**
   * Promise-based delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─── Convenience export ─────────────────────────────────────────────────────

/**
 * Create and return an authenticated SessionManager.
 * This is the recommended entry point for the scraper.
 */
export async function createSessionManager(): Promise<SessionManager> {
  return SessionManager.create();
}
