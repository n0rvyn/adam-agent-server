/**
 * Playwright browser automation tools (D-013).
 *
 * These tools run in the skill execution process alongside the SDK session.
 *
 * Tools: browser_navigate, browser_click, browser_type, browser_screenshot,
 *        browser_evaluate, browser_snapshot
 *
 * Sensitive tools (D-015): browser_click, browser_type, browser_evaluate
 * require user approval via approvalRequired patterns.
 */

import {
  checkPlaywrightAvailable,
  createTaskContext,
  destroyTaskContext,
  getPage,
  hasActiveContext,
} from "./browser-manager.js";
import { getLogger } from "../../lib/logger.js";

const log = getLogger("admin");

export interface PlaywrightToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export const PLAYWRIGHT_TOOLS = new Set([
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_evaluate",
  "browser_snapshot",
]);

// D-015: Sensitive tools that require user approval
export const SENSITIVE_PLAYWRIGHT_TOOLS = new Set([
  "browser_click",
  "browser_type",
  "browser_evaluate",
]);

async function ensureContext(): Promise<PlaywrightToolResult | null> {
  if (!hasActiveContext()) {
    const available = await checkPlaywrightAvailable();
    if (!available) {
      return { success: false, error: "Playwright not installed. Run: npm install playwright && npx playwright install chromium" };
    }
    const created = await createTaskContext();
    if (!created) {
      return { success: false, error: "Failed to create browser context" };
    }
  }
  return null;
}

export async function browserNavigate(url: string): Promise<PlaywrightToolResult> {
  const err = await ensureContext();
  if (err) return err;

  try {
    const page = getPage()!;
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return {
      success: true,
      data: { url: page.url(), status: response?.status(), title: await page.title() },
    };
  } catch (e) {
    return { success: false, error: `Navigation failed: ${(e as Error).message}` };
  }
}

export async function browserClick(selector: string): Promise<PlaywrightToolResult> {
  const err = await ensureContext();
  if (err) return err;

  try {
    const page = getPage()!;
    await page.click(selector, { timeout: 10000 });
    return { success: true, data: { clicked: selector, url: page.url() } };
  } catch (e) {
    return { success: false, error: `Click failed: ${(e as Error).message}` };
  }
}

export async function browserType(selector: string, text: string): Promise<PlaywrightToolResult> {
  const err = await ensureContext();
  if (err) return err;

  try {
    const page = getPage()!;
    await page.fill(selector, text, { timeout: 10000 });
    return { success: true, data: { selector, textLength: text.length } };
  } catch (e) {
    return { success: false, error: `Type failed: ${(e as Error).message}` };
  }
}

export async function browserScreenshot(path?: string): Promise<PlaywrightToolResult> {
  const err = await ensureContext();
  if (err) return err;

  try {
    const page = getPage()!;
    const buffer = await page.screenshot({ fullPage: true, path });
    return {
      success: true,
      data: {
        size: buffer.length,
        path: path ?? "(in-memory)",
        url: page.url(),
      },
    };
  } catch (e) {
    return { success: false, error: `Screenshot failed: ${(e as Error).message}` };
  }
}

export async function browserEvaluate(expression: string): Promise<PlaywrightToolResult> {
  const err = await ensureContext();
  if (err) return err;

  try {
    const page = getPage()!;
    const result = await page.evaluate(expression);
    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: `Evaluate failed: ${(e as Error).message}` };
  }
}

export async function browserSnapshot(): Promise<PlaywrightToolResult> {
  const err = await ensureContext();
  if (err) return err;

  try {
    const page = getPage()!;
    const content = await page.content();
    const title = await page.title();
    const url = page.url();
    return {
      success: true,
      data: {
        url,
        title,
        contentLength: content.length,
        // Return truncated HTML for reasonable output size
        html: content.slice(0, 10000),
      },
    };
  } catch (e) {
    return { success: false, error: `Snapshot failed: ${(e as Error).message}` };
  }
}

/**
 * Execute a Playwright tool by name.
 */
export async function executePlaywrightTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<PlaywrightToolResult> {
  switch (toolName) {
    case "browser_navigate":
      return browserNavigate(args.url as string);
    case "browser_click":
      return browserClick(args.selector as string);
    case "browser_type":
      return browserType(args.selector as string, args.text as string);
    case "browser_screenshot":
      return browserScreenshot(args.path as string | undefined);
    case "browser_evaluate":
      return browserEvaluate(args.expression as string);
    case "browser_snapshot":
      return browserSnapshot();
    default:
      return { success: false, error: `Unknown Playwright tool: ${toolName}` };
  }
}
