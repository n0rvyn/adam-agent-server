import type { SandboxPlatform } from "../sandbox/types.js";

export const OS_CAPABILITY_IDS = [
  "location-services",
  "calendars",
  "contacts",
  "files-and-folders",
  "full-disk-access",
  "homekit",
  "media-and-apple-music",
  "passkeys-access-for-web-browsers",
  "photos",
  "reminders",
  "accessibility",
  "app-management",
  "automation",
  "bluetooth",
  "camera",
  "developer-tools",
  "focus",
  "input-monitoring",
  "local-network",
  "microphone",
  "motion-and-fitness",
  "remote-desktop",
  "screen-and-system-audio-recording",
  "speech-recognition",
] as const;

export type OsCapabilityId = typeof OS_CAPABILITY_IDS[number];

export type OsCapabilityStatus =
  | "runtime-enforced"
  | "host-only"
  | "registered-unwired";

export type DerivedOsCapabilityAvailability =
  | "editable"
  | "host-only"
  | "registered-unwired"
  | "runtime-unavailable"
  | "platform-unsupported";

export interface RoleOsCapability {
  id: OsCapabilityId;
  targets?: string[];
}

export interface OsCapabilityMeta {
  id: OsCapabilityId;
  label: string;
  description: string;
  platform: "darwin";
  status: OsCapabilityStatus;
  supportsTargets?: boolean;
  disabledReason?: string;
}

export interface ResolvedOsCapabilityMeta extends OsCapabilityMeta {
  availability: DerivedOsCapabilityAvailability;
  editable: boolean;
  effectiveDisabledReason?: string;
}

