import { useEffect } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs.tsx";
import { Tasks } from "./Tasks.tsx";
import { Templates } from "./Templates.tsx";
import { Goals } from "./Goals.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { useAppStore } from "@/store/useAppStore.ts";
import { useShallow } from "zustand/react/shallow";

export function Work() {
  const { tasks, templates, goals } = useAppStore(
    useShallow((s) => ({
      tasks: s.tasks,
      templates: s.templates,
      goals: s.goals,
    })),
  );
  const fetchTasks = useAppStore((s) => s.fetchTasks);
  const fetchTemplates = useAppStore((s) => s.fetchTemplates);
  const fetchGoals = useAppStore((s) => s.fetchGoals);

  useEffect(() => {
    void fetchTasks();
    void fetchTemplates();
    void fetchGoals();
  }, [fetchTasks, fetchTemplates, fetchGoals]);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Operations"
        title="Work"
        description="Tasks, automations, and goals in one place."
        metrics={[
          { label: "Running", value: tasks.filter((task) => task.status === "running").length },
          { label: "Automations", value: templates.length },
          { label: "Goals", value: goals.length },
        ]}
        compact
      />
      <Tabs defaultValue="tasks">
        <TabsList>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="automations">Automations</TabsTrigger>
          <TabsTrigger value="goals">Goals</TabsTrigger>
        </TabsList>
        <TabsContent value="tasks">
          <Tasks />
        </TabsContent>
        <TabsContent value="automations">
          <Templates />
        </TabsContent>
        <TabsContent value="goals">
          <Goals />
        </TabsContent>
      </Tabs>
    </div>
  );
}
