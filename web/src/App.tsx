import { Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { Layout } from "@/components/layout/Layout.tsx";
import { PlanApprovalDialog } from "@/components/plan/PlanApprovalDialog.tsx";
import { lazyWithRetry } from "@/lib/lazy-with-retry.ts";
import { getStoredApiKey } from "@/lib/api.ts";
import { Login } from "@/pages/Login.tsx";

const Dashboard = lazyWithRetry(() =>
  import("@/pages/Dashboard.tsx").then((m) => ({ default: m.Dashboard })),
);
const ChatPage = lazyWithRetry(() =>
  import("@/pages/Chat.tsx").then((m) => ({ default: m.Chat })),
);
const Work = lazyWithRetry(() =>
  import("@/pages/Work.tsx").then((m) => ({ default: m.Work })),
);
const TaskDetail = lazyWithRetry(() =>
  import("@/pages/TaskDetail.tsx").then((m) => ({ default: m.TaskDetail })),
);
const Plugins = lazyWithRetry(() =>
  import("@/pages/Plugins.tsx").then((m) => ({ default: m.Plugins })),
);
const Strategies = lazyWithRetry(() =>
  import("@/pages/Strategies.tsx").then((m) => ({ default: m.Strategies })),
);
const Goals = lazyWithRetry(() =>
  import("@/pages/Goals.tsx").then((m) => ({ default: m.Goals })),
);
const Logs = lazyWithRetry(() =>
  import("@/pages/Logs.tsx").then((m) => ({ default: m.Logs })),
);
const SettingsPage = lazyWithRetry(() =>
  import("@/pages/Settings.tsx").then((m) => ({ default: m.Settings })),
);
// Webhooks page removed (DP-010: merged into Templates page)
const MemoriesPage = lazyWithRetry(() =>
  import("@/pages/Memories.tsx").then((m) => ({ default: m.Memories })),
);
const EvolutionPage = lazyWithRetry(() =>
  import("@/pages/Evolution.tsx").then((m) => ({ default: m.Evolution })),
);
const ChannelsPage = lazyWithRetry(() =>
  import("@/pages/Channels.tsx").then((m) => ({ default: m.Channels })),
);
const GoalDetail = lazyWithRetry(() =>
  import("@/pages/GoalDetail.tsx").then((m) => ({ default: m.GoalDetail })),
);
const ChannelDetail = lazyWithRetry(() =>
  import("@/pages/ChannelDetail.tsx").then((m) => ({ default: m.ChannelDetail })),
);
const Roles = lazyWithRetry(() =>
  import("@/pages/Roles.tsx").then((m) => ({ default: m.Roles })),
);
const RoleDetail = lazyWithRetry(() =>
  import("@/pages/RoleDetail.tsx").then((m) => ({ default: m.RoleDetail })),
);
const FeatureRequestsPage = lazyWithRetry(() =>
  import("@/pages/FeatureRequests.tsx").then((m) => ({ default: m.FeatureRequests })),
);
const MistakesPage = lazyWithRetry(() =>
  import("@/pages/Mistakes.tsx").then((m) => ({ default: m.Mistakes })),
);
const NotFound = lazyWithRetry(() => import("@/pages/NotFound.tsx"));
const Events = lazyWithRetry(() =>
  import("@/pages/Events.tsx").then((m) => ({ default: m.Events })),
);
const EventDefDetail = lazyWithRetry(() =>
  import("@/pages/EventDefDetail.tsx").then((m) => ({ default: m.EventDefDetail })),
);
const Extensions = lazyWithRetry(() =>
  import("@/pages/Extensions.tsx").then((m) => ({ default: m.Extensions })),
);
const ExtensionDetail = lazyWithRetry(() =>
  import("@/pages/ExtensionDetail.tsx").then((m) => ({ default: m.ExtensionDetail })),
);
const ArtifactsPage = lazyWithRetry(() =>
  import("@/pages/Artifacts.tsx").then((m) => ({ default: m.Artifacts })),
);
const CostPage = lazyWithRetry(() =>
  import("@/pages/Cost.tsx").then((m) => ({ default: m.Cost })),
);

function LoadingSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
    </div>
  );
}

export function App() {
  const pathname = window.location.pathname;
  const apiKey = getStoredApiKey();

  // Login page is always reachable; all other routes require a stored key.
  if (pathname === "/ui/login") {
    return <Login />;
  }
  if (!apiKey) {
    return <Login />;
  }

  return (
    <Suspense fallback={<LoadingSpinner />}>
      <Routes>
        <Route path="login" element={<Login />} />
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="work" element={<Work />} />
          <Route path="tasks/:id" element={<TaskDetail />} />
          <Route path="plugins" element={<Plugins />} />
          <Route path="extensions" element={<Extensions />} />
          <Route path="extensions/:name" element={<ExtensionDetail />} />
          <Route path="roles" element={<Roles />} />
          <Route path="roles/:id" element={<RoleDetail />} />
          <Route path="feature-requests" element={<FeatureRequestsPage />} />
          <Route path="mistakes" element={<MistakesPage />} />
          <Route path="events" element={<Events />} />
          <Route path="events/:id" element={<EventDefDetail />} />
          <Route path="channels" element={<ChannelsPage />} />
          <Route path="channels/:id" element={<ChannelDetail />} />
          <Route path="artifacts" element={<ArtifactsPage />} />
          <Route path="strategies" element={<Strategies />} />
          <Route path="goals" element={<Goals />} />
          <Route path="goals/:id" element={<GoalDetail />} />
          <Route path="logs" element={<Logs />} />
          <Route path="settings" element={<SettingsPage />} />
          {/* Webhooks merged into Templates (DP-010) */}
          <Route path="memories" element={<MemoriesPage />} />
          <Route path="evolution" element={<EvolutionPage />} />
          <Route path="cost" element={<CostPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      <PlanApprovalDialog />
    </Suspense>
  );
}
