import { spawn } from "node:child_process";

export async function writeClipboard(text: string): Promise<boolean> {
  const cmd =
    process.platform === "darwin"
      ? "pbcopy"
      : process.platform === "linux"
        ? "xclip"
        : null;
  if (!cmd) return false;
  return new Promise((resolve) => {
    try {
      const args = process.platform === "linux" ? ["-selection", "clipboard"] : [];
      const proc = spawn(cmd, args);
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
      proc.stdin.write(text);
      proc.stdin.end();
    } catch {
      resolve(false);
    }
  });
}
