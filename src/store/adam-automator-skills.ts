/**
 * Seed initial Skill files under the adam-automator Role's workspace.
 * Idempotent — skips if SKILL.md already exists for a given skill name.
 */
export async function seedAdamAutomatorSkills(roleId: string): Promise<void> {
  const { ensureRoleWorkspace } = await import("./role-workspace.js");
  const { getRole } = await import("./roles.js");
  const { mkdir, readFile, writeFile, access } = await import("fs/promises");
  const { join } = await import("path");

  const role = getRole(roleId);
  if (!role) {
    throw new Error(`Role '${roleId}' not found`);
  }

  const workspace = ensureRoleWorkspace(role);
  const skillsDir = join(workspace, ".claude", "skills");
  await mkdir(skillsDir, { recursive: true });

  const skills = [
    {
      name: "aggregate_feature",
      description: "Aggregate a feature value over a window",
      inputs: [
        { name: "feature_name", desc: "Name of the feature to aggregate" },
        { name: "aggregation", desc: "Aggregation type: sum | avg | count | latest" },
        { name: "window_days", desc: "Number of days to look back" },
        { name: "field", desc: "Event payload field to aggregate" },
      ],
      body: "Query events via sqlite3, compute aggregation, print numeric result.",
    },
    {
      name: "check_threshold",
      description: "Compare a value vs threshold, emit breach if exceeded",
      inputs: [
        { name: "feature", desc: "Feature value (number)" },
        { name: "operator", desc: "Comparison operator: gt | gte | lt | lte | eq" },
        { name: "threshold", desc: "Threshold value" },
        { name: "on_breach_type", desc: "Event type to emit on breach" },
        { name: "on_breach_payload", desc: "JSON payload for breach event" },
      ],
      body: "Read feature value, compare against threshold using the operator. On breach, emit new event via emit_event Skill.",
    },
    {
      name: "query_events",
      description: "Range-query events table",
      inputs: [
        { name: "type_pattern", desc: "Event type pattern (e.g. 'scheduler.tick')" },
        { name: "window", desc: "Lookback window in hours" },
        { name: "limit", desc: "Maximum number of events to return" },
      ],
      body: "sqlite3 parameterized query against the events table, returning matching rows as JSON.",
    },
    {
      name: "query_state",
      description: "Read latest state_snapshot (not yet available)",
      inputs: [{ name: "select", desc: "Dot-notation path to select (e.g. 'goals.active')" }],
      body: `Returns { state: null, available: false } — state_snapshot table not yet built (deferred to Phase 2).

When the state_snapshot table is available, this Skill will query it for the latest snapshot matching the select path and return the value.`,
    },
    {
      name: "query_goals",
      description: "Read active goals (goal_graph_nodes not built)",
      inputs: [
        { name: "types", desc: "Goal type filter (e.g. 'daily|weekly')" },
        { name: "status", desc: "Goal status filter: active | completed | paused" },
      ],
      body: `Returns { goals: [], available: false } — goal_graph_nodes table not yet built (deferred to Phase 2).

When the goal_graph_nodes table is available, this Skill will query the goals table for active goals matching the type and status filters.`,
    },
    {
      name: "classify_route",
      description: "Match event vs rules, print action name",
      inputs: [
        { name: "routes_json", desc: "JSON array of routing rules [{pattern, action}]" },
        { name: "fallback", desc: "Fallback action if no pattern matches" },
      ],
      body: "Iterate rules in order, first deep-equal pattern match wins, print the action name. If no match, print the fallback.",
    },
    {
      name: "persist_artifact",
      description: "Write content to iCloud output path",
      inputs: [
        { name: "artifact_type", desc: "Artifact type (subdirectory name)" },
        { name: "content", desc: "Content to write" },
        { name: "user_day", desc: "User day string (e.g. '2026-04-16')" },
      ],
      body: `Write content to ~/Library/Mobile Documents/com~apple~CloudDocs/Adam/Outputs/<artifact_type>/<user_day>.md

NOTE: output_artifacts DB table not yet created (deferred to Phase 2). File write is performed but no DB row is inserted.`,
    },
    {
      name: "emit_event",
      description: "Insert new events row + emit event_fired via OutboundGateway webhook",
      inputs: [
        { name: "type", desc: "Event type string (e.g. 'threshold.breach')" },
        { name: "payload", desc: "Event payload as JSON string" },
        { name: "dedup_key", desc: "Optional deduplication key" },
      ],
      body: "POST to the configured webhook URL for the target event def, or use the internal createEvent API to insert a row directly.",
    },
  ];

  for (const skill of skills) {
    const skillDir = join(skillsDir, skill.name);
    const skillFile = join(skillDir, "SKILL.md");

    // Idempotent — skip if already exists
    try {
      await access(skillFile);
      continue;
    } catch {
      // File doesn't exist, create it
    }

    await mkdir(skillDir, { recursive: true });
    const content = formatSkillMd(skill);
    await writeFile(skillFile, content, "utf8");
  }
}

interface SkillDef {
  name: string;
  description: string;
  inputs: Array<{ name: string; desc: string }>;
  body: string;
}

function formatSkillMd(skill: SkillDef): string {
  const inputsMd = skill.inputs
    .map((i) => `- ${i.name}: ${i.desc}`)
    .join("\n");

  return `---
description: ${skill.description}
---
# ${skill.name}

## Inputs
${inputsMd}

## Instructions
${skill.body}
`;
}
