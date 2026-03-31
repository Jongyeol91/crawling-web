/**
 * login.ts
 *
 * Handles authentication to spc.esongpa.or.kr using Playwright browser automation.
 *
 * Features:
 *   - Logs in via the FMCS login page (/fmcs/130) using credentials from env vars
 *   - Persists session via Playwright storageState (cookies + localStorage)
 *   - Restores session from storageState file to avoid repeated logins
 *   - Auto re-login on session expiry detection
 *   - Stealth: uses realistic user-agent, viewport, and human-like delays
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import {
  BASE_URL,
  PATHS,
  STORAGE_STATE_PATH,
  CREDENTIALS,
  BROWSER_OPTIONS,
  TIMEOUTS,
} from "./config.js";
import { COURTS } from "./courts.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoginResult {
  success: boolean;
  message: string;
  context?: BrowserContext;
  page?: Page;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Small random delay to mimic human typing / interaction */
function randomDelay(minMs = 100, maxMs = 400): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Maximum age for storage state file before requiring re-validation (4 hours).
 *  The actual session validity is checked via isSessionValid(), so this is just
 *  a safety net to avoid loading extremely stale state files. */
const MAX_STORAGE_STATE_AGE_MS = 4 * 60 * 60 * 1000;

/** Check whether a saved storageState file exists, is recent, and is valid JSON. */
export function hasValidStorageState(): boolean {
  try {
    if (!fs.existsSync(STORAGE_STATE_PATH)) return false;
    const stat = fs.statSync(STORAGE_STATE_PATH);

    // Check file age — use a generous TTL since we validate the session separately
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > MAX_STORAGE_STATE_AGE_MS) {
      logger.info(
        `[Session] Storage state is ${Math.round(ageMs / 60_000)}min old (max ${MAX_STORAGE_STATE_AGE_MS / 60_000}min), will re-validate.`
      );
      return false;
    }

    // Check file size (empty or trivially small files are invalid)
    if (stat.size < 10) {
      logger.info("[Session] Storage state file is too small, ignoring.");
      return false;
    }

    // Validate JSON structure
    const content = fs.readFileSync(STORAGE_STATE_PATH, "utf-8");
    const parsed = JSON.parse(content);
    // Playwright storageState must have cookies and origins arrays
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
      logger.info("[Session] Storage state has invalid structure, ignoring.");
      return false;
    }

    return true;
  } catch (err) {
    logger.warn("[Session] Error reading storage state:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Save the current browser context's session state (cookies + localStorage)
 * to the storageState file. Should be called after successful login and
 * periodically after successful page interactions to keep the session fresh.
 */
export async function saveSession(context: BrowserContext): Promise<void> {
  try {
    await context.storageState({ path: STORAGE_STATE_PATH });
    logger.info(`[Session] Session state saved to ${STORAGE_STATE_PATH}`);
  } catch (err) {
    logger.error(
      "[Session] Failed to save session state:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Delete the stored session state file. Called when session is confirmed
 * invalid to ensure a clean re-login on the next attempt.
 */
export function clearStorageState(): void {
  try {
    if (fs.existsSync(STORAGE_STATE_PATH)) {
      fs.unlinkSync(STORAGE_STATE_PATH);
      logger.info("[Session] Cleared stale storage state file.");
    }
  } catch (err) {
    logger.warn(
      "[Session] Error clearing storage state:",
      err instanceof Error ? err.message : err
    );
  }
}

// ---------------------------------------------------------------------------
// Core: launch browser with or without existing session
// ---------------------------------------------------------------------------

/**
 * Launch a Playwright Chromium browser and create a context.
 * If a valid storageState file exists, it will be loaded to restore the session.
 */
export async function launchBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const browser = await chromium.launch({
    headless: BROWSER_OPTIONS.headless,
    args: [...BROWSER_OPTIONS.args],
  });

  const contextOptions: Parameters<Browser["newContext"]>[0] = {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true,
  };

  // Restore session cookies if available
  const useStoredSession = hasValidStorageState();
  if (useStoredSession) {
    logger.info("[Session] Restoring session from storageState...");
    contextOptions.storageState = STORAGE_STATE_PATH;
  }

  let context: BrowserContext;
  try {
    context = await browser.newContext(contextOptions);
  } catch (err) {
    // If loading storageState fails (corrupt file), fall back to fresh context
    if (useStoredSession) {
      logger.warn(
        "[Session] Failed to load storageState, starting fresh context:",
        err instanceof Error ? err.message : err
      );
      clearStorageState();
      delete contextOptions.storageState;
      context = await browser.newContext(contextOptions);
    } else {
      throw err;
    }
  }
  const page = await context.newPage();

  // Stealth: mask webdriver property
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => false,
    });
  });

  return { browser, context, page };
}

// ---------------------------------------------------------------------------
// Session validation
// ---------------------------------------------------------------------------

/**
 * Check if the current session is still valid by navigating to a
 * page that requires authentication and inspecting the result.
 *
 * The site typically redirects unauthenticated users to the login page
 * or shows a login prompt / alert.
 */
