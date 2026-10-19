import { createDeliveryCommitment } from "../store/assistant-delivery-commitments.js";
import type { CapturedDispatch, ChatSource, NotifyTarget } from "../shared/types.js";
import { detectFutureDeliveryCommitments, type CommitmentDetection, type CommitmentLocale } from "./commitment-detector.js";
import { getBlockedFutureDeliveryText } from "./commitment-replacement-text.js";

export interface ApplyFutureDeliveryCommitmentGateArgs {
  text: string;
  traceId?: string;
  sessionId: string;
  source: ChatSource;
  sourceMessageId: string;
  dispatches: CapturedDispatch[];
}

export interface FutureDeliveryCommitmentGateResult {
  text: string;
  createdCommitmentIds: string[];
  blockedReasons: string[];
}

export function applyFutureDeliveryCommitmentGate(
  args: ApplyFutureDeliveryCommitmentGateArgs,
): FutureDeliveryCommitmentGateResult {
  const detections = detectFutureDeliveryCommitments(args.text);
  if (detections.length === 0) {
    return { text: args.text, createdCommitmentIds: [], blockedReasons: [] };
  }

  const createdCommitmentIds: string[] = [];
  const blockedReasons: string[] = [];
  const target = targetFromSource(args.source, args.sessionId);
  const uniqueDispatches = uniqueTaskDispatches(args.dispatches);
  let output = args.text;

  for (const detection of [...detections].sort((a, b) => b.span.start - a.span.start)) {
    if (!target) {
      blockedReasons.push("missing_target");
      output = replaceDetection(output, detection);
      continue;
    }
    if (uniqueDispatches.length !== 1) {
      blockedReasons.push(uniqueDispatches.length === 0 ? "missing_dispatch" : "ambiguous_dispatch");
      output = replaceDetection(output, detection);
      continue;
    }

    const commitment = createDeliveryCommitment({
      traceId: args.traceId ?? uniqueDispatches[0].traceId,
      sessionId: args.sessionId,
      sourceMessageId: args.sourceMessageId,
      taskId: uniqueDispatches[0].taskId,
      target,
      artifactExpectation: detection.artifactExpectation,
    });
    createdCommitmentIds.push(commitment.id);
  }

  const seenLocales = [...new Set(detections.map(d => d.locale))];
  return { text: normalizeBlockedText(output, seenLocales), createdCommitmentIds, blockedReasons };
}

function uniqueTaskDispatches(dispatches: CapturedDispatch[]): CapturedDispatch[] {
  const byTask = new Map<string, CapturedDispatch>();
  for (const dispatch of dispatches) {
    if (!byTask.has(dispatch.taskId)) byTask.set(dispatch.taskId, dispatch);
  }
  return [...byTask.values()];
}

function targetFromSource(source: ChatSource, sessionId: string): NotifyTarget | undefined {
  if (source.type === "channel") {
    if (!source.channelId || !source.chatId) return undefined;
    return { type: "channel", channelId: source.channelId, chatId: source.chatId };
  }
  return { type: "session", sessionId };
}

function replaceDetection(text: string, detection: CommitmentDetection): string {
  const replacement = getBlockedFutureDeliveryText(detection.locale);
  return `${text.slice(0, detection.span.start)}${replacement}${text.slice(detection.span.end)}`;
}

function normalizeBlockedText(text: string, locales: CommitmentLocale[]): string {
  let out = text;
  for (const locale of locales) {
    const r = getBlockedFutureDeliveryText(locale);
    // collapse adjacent periods or repeats
    const escaped = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?:。|\\.)\\s*${escaped}`, "gu"), `。${r}`);
    out = out.replace(new RegExp(`${escaped}(?:。|\\.)`, "gu"), r);
  }
  return out;
}
