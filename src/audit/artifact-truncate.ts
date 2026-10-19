/**
 * Artifact truncation helpers shared between prompt-assembler and contract-verifier.
 * Head/tail truncation caps each embedded artifact at 32KB (DP-001).
 */

function formatBytes(n: number): string {
  return n.toLocaleString();
}

const MAX_ARTIFACT_BYTES = 32 * 1024;
const HEAD_BYTES = 16 * 1024;
const TAIL_BYTES = 8 * 1024;

/**
 * Truncate artifact content to at most 32KB using head+tail pattern.
 * Binary/non-text files are returned as a metadata stub (no truncation needed).
 *
 * Returns [content, truncated] where `truncated` is true when content was reduced.
 */
export function truncateArtifactContent(
  content: string,
  fullByteSize: number,
): [content: string, truncated: boolean] {
  if (fullByteSize <= MAX_ARTIFACT_BYTES) {
    return [content, false];
  }

  const head = content.slice(0, HEAD_BYTES);
  // Find a safe cut point near HEAD_BYTES (end of line)
  const safeHead = head.slice(0, Math.max(0, head.lastIndexOf("\n")));
  const tail = content.slice(Math.max(0, content.length - TAIL_BYTES));
  return [
    `${safeHead}\n<TRUNCATED reason="size_cap_32KB" full_size="${formatBytes(fullByteSize)}" truncated_bytes="${formatBytes(fullByteSize - Buffer.byteLength(safeHead + tail, "utf8"))}"/>\n${tail}`,
    true,
  ];
}