export async function isSessionValid(page: Page): Promise<boolean> {
  try {
    // Navigate to a court calendar page that requires login
    await page.goto(`${BASE_URL}${PATHS.sessionCheck}`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUTS.navigation,
    });

    await page.waitForTimeout(1500);

    const currentUrl = page.url();

    // If redirected to login page, session is invalid
    if (currentUrl.includes("login")) {
      logger.info("[Login] Session expired — redirected to login page.");
      return false;
    }

    // Check if the page has a "로그아웃" link (means we're logged in)
    const logoutLink = await page
      .$('a[href*="logout"]')
      .catch(() => null);
    if (logoutLink) {
      logger.info("[Login] Session is valid (logout link found).");
      return true;
    }

    // Check page content for login form indicators
    const loginForm = await page
      .$('input[type="password"]')
      .catch(() => null);
    if (loginForm) {
      logger.info("[Login] Session expired — login form detected on page.");
      return false;
    }

    // If we see court/reservation content, we're likely logged in
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
    if (bodyText.includes("대관신청") || bodyText.includes("테니스장")) {
      logger.info("[Login] Session is valid (reservation content found).");
      return true;
    }

    logger.info("[Login] Session status uncertain, assuming invalid.");
    return false;
  } catch (error) {
    logger.error("[Login] Session check failed:", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

/**
 * Perform login to spc.esongpa.or.kr using the credentials from environment variables.
 *
 * Steps:
 *   1. Navigate to the login page (/fmcs/130)
 *   2. Fill in user ID and password
 *   3. Submit the form
 *   4. Wait for navigation / confirmation
 *   5. Save storageState for session persistence
 *
 * @param page - The Playwright page to use for login
 * @param context - The browser context (for saving storageState)
 * @returns LoginResult indicating success or failure
 */
export async function performLogin(
  page: Page,
  context: BrowserContext
): Promise<LoginResult> {
  const { userId, password } = CREDENTIALS;

  if (!userId || !password) {
    return {
      success: false,
      message:
        "Missing credentials. Set SPC_USER_ID and SPC_PASSWORD environment variables.",
    };
  }

  logger.info(`[Login] Attempting login for user: ${userId}`);

  try {
    // 1. Navigate to login page
    await page.goto(`${BASE_URL}${PATHS.login}`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUTS.navigation,
    });

    await randomDelay(500, 1000);

    // 2. Find and fill the user ID field
    // Try multiple selectors as the site may use different field names
    const userIdSelectors = [
      'input[name="mb_id"]',
      "#login_id",
      'input[name="user_id"]',
      'input[name="userId"]',
      'input[type="text"][name*="id"]',
      'input[type="text"]',
    ];

    let userIdField = null;
    for (const selector of userIdSelectors) {
      userIdField = await page.$(selector);
      if (userIdField) {
        logger.info(`[Login] Found user ID field with selector: ${selector}`);
        break;
      }
    }

    if (!userIdField) {
      // Take a screenshot for debugging
      await page.screenshot({ path: "debug-login-page.png" }).catch(() => {});
      return {
        success: false,
        message: "Could not find user ID input field on login page.",
      };
    }

    // Clear and type the user ID with human-like typing
    await userIdField.click();
    await randomDelay(100, 300);
    await userIdField.fill("");
    await page.keyboard.type(userId, { delay: 50 + Math.random() * 80 });

    await randomDelay(300, 600);

    // 3. Find and fill the password field
    const passwordSelectors = [
      'input[name="mb_password"]',
      'input[type="password"]',
      'input[name="user_pw"]',
      'input[name="password"]',
    ];

    let passwordField = null;
    for (const selector of passwordSelectors) {
      passwordField = await page.$(selector);
      if (passwordField) {
        logger.info(`[Login] Found password field with selector: ${selector}`);
        break;
      }
    }

    if (!passwordField) {
      return {
        success: false,
        message: "Could not find password input field on login page.",
      };
    }

    await passwordField.click();
    await randomDelay(100, 300);
    await passwordField.fill("");
    await page.keyboard.type(password, { delay: 50 + Math.random() * 80 });

    await randomDelay(300, 600);

    // 4. Submit the form
    // Try clicking a login/submit button first
    const submitSelectors = [
      'input[type="submit"].btn-login',
      'input[type="submit"]',
      'button[type="submit"]',
      ".btn-login",
      'button:has-text("로그인")',
    ];

    let submitted = false;
    for (const selector of submitSelectors) {
      const submitBtn = await page.$(selector);
      if (submitBtn) {
        logger.info(`[Login] Clicking submit button: ${selector}`);
        await randomDelay(200, 500);

        // Use Promise.race to handle both navigation and no-navigation cases
        await Promise.all([
          page
            .waitForNavigation({
              waitUntil: "domcontentloaded",
              timeout: TIMEOUTS.navigation,
            })
            .catch(() => {}),
          submitBtn.click(),
        ]);

        submitted = true;
        break;
      }
    }

    // Fallback: submit via Enter key on password field
    if (!submitted) {
      logger.info("[Login] No submit button found, pressing Enter...");
      await Promise.all([
        page
          .waitForNavigation({
            waitUntil: "domcontentloaded",
            timeout: TIMEOUTS.navigation,
          })
          .catch(() => {}),
        page.keyboard.press("Enter"),
      ]);
    }

    // 5. Wait for post-login page to settle
    await page.waitForTimeout(2000);

    // 6. Check for login failure indicators
    const postLoginUrl = page.url();
    const pageText = await page.evaluate(() => document.body?.innerText ?? "");

    // Check for common error messages
    const errorIndicators = [
      "아이디 또는 비밀번호",
      "로그인 실패",
      "일치하지 않",
      "확인해 주세요",
      "비밀번호가 틀",
      "아이디를 확인",
    ];

    for (const indicator of errorIndicators) {
      if (pageText.includes(indicator)) {
        logger.error(`[Login] Login failed — error text found: "${indicator}"`);
        return {
          success: false,
          message: `Login failed: ${indicator}`,
        };
      }
    }

    // Handle JavaScript alert dialogs that may appear on login failure
    // (already handled by Playwright's default dialog dismissal)

    // Check if still on login page (failure)
    if (postLoginUrl.includes("/bbs/login") || postLoginUrl.includes("login.php")) {
      // Could still be on the login page with an error
      // Check if there's an error message in a dialog or toast
      const alertText = await page
        .evaluate(() => {
          // Some Korean sites put errors in specific elements
          const errorEl =
            document.querySelector(".error_msg") ||
            document.querySelector(".alert_msg") ||
            document.querySelector(".msg_error");
          return errorEl?.textContent?.trim() ?? "";
        })
        .catch(() => "");

      if (alertText) {
        return {
          success: false,
          message: `Login failed: ${alertText}`,
        };
      }

      // If we're still on the login page with no clear error, it might have failed silently
      logger.warn(
        "[Login] Still on login page after submission — login may have failed."
      );
      return {
        success: false,
        message:
          "Login may have failed — still on login page after form submission.",
      };
    }

    // 7. Login appears successful — save session
    logger.info("[Login] Login successful! Saving session state...");
    await saveSession(context);

    return {
      success: true,
      message: `Logged in successfully as ${userId}`,
      context,
      page,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`[Login] Login error: ${errMsg}`);

    // Take debug screenshot
    await page.screenshot({ path: "debug-login-error.png" }).catch(() => {});

    return {
      success: false,
      message: `Login error: ${errMsg}`,
    };
  }
}

// ---------------------------------------------------------------------------
// High-level: ensure authenticated session
// ---------------------------------------------------------------------------

/**
 * Ensures we have an authenticated session. This is the main entry point
 * that other modules should call.
 *
 * Flow:
 *   1. Launch browser (with storageState if available)
 *   2. Check if session is still valid
 *   3. If not valid, perform fresh login
 *   4. Return the authenticated page and context
 *
 * @returns Object with browser, context, and authenticated page
 */
export async function ensureAuthenticated(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const { browser, context, page } = await launchBrowser();

  // Check if the restored session is still valid
  if (hasValidStorageState()) {
    const valid = await isSessionValid(page);
    if (valid) {
      // Re-save session to extend the file's mtime (keeps it "fresh")
      await saveSession(context);
      logger.info("[Login] Using existing authenticated session.");
      return { browser, context, page };
    }
    logger.info("[Login] Stored session is invalid, performing fresh login...");
    clearStorageState();
  } else {
    logger.info("[Login] No valid session found, performing login...");
  }

  // Perform login
  const result = await performLogin(page, context);

  if (!result.success) {
    await browser.close();
    throw new Error(`Authentication failed: ${result.message}`);
  }

  return { browser, context, page };
}

// ---------------------------------------------------------------------------
// Standalone execution — for testing / manual login
// ---------------------------------------------------------------------------

/**
 * Run login as a standalone script: `npx tsx src/login.ts`
 * Useful for initial setup and testing credentials.
 */
async function main() {
  logger.info("=== Songpa Tennis Scraper — Login Test ===\n");

  if (!CREDENTIALS.userId || !CREDENTIALS.password) {
    logger.error(
      "ERROR: Set SPC_USER_ID and SPC_PASSWORD environment variables.\n" +
        "Example:\n" +
        "  export SPC_USER_ID=your_id\n" +
        "  export SPC_PASSWORD=your_password\n"
    );
    process.exit(1);
  }

  let browser: Browser | null = null;

  try {
    const result = await ensureAuthenticated();
    browser = result.browser;

    logger.info("\n✅ Login successful!");
    logger.info(`   Current URL: ${result.page.url()}`);
    logger.info(`   Session saved to: ${STORAGE_STATE_PATH}`);

    // Verify by navigating to a court calendar page
    await result.page.goto(`${BASE_URL}${COURTS[0].calendarPath}`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUTS.navigation,
    });

    logger.info(`   Court page URL: ${result.page.url()}`);
    logger.info("\n   Session is ready for scraping.");
  } catch (error) {
    logger.error(
      "\n❌ Login failed:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Run if executed directly
const isDirectRun =
  process.argv[1]?.endsWith("login.ts") ||
  process.argv[1]?.endsWith("login.js");
if (isDirectRun) {
  main();
}
