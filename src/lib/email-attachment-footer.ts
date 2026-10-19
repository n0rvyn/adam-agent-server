export function appendDroppedAttachmentsFooter(
  body: string,
  dropped: Array<{ filename: string; sizeBytes: number }>,
  capBytes: number,
  recipientDomain: string,
): string {
  if (dropped.length === 0) return body;
  const capMB = (capBytes / (1024 * 1024)).toFixed(1);
  const lines = dropped.map((d) => `- ${d.filename} (${formatBytes(d.sizeBytes)})`);
  const separator = body.endsWith("---\n") || body.endsWith("---") ? "" : "\n\n---";
  return `${body}${separator}\n⚠️ 因 ${recipientDomain} 邮箱 ${capMB}MB 上限，以下产物未附：\n${lines.join("\n")}\n`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
