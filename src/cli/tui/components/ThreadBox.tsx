import { Box, Text } from "ink";
import React from "react";
import { roleColor, type RoleInkColor } from "../role-colors.js";

interface ThreadBoxProps {
  threadRoot: string;
  roleId?: string;
  /** Pre-derived role name from useRoleNames() at the render site. */
  roleName?: string;
  /** Pre-derived task short id (T-XXXXXXXX) from taskShortId() at the render site. */
  taskShortIdLabel?: string;
  /** Excerpt of originating user_message (<= 30 chars). */
  brief?: string;
  children: React.ReactNode;
}

export function ThreadBox({
  threadRoot,
  roleId,
  roleName,
  taskShortIdLabel,
  brief,
  children,
}: ThreadBoxProps) {
  const color: RoleInkColor = roleColor(roleId);
  const headerParts = [taskShortIdLabel, roleName, brief].filter(Boolean);
  const header = headerParts.length > 0 ? headerParts.join(" / ") : threadRoot.slice(0, 8);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
      <Box>
        <Text bold color={color}>
          [Thread {header}]
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}
