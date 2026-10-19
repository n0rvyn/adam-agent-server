import chalk from "chalk";

export const colors = {
  connected: chalk.green,
  disconnected: chalk.red,
  warning: chalk.yellow,

  reasoning: chalk.gray,
  toolCall: chalk.blue,
  toolResult: chalk.green,
  error: chalk.red,

  dim: chalk.dim,
  bold: chalk.bold,

  statusUp: chalk.green("●"),
  statusDown: chalk.red("●"),
};

export const spacing = {
  xs: 1,
  sm: 2,
  md: 4,
  lg: 8,
};

export const layout = {
  statusBarHeight: 2,
  inputBarHeight: 1,
};
