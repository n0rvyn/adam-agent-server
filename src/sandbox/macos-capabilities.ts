import {
  AUTOMATION_TARGET_BUNDLE_ID_RE,
  normalizeRoleOsCapabilities,
  type RoleOsCapability,
} from "../shared/os-capabilities.js";

const ACCESSIBILITY_PREFERENCE_DOMAINS = [
  "com.apple.Accessibility",
  "com.apple.CoreGraphics",
  "com.apple.SpeakSelection",
  "com.apple.TimeMachine",
  "com.apple.assistant",
  "com.apple.assistant.backedup",
  "com.apple.assistant.support",
] as const;

const AUTOMATION_MACH_LOOKUP_SERVICES = [
  "com.apple.coreservices.appleevents",
] as const;

export function validateSbplBundleId(bundleId: string): void {
  if (!AUTOMATION_TARGET_BUNDLE_ID_RE.test(bundleId)) {
    throw new Error(`Invalid bundle id for SBPL appleevent destination: ${bundleId}`);
  }
}

function findCapability(
  osCapabilities: RoleOsCapability[] | undefined,
  id: RoleOsCapability["id"],
): RoleOsCapability | undefined {
  return normalizeRoleOsCapabilities(osCapabilities)?.find((entry) => entry.id === id);
}

function generateAutomationRules(entry: RoleOsCapability | undefined): string {
  if (!entry) return "";

  const lines = [
    "",
    "; ===== Role OS capability: Automation =====",
    "(allow lsopen)",
    "(allow mach-lookup",
    ...AUTOMATION_MACH_LOOKUP_SERVICES.map((service) => `  (global-name "${service}")`),
    ")",
  ];

  const targets = entry.targets ?? [];
  for (const target of targets) {
    validateSbplBundleId(target);
    lines.push(`(allow appleevent-send (appleevent-destination "${target}"))`);
  }

  return lines.join("\n");
}

function generateAccessibilityRules(entry: RoleOsCapability | undefined): string {
  if (!entry) return "";

  const lines = [
    "",
    "; ===== Role OS capability: Accessibility =====",
    "(allow signal)",
    "(allow mach-priv-host-port)",
    "(allow mach-task-name)",
    '(allow mach-lookup (local-name "com.apple.axserver"))',
    "(allow user-preference-read",
    ...ACCESSIBILITY_PREFERENCE_DOMAINS.map((domain) => `  (preference-domain "${domain}")`),
    ")",
  ];

  return lines.join("\n");
}

export function generateCapabilityRules(
  osCapabilities: RoleOsCapability[] | undefined,
): string {
  const normalized = normalizeRoleOsCapabilities(osCapabilities);
  if (!normalized?.length) return "";

  return [
    generateAutomationRules(findCapability(normalized, "automation")),
    generateAccessibilityRules(findCapability(normalized, "accessibility")),
  ]
    .filter(Boolean)
    .join("\n");
}
