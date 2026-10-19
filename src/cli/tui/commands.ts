export interface Command {
  name: string;
  description: string;
}

export const commands: Command[] = [
  { name: "work", description: "Tasks, Automations & Goals" },
  { name: "config", description: "Configuration" },
  { name: "evolution", description: "Evolution audit" },
  { name: "webhooks", description: "Webhook triggers" },
  { name: "memories", description: "Memory browser" },
  { name: "strategies", description: "Strategy lab" },
  { name: "plugins", description: "Plugin management" },
  { name: "roles", description: "Role management" },
  { name: "artifacts", description: "Browse artifacts across tasks" },
  { name: "settings", description: "Runtime settings" },
  { name: "back", description: "Return to chat" },
  { name: "quit", description: "Exit TUI" },
];

export function filterCommands(query: string): Command[] {
  const q = query.toLowerCase();
  return commands.filter((c) => c.name.startsWith(q));
}

export function findCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name);
}

export function findPrefixMatch(partial: string): Command | undefined {
  const matches = filterCommands(partial.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}
