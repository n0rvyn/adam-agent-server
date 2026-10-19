/**
 * Format adapter — auto-adapts task results per channel platform type (D-007).
 */

/**
 * Format task result for the target channel platform.
 */
export function formatForChannel(result: string, platform: string, taskId?: string): string {
  switch (platform) {
    case "wechat":
      return stripMarkdown(result);
    case "telegram":
      return result; // Telegram supports Markdown natively
    case "slack":
      return toSlackMrkdwn(result);
    case "email":
      return result;
    case "webhook":
      return JSON.stringify({
        result,
        taskId,
        timestamp: new Date().toISOString(),
      });
    default:
      return stripMarkdown(result);
  }
}

/**
 * Strip Markdown formatting for plain-text channels (WeChat, SMS, etc.).
 */
export function stripMarkdown(text: string): string {
  return text
    // Remove headers
    .replace(/^#{1,6}\s+/gm, "")
    // Remove bold/italic
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    // Remove inline code
    .replace(/`([^`]+)`/g, "$1")
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```\w*\n?/g, "").trim())
    // Remove links, keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Remove images
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    // Clean up multiple blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert standard Markdown to Slack mrkdwn format.
 */
function toSlackMrkdwn(text: string): string {
  return text
    // Bold: **text** → *text*
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    // Italic: *text* or _text_ → _text_ (Slack uses _ for italic)
    // Links: [text](url) → <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
}
