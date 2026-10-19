/**
 * Per-task browser context lifecycle management.
 * Each task gets its own BrowserContext; cleaned up on task completion.
 * D-013: Playwright as tool plugin.
 * DP-004: Playwright is user-installed; dynamic import with graceful fallback.
 */

import { getLogger } from "../../lib/logger.js";

const log = getLogger("admin");

// Dynamic references — no static import of playwright (DP-004: user installs separately)
let playwrightModule: any = null;
let browser: any = null;
let currentContext: any = null;
let currentPage: any = null;

/**
 * Check if Playwright is available (DP-004: user installs separately).
 */
export async function checkPlaywrightAvailable(): Promise<boolean> {
  try {
    // @ts-expect-error — playwright is an optional peer dependency (DP-004)
    playwrightModule = await import("playwright");
    return true;
  } catch {
    log.error(
      "Playwright is not installed. Install with: npm install playwright && npx playwright install chromium",
    );
    return false;
  }
}

/**
 * Create a new browser context for a task.
 * @param headless - default true; set false for debug mode
 */
export async function createTaskContext(headless = true): Promise<boolean> {
  if (!playwrightModule) {
    const available = await checkPlaywrightAvailable();
    if (!available) return false;
  }

  try {
    if (!browser) {
      browser = await playwrightModule.chromium.launch({ headless });
    }
    currentContext = await browser.newContext();
    currentPage = await currentContext.newPage();
    log.info({ headless }, "Browser context created for task");
    return true;
  } catch (err) {
    log.error({ error: err }, "Failed to create browser context");
    return false;
  }
}

/**
 * Clean up browser context after task completion.
 * No state leakage between tasks.
 */
export async function destroyTaskContext(): Promise<void> {
  try {
    if (currentPage) {
      await currentPage.close().catch(() => {});
      currentPage = null;
    }
    if (currentContext) {
      await currentContext.close().catch(() => {});
      currentContext = null;
    }
    log.debug("Browser context destroyed");
  } catch (err) {
    log.warn({ error: err }, "Error destroying browser context");
  }
}

/**
 * Close the browser entirely (on process shutdown).
 */
export async function closeBrowser(): Promise<void> {
  await destroyTaskContext();
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

export function getPage(): any {
  return currentPage;
}

export function hasActiveContext(): boolean {
  return currentPage !== null;
}