const CAPABILITY_META: Record<OsCapabilityId, OsCapabilityMeta> = {
  "location-services": {
    id: "location-services",
    label: "Location Services",
    description: "Access device location and region context.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  calendars: {
    id: "calendars",
    label: "Calendars",
    description: "Access Calendar data via macOS privacy controls.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  contacts: {
    id: "contacts",
    label: "Contacts",
    description: "Access Contacts data via macOS privacy controls.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  "files-and-folders": {
    id: "files-and-folders",
    label: "Files & Folders",
    description: "Host-level file access categories managed outside Role sandboxing.",
    platform: "darwin",
    status: "host-only",
    disabledReason: "Role file boundaries are already controlled by visiblePaths and deniedReadPaths.",
  },
  "full-disk-access": {
    id: "full-disk-access",
    label: "Full Disk Access",
    description: "Host-level macOS grant for protected storage locations.",
    platform: "darwin",
    status: "host-only",
    disabledReason: "This is a host app permission, not a Role-level control.",
  },
  homekit: {
    id: "homekit",
    label: "HomeKit",
    description: "Access HomeKit devices and home automation data.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  "media-and-apple-music": {
    id: "media-and-apple-music",
    label: "Media & Apple Music",
    description: "Access Apple Music and media library data.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  "passkeys-access-for-web-browsers": {
    id: "passkeys-access-for-web-browsers",
    label: "Passkeys Access for Web Browsers",
    description: "Access passkeys for browser-integrated authentication.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  photos: {
    id: "photos",
    label: "Photos",
    description: "Access the Photos library via macOS privacy controls.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  reminders: {
    id: "reminders",
    label: "Reminders",
    description: "Access Reminder data via macOS privacy controls.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  accessibility: {
    id: "accessibility",
    label: "Accessibility",
    description: "Control desktop UI and accessibility automation surfaces.",
    platform: "darwin",
    status: "runtime-enforced",
  },
  "app-management": {
    id: "app-management",
    label: "App Management",
    description: "Manage or inspect other installed applications.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  automation: {
    id: "automation",
    label: "Automation",
    description: "Launch and control other apps via Apple Events.",
    platform: "darwin",
    status: "runtime-enforced",
    supportsTargets: true,
  },
  bluetooth: {
    id: "bluetooth",
    label: "Bluetooth",
    description: "Access nearby Bluetooth devices.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  camera: {
    id: "camera",
    label: "Camera",
    description: "Capture camera input.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  "developer-tools": {
    id: "developer-tools",
    label: "Developer Tools",
    description: "Use system developer tooling privileges.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  focus: {
    id: "focus",
    label: "Focus",
    description: "Access Focus state and related automation.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  "input-monitoring": {
    id: "input-monitoring",
    label: "Input Monitoring",
    description: "Observe keyboard and input device activity.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  "local-network": {
    id: "local-network",
    label: "Local Network",
    description: "Discover and communicate with devices on the local network.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  microphone: {
    id: "microphone",
    label: "Microphone",
    description: "Capture microphone input.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  "motion-and-fitness": {
    id: "motion-and-fitness",
    label: "Motion & Fitness",
    description: "Access motion and fitness sensor data.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  "remote-desktop": {
    id: "remote-desktop",
    label: "Remote Desktop",
    description: "Control or observe remote desktop sessions.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  "screen-and-system-audio-recording": {
    id: "screen-and-system-audio-recording",
    label: "Screen & System Audio Recording",
    description: "Capture the screen and system audio.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
  "speech-recognition": {
    id: "speech-recognition",
    label: "Speech Recognition",
    description: "Use system speech recognition services.",
    platform: "darwin",
    status: "registered-unwired",
    disabledReason: "Not wired into Adam runtime yet.",
  },
};

export const AUTOMATION_TARGET_BUNDLE_ID_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function isOsCapabilityId(value: string): value is OsCapabilityId {
  return (OS_CAPABILITY_IDS as readonly string[]).includes(value);
}

export function getOsCapabilityMeta(id: OsCapabilityId): OsCapabilityMeta {
  return CAPABILITY_META[id];
}

export function listOsCapabilityMeta(): OsCapabilityMeta[] {
  return OS_CAPABILITY_IDS.map((id) => CAPABILITY_META[id]);
}

export function getResolvedOsCapabilityRegistry(
  platform: SandboxPlatform,
  sandboxAvailable = platform !== "none",
): ResolvedOsCapabilityMeta[] {
  return listOsCapabilityMeta().map((meta) => resolveOsCapabilityMeta(meta, platform, sandboxAvailable));
}

export function resolveOsCapabilityMeta(
  meta: OsCapabilityMeta,
  platform: SandboxPlatform,
  sandboxAvailable = platform !== "none",
): ResolvedOsCapabilityMeta {
  const isMacOSHost = process.platform === "darwin";

  if (!isMacOSHost) {
    return {
      ...meta,
      availability: "platform-unsupported",
      editable: false,
      effectiveDisabledReason: "macOS only",
    };
  }

  // Runtime-enforced capabilities are only truthful toggles when Adam is
  // actually running behind the macOS sandbox backend. A plain "darwin host"
  // check is not enough: when the provider falls back to NoopSandboxProvider,
  // ExecutionManager bypasses OS-level enforcement entirely.
  if (meta.status === "runtime-enforced" && (platform !== "sandbox-exec" || !sandboxAvailable)) {
    return {
      ...meta,
      availability: "runtime-unavailable",
      editable: false,
      effectiveDisabledReason: "Current runtime has no macOS sandbox backend; Adam cannot enforce this capability on Roles.",
    };
  }

  if (meta.status === "runtime-enforced") {
    return {
      ...meta,
      availability: "editable",
      editable: true,
    };
  }

  return {
    ...meta,
    availability: meta.status,
    editable: false,
    effectiveDisabledReason: meta.disabledReason,
  };
}

export function validateRoleOsCapabilitiesForStorage(
  osCapabilities: Array<{ id: string; targets?: string[] }> | undefined,
): RoleOsCapability[] | undefined {
  if (!osCapabilities?.length) return undefined;

  for (const entry of osCapabilities) {
    if (!isOsCapabilityId(entry.id)) {
      throw new Error(`Unknown OS capability: ${entry.id}`);
    }
  }

  const normalized = normalizeRoleOsCapabilities(osCapabilities as RoleOsCapability[]);
  if (!normalized?.length) return undefined;

  for (const entry of normalized) {
    const meta = getOsCapabilityMeta(entry.id);
    if (meta.status !== "runtime-enforced") {
      throw new Error(`OS capability '${meta.label}' is not editable in Role settings`);
    }

    if (meta.supportsTargets) {
      if (!entry.targets?.length) {
        throw new Error(`OS capability '${meta.label}' requires at least one target bundle id`);
      }
      for (const target of entry.targets) {
        if (!isValidAutomationTargetBundleId(target)) {
          throw new Error(`Invalid automation target bundle id: ${target}`);
        }
      }
    } else if (entry.targets?.length) {
      throw new Error(`OS capability '${meta.label}' does not accept targets`);
    }
  }

  return normalized;
}

export function normalizeRoleOsCapabilities(
  osCapabilities: RoleOsCapability[] | undefined,
): RoleOsCapability[] | undefined {
  if (!osCapabilities || osCapabilities.length === 0) return undefined;

  const seen = new Set<string>();
  const normalized: RoleOsCapability[] = [];

  for (const entry of osCapabilities) {
    if (!isOsCapabilityId(entry.id)) {
      throw new Error(`Unknown OS capability: ${entry.id}`);
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);

    const meta = getOsCapabilityMeta(entry.id);
    const next: RoleOsCapability = { id: entry.id };
    if (meta.supportsTargets && entry.targets?.length) {
      next.targets = [...new Set(entry.targets.map((t) => t.trim()).filter(Boolean))];
    }
    normalized.push(next);
  }

  return normalized.length > 0
    ? normalized.sort((a, b) => a.id.localeCompare(b.id))
    : undefined;
}

export function isValidAutomationTargetBundleId(target: string): boolean {
  return AUTOMATION_TARGET_BUNDLE_ID_RE.test(target);
}

export function getEditableOsCapabilityIds(
  platform: SandboxPlatform,
  sandboxAvailable = platform !== "none",
): OsCapabilityId[] {
  return getResolvedOsCapabilityRegistry(platform, sandboxAvailable)
    .filter((meta) => meta.editable)
    .map((meta) => meta.id);
}
