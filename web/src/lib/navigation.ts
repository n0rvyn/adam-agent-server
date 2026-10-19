import {
  Archive,
  Brain,
  CircleDollarSign,
  GitBranch,
  LayoutDashboard,
  Lightbulb,
  ListTodo,
  MessageCircle,
  Package,
  Puzzle,
  Radio,
  Settings,
  Terminal,
  UserCircle,
  Target,
  Zap,
  Star,
  AlertTriangle,
} from "lucide-react";

export interface NavigationItem {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  description: string;
}

export interface RouteMeta {
  title: string;
  description: string;
  section: string;
}

export const navigationItems: NavigationItem[] = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard", description: "Live system overview and operational focus." },
  { to: "/chat", icon: MessageCircle, label: "Chat", description: "Start a session, monitor execution, and review responses." },
  { to: "/work", icon: ListTodo, label: "Work", description: "Tasks, automations, and goals in one work surface." },
  { to: "/roles", icon: UserCircle, label: "Roles", description: "Role definitions, prompts, permissions, and health." },
  { to: "/events", icon: Zap, label: "Events", description: "Event definitions that trigger automations." },
  { to: "/strategies", icon: Lightbulb, label: "Strategies", description: "Evaluate and adjust strategy records." },
  { to: "/channels", icon: Radio, label: "Channels", description: "Delivery targets, sessions, and routing rules." },
  { to: "/artifacts", icon: Archive, label: "Artifacts", description: "All files produced by tasks." },
  { to: "/goals", icon: Target, label: "Goals", description: "Long-running outcomes, budgets, and delivery targets." },
  { to: "/feature-requests", icon: Star, label: "Feature Requests", description: "Unmet needs extracted from chat sessions." },
  { to: "/mistakes", icon: AlertTriangle, label: "Mistakes", description: "Cross-role failure patterns extracted from audit data." },
  { to: "/memories", icon: Brain, label: "Memories", description: "Query memory records and retention patterns." },
  { to: "/evolution", icon: GitBranch, label: "Evolution", description: "Review learning history and rule updates." },
  { to: "/cost", icon: CircleDollarSign, label: "Cost", description: "Platform LLM spend by model, role, source, and date." },
  { to: "/plugins", icon: Puzzle, label: "Plugins", description: "Installed plugins, scope, and activation state." },
  { to: "/extensions", icon: Package, label: "Extensions", description: "MCP extension packages, manifests, and Role bindings." },
  { to: "/logs", icon: Terminal, label: "Logs", description: "Observe runtime events and system diagnostics." },
  { to: "/settings", icon: Settings, label: "Settings", description: "Server, model, and environment configuration." },
];

const detailRoutes: Array<{ test: (pathname: string) => boolean; meta: RouteMeta }> = [
  {
    test: (pathname) => /^\/tasks\/[^/]+$/.test(pathname),
    meta: {
      title: "Task Detail",
      description: "Summary, execution, results, and diagnostics for a single task.",
      section: "Work",
    },
  },
  {
    test: (pathname) => /^\/roles\/[^/]+$/.test(pathname),
    meta: {
      title: "Role Detail",
      description: "Role configuration, memory, scores, and activity history.",
      section: "Identities",
    },
  },
  {
    test: (pathname) => /^\/channels\/[^/]+$/.test(pathname),
    meta: {
      title: "Channel Detail",
      description: "Channel delivery rules, bindings, and recent activity.",
      section: "Delivery",
    },
  },
  {
    test: (pathname) => /^\/goals\/[^/]+$/.test(pathname),
    meta: {
      title: "Goal Detail",
      description: "Goal progress, budgets, and related orchestration state.",
      section: "Operations",
    },
  },
];

export function getRouteMeta(pathname: string): RouteMeta {
  const navMatch = navigationItems.find((item) => item.to === pathname);
  if (navMatch) {
    const sectionMap: Record<string, string> = {
      "/": "Overview",
      "/chat": "Sessions",
      "/work": "Operations",
      "/roles": "Identities",
      "/events": "Control Plane",
      "/strategies": "Decision Engine",
      "/channels": "Delivery",
      "/artifacts": "Delivery",
      "/goals": "Operations",
      "/feature-requests": "Intelligence",
      "/mistakes": "Intelligence",
      "/memories": "Knowledge",
      "/evolution": "Learning",
      "/cost": "Cost",
      "/plugins": "Capabilities",
      "/extensions": "Capabilities",
      "/logs": "Diagnostics",
      "/settings": "Configuration",
    };
    return {
      title: navMatch.label,
      description: navMatch.description,
      section: sectionMap[pathname] ?? "Control Plane",
    };
  }

  const detailMatch = detailRoutes.find((route) => route.test(pathname));
  if (detailMatch) return detailMatch.meta;

  return {
    title: "Adam",
    description: "Control plane for tasks, roles, channels, and delivery.",
    section: "Control Plane",
  };
}
