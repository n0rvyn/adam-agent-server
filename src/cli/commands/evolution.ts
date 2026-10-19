import chalk from "chalk";
import { request } from "../client.js";

interface EvolutionRecord {
  id: string;
  timestamp: number;
  oldRules: string;
  newRules: string;
  diff: string;
  triggerTaskId?: string;
}

export async function evolutionHandler(options: { limit?: string }): Promise<void> {
  try {
    const limit = options.limit ?? "20";
    const records = await request<EvolutionRecord[]>(`/evolution-audit?limit=${limit}`);

    if (records.length === 0) {
      console.log(chalk.dim("No evolution records yet"));
      return;
    }

    console.log(chalk.bold(`Evolution Audit Log (${records.length} records)\n`));

    for (const record of records) {
      const date = new Date(record.timestamp).toLocaleString();
      console.log(chalk.bold(`[${date}]`) + (record.triggerTaskId ? chalk.dim(` task: ${record.triggerTaskId.slice(0, 8)}`) : ""));
      console.log(chalk.dim("  Diff:"));
      for (const line of record.diff.split("\n")) {
        if (line.startsWith("+")) {
          console.log(chalk.green(`    ${line}`));
        } else if (line.startsWith("-")) {
          console.log(chalk.red(`    ${line}`));
        } else {
          console.log(chalk.dim(`    ${line}`));
        }
      }
      console.log();
    }
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}
