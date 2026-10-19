import { createHash } from "node:crypto";
import { existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { RUNTIME_DIR } from "../shared/constants.js";
import { getRole } from "../store/roles.js";
import { getRoleWorkspacePath } from "../store/role-workspace.js";
import { markDeliveryCommitmentFailed } from "../store/assistant-delivery-commitments.js";
import type {
  AssistantDeliveryCommitment,
  ChatAttachment,
  DeliveryArtifactExpectation,
  DeliveryArtifactKind,
  Task,
} from "../shared/types.js";

export interface ResolveDeliverableArtifactsArgs {
  task: Task;
  commitment?: AssistantDeliveryCommitment;
  allowedRoots?: string[];
  deniedReadPaths?: string[];
  markFailedOnEmpty?: boolean;
}

export interface DeliverableResolverDiagnostic {
  path?: string;
  reason: string;
}

export interface ResolveDeliverableArtifactsResult {
  attachments: ChatAttachment[];
  diagnostics: DeliverableResolverDiagnostic[];
}

export function resolveDeliverableArtifacts(
  args: ResolveDeliverableArtifactsArgs,
): ResolveDeliverableArtifactsResult {
  if (!args.commitment || args.commitment.status !== "pending") {
    return { attachments: [], diagnostics: [{ reason: "no_pending_commitment" }] };
  }

  const diagnostics: DeliverableResolverDiagnostic[] = [];
  const roots = args.allowedRoots?.map((root) => path.resolve(root)) ?? defaultAllowedRoots(args.task);
  const deniedRoots = (args.deniedReadPaths ?? []).map((root) => path.resolve(root));
  const files = extractAbsoluteLocalPaths(args.task.result ?? "");
  const attachments: ChatAttachment[] = [];

  for (const filePath of files) {
    const resolved = path.resolve(filePath);
    const diagnostic = validatePath(resolved, roots, deniedRoots, args.commitment.artifactExpectation);
    if (diagnostic) {
      diagnostics.push({ path: resolved, reason: diagnostic });
      continue;
    }
    attachments.push(fileToChatAttachment(resolved));
  }

  if (attachments.length === 0 && args.markFailedOnEmpty !== false) {
    markDeliveryCommitmentFailed(args.commitment.id, "no_deliverable_artifacts", diagnostics.map((item) => ({
      status: "failed",
      filename: item.path ? path.basename(item.path) : undefined,
      error: item.reason,
    })));
  }

  return { attachments, diagnostics };
}

export function extractAbsoluteLocalPaths(text: string): string[] {
  const paths = new Set<string>();
  const pattern = /(?:^|[\s("'`])((?:\/[^\s"'`，。；;、)\]]+)+)/gu;
  for (const match of text.matchAll(pattern)) {
    const candidate = stripTrailingPunctuation(match[1]);
    if (!candidate || candidate.startsWith("//")) continue;
    paths.add(candidate);
  }
  return [...paths];
}

function defaultAllowedRoots(task: Task): string[] {
  const roots = [
    path.join(process.env.ADAM_TEST_DIR || RUNTIME_DIR, "artifacts"),
    path.join(process.env.ADAM_TEST_DIR || RUNTIME_DIR, "template-executions"),
  ];
  if (task.roleId) {
    const role = getRole(task.roleId);
    if (role) roots.push(getRoleWorkspacePath(role.name));
  }
  return roots.map((root) => path.resolve(root));
}

function validatePath(
  filePath: string,
  roots: string[],
  deniedRoots: string[],
  expectation?: DeliveryArtifactExpectation,
): string | undefined {
  if (/^https?:\/\//iu.test(filePath)) return "remote_url";
  if (!path.isAbsolute(filePath)) return "not_absolute";
  if (!existsSync(filePath)) return "missing_file";
  const stat = statSync(filePath);
  if (!stat.isFile()) return "not_file";
  if (!roots.some((root) => isInsideRoot(filePath, root))) return "outside_allowed_roots";
  if (deniedRoots.some((root) => isInsideRoot(filePath, root))) return "denied_read_path";
  const mime = mimeForPath(filePath);
  if (!mime) return "unsupported_mime";
  if (expectation && !mimeMatchesExpectation(mime, expectation.kind)) return "mime_mismatch";
  return undefined;
}

function isInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function fileToChatAttachment(filePath: string): ChatAttachment {
  const stat = statSync(filePath);
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  return {
    artifactId: `local:${hash.slice(0, 16)}`,
    locator: `local://${filePath}`,
    filename: path.basename(filePath),
    mimeType: mimeForPath(filePath) ?? "application/octet-stream",
    size: stat.size,
    contentHash: hash,
  };
}

function mimeForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".zip": "application/zip",
  };
  return map[ext];
}

function mimeMatchesExpectation(mime: string, kind: DeliveryArtifactKind): boolean {
  if (kind === "image") return mime.startsWith("image/");
  if (kind === "audio") return mime.startsWith("audio/");
  if (kind === "video") return mime.startsWith("video/");
  if (kind === "report") return mime === "text/markdown" || mime === "application/pdf" || mime.startsWith("text/");
  if (kind === "file" || kind === "result") return true;
  return false;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[，。；;、,.!?]+$/u, "");
}
