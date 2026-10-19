import MarkdownIt from "markdown-it";
import { stripMarkdown } from "../../../delivery/format.js";

export interface RenderedEmailContent {
  text: string;
  html: string;
}

const markdown = new MarkdownIt({ html: false, linkify: true });

export function renderEmailContent(markdownText: string): RenderedEmailContent {
  return {
    text: stripMarkdown(markdownText),
    html: markdown.render(markdownText),
  };
}

export function buildEmailSubject(args: { prefix: string; messageType: string; taskId?: string }): string {
  const prefix = args.prefix.trim() || "Adam";
  // Recognize both legacy tags and envelope kinds (Phase 2 translation).
  // After OutboundGateway.send() translates 'report' -> 'status_report' and
  // 'deliver' -> 'result_delivery', the adapter receives the translated value,
  // so we must also branch on the new kinds here.
  if (args.messageType === "report" || args.messageType === "status_report") return `[${prefix} Report]`;
  if (args.messageType === "deliver" || args.messageType === "result_delivery") return `[${prefix} Deliver]`;
  return `[${prefix}]`;
}
