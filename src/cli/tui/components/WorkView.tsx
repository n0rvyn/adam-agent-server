import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { TaskList } from "./TaskList.js";
import { TemplateList } from "./TemplateList.js";
import { GoalDashboard } from "./GoalDashboard.js";

type WorkTab = "tasks" | "automations" | "goals";

const TABS: { key: string; id: WorkTab; label: string }[] = [
  { key: "1", id: "tasks", label: "Tasks" },
  { key: "2", id: "automations", label: "Automations" },
  { key: "3", id: "goals", label: "Goals" },
];

interface WorkViewProps {
  onBack: () => void;
}

export function WorkView({ onBack }: WorkViewProps) {
  const [activeTab, setActiveTab] = useState<WorkTab>("tasks");

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onBack();
      return;
    }
    if (input === "1") { setActiveTab("tasks"); return; }
    if (input === "2") { setActiveTab("automations"); return; }
    if (input === "3") { setActiveTab("goals"); return; }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Work Surface</Text>
      <Text dimColor>Browse tasks, automations, and goals without dropping back into chat mode.</Text>
      <Box gap={3} marginBottom={1} marginTop={1}>
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <Box key={tab.id}>
              <Text color={active ? "cyan" : "gray"} bold={active}>
                {active ? "●" : "○"} {tab.key}. {tab.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Tab content */}
      {activeTab === "tasks" && <TaskList onBack={onBack} />}
      {activeTab === "automations" && <TemplateList onBack={onBack} />}
      {activeTab === "goals" && <GoalDashboard onBack={onBack} />}
    </Box>
  );
}
